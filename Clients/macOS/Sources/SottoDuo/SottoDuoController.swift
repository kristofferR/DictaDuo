import AppKit
import Combine
import SottoDuoAPI
import SottoDuoCore
import ServiceManagement

private enum DictationDestination: Equatable {
    case test
    case field(InsertionTarget)
}

struct WisprFlowImportCounts {
    var processed = 0
    var total = 0
    var imported = 0
    var enriched = 0
    var skipped = 0
    var partial = 0
    var failed = 0
    var dictionaryArchived = false
    var warning: String?
    var unarchivedWarning: String?
}

enum WisprFlowImportState {
    case idle
    case preparing
    case preview(WisprFlowImportPreview, knownCount: Int?, destinationError: String?)
    case running(WisprFlowImportPreview, WisprFlowImportCounts)
    case finished(WisprFlowImportPreview, WisprFlowImportCounts, cancelled: Bool)
    case failed(String)
}

/// The snapshot worker is independent of the main actor. This gate lets quit
/// wait for it and close a reader that has not yet reached the controller.
private final class WisprFlowPreparationGate: @unchecked Sendable {
    private let lock = NSLock()
    private let work = DispatchGroup()
    private var cancelled = false
    private var reader: WisprFlowSourceReader?

    init() { work.enter() }
    func finish() { work.leave() }

    func register(_ value: WisprFlowSourceReader) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !cancelled else { return false }
        reader = value
        return true
    }

    func transfer(_ value: WisprFlowSourceReader) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !cancelled, reader === value else { return false }
        reader = nil
        return true
    }

    func cancel(waitForWorker: Bool = false) {
        lock.lock()
        cancelled = true
        let value = reader
        reader = nil
        lock.unlock()
        if waitForWorker {
            value?.close()
            work.wait()
        } else if let value {
            Task.detached(priority: .utility) { value.close() }
        }
    }
}

/// Local capture stays durable on this Mac until the server completes the session.
/// Live processing is independent of network availability; delivery happens once.
@MainActor
final class SottoDuoController: ObservableObject {
    @Published var activity: DictationActivity = .idle {
        // Settings edited while busy apply once the last take settles, including a cancelled or failed capture.
        didSet { if oldValue.isBusy, !activity.isBusy { applyConfiguration(configuration.configuration) } }
    }
    let recordingFeedback = RecordingFeedback()
    @Published var recordingListHint: String?
    @Published private(set) var recordingInputName: String?
    @Published var liveTranscript = ""
    @Published var lastTranscript = ""
    @Published var lastTranscriptionSeconds: Double?
    @Published var lastAudioSeconds: Double?
    @Published var lastDelivery = ""
    @Published private(set) var lastDeliveryStatus: DictationDeliveryStatus = .none
    @Published var errorMessage: String?
    @Published var permissions: PermissionSnapshot
    @Published var isHotkeyActive = false
    @Published private(set) var hasDetectedDJIMicrophone = UserDefaults.standard.bool(forKey: "hasDetectedDJIMicrophone")
    @Published var djiMicButtonEnabled = false {
        didSet {
            guard djiMicButtonEnabled != oldValue else { return }
            if !applyingConfiguration { configuration.update { $0.djiMicButtonEnabled = djiMicButtonEnabled } }
            refreshDJIMicButton()
        }
    }
    @Published private(set) var djiMicButtonStatus: DJIMicButtonStatus = .disabled
    @Published private(set) var isCheckingShortcut = false
    @Published private(set) var shortcutCheckText = ""
    @Published var shortcut: HoldKey = .rightOption {
        didSet {
            if shortcut != oldValue { stopShortcutCheck() }
            if !applyingConfiguration { configuration.update { $0.holdKey = shortcut.rawValue } }
            hotkey.key = shortcut
        }
    }
    @Published var activationMode: HotkeyActivationMode = .hold {
        didSet {
            guard activationMode != oldValue else { return }
            if !applyingConfiguration { configuration.update { $0.activationMode = activationMode.rawValue } }
            hotkey.mode = activationMode
        }
    }
    @Published var launchAtLogin = false {
        didSet {
            guard hasInitialized, !applyingConfiguration, !updatingLogin, launchAtLogin != oldValue else { return }
            configuration.update { $0.launchAtLogin = launchAtLogin }
            updateLoginItem()
        }
    }
    @Published private(set) var loginItemError: String?
    @Published var muteOutputWhileRecording = false {
        didSet {
            if !applyingConfiguration { configuration.update { $0.muteOutputWhileRecording = muteOutputWhileRecording } }
        }
    }
    @Published var statusMessage = "Connecting to server…"
    @Published private(set) var serverHealth: ServerHealth?
    @Published private(set) var serverStatusMessage = "Connecting…"
    @Published private(set) var isCheckingServer = false
    @Published private(set) var isSavingPreferences = false
    @Published private(set) var sharedPreferences: PreferencesSnapshot?
    @Published private(set) var generations: [GenerationRecord] = []
    @Published private(set) var isLoadingHistory = false
    @Published private(set) var hasMoreHistory = false
    @Published private(set) var historySourceFilter = "all"
    @Published private(set) var wisprFlowImportState: WisprFlowImportState = .idle
    /// Set while a cancelled take can still be pasted; the HUD counts down to it.
    @Published private(set) var undoDeadline: Date?
    private var historyPosition = HistoryPosition.newest
    private var recordingHistoryPosition = HistoryPosition.newest
    private var historyRevision = 0
    private var recordingHistoryIDs = Set<UUID>()
    private var recordingSnapshots: [UUID: RecordingSnapshot] = [:]
    private var selectedGenerationDetailID: UUID?
    @Published private(set) var generationDetails: [UUID: GenerationRecord] = [:]
    @Published private(set) var loadingGenerationDetails = Set<UUID>()
    @Published private(set) var pendingRecordingCount = 0
    @Published private(set) var pendingRecordings: [RecordingSnapshot] = []
    @Published private(set) var recoveryMessage: String?
    private var recoveryTasks: [UUID: Task<Void, Never>] = [:]
    private var pendingSpools: [UUID: RecordingSpool] = [:]
    private var recoveredSpoolIDs = Set<UUID>()
    /// Spools whose automatic transfer failed permanently. Health checks skip
    /// them until the user retries, finishes or resumes the recording.
    private var failedRecoveryIDs = Set<UUID>()
    /// Locally discarded spools whose server discard is in flight.
    private var discardingSpoolIDs = Set<UUID>()
    /// Uncertain admissions whose replay and discard is in flight.
    private var reconcilingAdmissionIDs = Set<UUID>()
    private var wisprFlowReader: WisprFlowSourceReader?
    private var wisprFlowPrepareTask: Task<Void, Never>?
    private var wisprFlowPrepareGate: WisprFlowPreparationGate?
    private var wisprFlowPrepareRevision = 0
    private var wisprFlowImportTask: Task<Void, Never>?
    private var wisprFlowMaterializationTask: Task<WisprFlowSourceSession, Error>?
    private var wisprFlowImportRevision = 0
    private var wisprFlowActiveReaders: [Int: WisprFlowSourceReader] = [:]
    private var wisprFlowDestinationEndpoint: String?
    let configuration: ConfigurationStore
    let microphones: MicrophonePreferencesStore
    let preferences: ClientPreferencesStore

    var isRecording: Bool { activity == .recording }
    var isTestRecording: Bool { isTestSession && isCapturing }
    var isCapturing: Bool { activity.isCapturing }
    var recordingUsesClipboard: Bool { isCapturing && insertionDestination == .clipboard }
    var isBusy: Bool { activity.isBusy || !pendingDictations.isEmpty }
    var isUndoPending: Bool { undoDeadline != nil }
    var hudExpanded: Bool { isCapturing || isUndoPending }
    static let undoWindow: TimeInterval = 4
    var canCancelWithEscape: Bool { !hotkey.isHoldingFn }
    var isServerReady: Bool { serverHealth?.ready == true && serverHealth?.apiVersion == SottoDuoAPI.version }
    var canTest: Bool { isServerReady && microphones.resolution.device != nil && !isCapturing }
    var selectedInputName: String { microphones.resolution.device.map(microphones.qualifiedName) ?? "No microphone available" }
    var usesRemoteInput: Bool { microphones.resolution.device?.remote != nil }
    var mayUseLocalMicrophone: Bool {
        guard let selected = microphones.resolution.device else { return false }
        if selected.remote == nil { return true }
        return microphones.localFallback != nil
    }
    var allPermissionsGranted: Bool { (usesRemoteInput || permissions.microphone) && permissions.accessibility }
    var onHUDVisibility: ((Bool) -> Void)?
    var onShowWindow: (() -> Void)?

    private let recorder: AudioRecorder
    private let audioDevices: AudioDeviceStore
    private let serverClientFactory: (() throws -> ServerClient)?
    private let recordingSocketFactory: RecordingSocketFactory
    private let hotkey = HotkeyMonitor()
    private let outputMuter = SystemOutputMuter()
    private let djiMicButton = DJIMicButtonMonitor()
    private var djiSuspensions: Set<String> = []
    private var remoteButtons: RemoteButtonDestination?
    private var buttonSelectionAtStart: UUID?
    private var remoteButtonSource: AudioSourceIdentity?
    @Published private(set) var remoteButtonState: ButtonDestinationState?
    private var recordingTrigger: DictationTrigger?
    private var subscriptions: Set<AnyCancellable> = []
    private var applyingConfiguration = false
    private var recordingTimer: Timer?
    private var recordingStart: TimeInterval = 0
    private var recordingBaseSeconds: TimeInterval = 0
    private var capturePowerActivity: NSObjectProtocol?
    private var microphoneStartTask: Task<Void, Never>?
    private var recorderStopTask: Task<CapturedAudio, Error>?
    private var deliveryTail: Task<Void, Never>?
    private var insertionRebases = ConfirmedInsertionRebases<InsertionTarget>()
    /// Released takes in recording order. The newest may own the HUD via sessionID.
    @Published private var pendingDictations: [PendingDictation] = []
    private var undoTake: PendingDictation?
    private var undoTask: Task<Void, Never>?
    private var undoOpenedAt: TimeInterval = 0
    /// The capturing local take's durable session; handed to its pending entry at release.
    private var activeSpool: RecordingSpool?
    private var recordingTask: Task<GenerationRecord, Error>?
    private var recordingTransport: RecordingClient?
    private var recordingContextTask: Task<Void, Never>?
    private var recordingConnected = false
    /// Lock, sleep and recovery keep a take archive-only even if processing finishes later.
    private var suppressDelivery = false
    private var isPreparingToQuit = false
    private var resumingRecordingID: UUID?
    private var remoteCapture: RemoteCaptureSession?
    private var sourceMonitorTask: Task<Void, Never>?
    private var activationTimeoutTask: Task<Void, Never>?
    private static let activationTimeoutSeconds: TimeInterval = 6
    private var refreshTask: Task<Void, Never>?
    private var monitorTask: Task<Void, Never>?
    private var hudTask: Task<Void, Never>?
    private var permissionTask: Task<Void, Never>?
    private var shortcutCheckTask: Task<Void, Never>?
    private var shortcutCheckStarted: TimeInterval = 0
    private var shortcutCheckEntries: [String] = []
    private var sessionID = UUID()
    /// The take whose result the HUD and last-result fields currently show.
    private var displayedResult: UUID?
    private var activeGenerationID: UUID?
    private var activeClient: ServerClient?
    /// A released take: its durable transfer or remote stop, server processing, and ordered delivery.
    @MainActor
    private final class PendingDictation {
        let session: UUID
        let id: UUID
        let client: ServerClient
        let spool: RecordingSpool?
        let recording: Task<GenerationRecord, Error>?
        let transport: RecordingClient?
        /// The released recorder stop; only an explicit discard cancels it.
        var stopped: Task<CapturedAudio, Error>?
        let capture: RemoteCaptureSession?
        let destination: InsertionDestinationCapture?
        let trigger: DictationTrigger?
        let buttonSelection: UUID?
        var task: Task<Void, Never>?
        var sealed = false
        /// A cancelled take waits here to learn whether it is pasted or only kept.
        let gate: TakeDeliveryGate
        /// The text transaction finished; only the delivery receipt remains, which Escape must not cancel.
        var inserted = false
        /// Nil until the destination resolves; list continuation keys off its anchor.
        var target: (destination: InsertionDestination, anchor: DictationDestination?)?
        /// The server may accept a seal whose response is interrupted.
        /// Archive-only takes (lock, sleep, interruption) never paste.
        var suppressDelivery = false
        var shouldCancelServer: Bool { capture?.shouldCancelServer ?? !sealed }

        init(session: UUID, id: UUID, client: ServerClient, spool: RecordingSpool?, recording: Task<GenerationRecord, Error>?,
             transport: RecordingClient?, capture: RemoteCaptureSession?, destination: InsertionDestinationCapture?,
             trigger: DictationTrigger?, buttonSelection: UUID?, cancelled: Bool) {
            gate = TakeDeliveryGate(pending: cancelled)
            self.session = session; self.id = id; self.client = client; self.spool = spool; self.recording = recording
            self.transport = transport; self.capture = capture; self.destination = destination
            self.trigger = trigger; self.buttonSelection = buttonSelection
        }

        /// Stops this client's work on the take. Durable audio is removed only by explicit discard.
        func cancel() {
            gate.decide(false)
            task?.cancel(); recording?.cancel(); destination?.cancel(); capture?.cancelMonitoring()
            if let transport { Task { await transport.cancel() } }
        }
    }
    @Published private var insertionDestination: InsertionDestination?
    private var destinationTask: InsertionDestinationCapture?
    private var recordingClipboardChangeCount = 0
    private struct ContinuationAnchor {
        let destination: DictationDestination
        let generationID: UUID
        let continuation: DictationContinuation
        let timestamp: TimeInterval
        /// The server accepts a continuation only after it records the delivery receipt.
        var confirmed = false
    }
    private var continuationAnchors: [ContinuationAnchor] = []
    private var isTestSession = false
    private var updatingLogin = false
    private var hasInitialized = false
    private var isShuttingDown = false
    private var observers: [NSObjectProtocol] = []
    private var workspaceObservers: [NSObjectProtocol] = []
    private var lockObserver: NSObjectProtocol?
    private var unlockObserver: NSObjectProtocol?

    init(configuration: ConfigurationStore, startServices: Bool = true, clientPreferences: ClientPreferencesStore? = nil,
         recorder: AudioRecorder? = nil, audioDevices: AudioDeviceStore? = nil,
         serverClient: (() throws -> ServerClient)? = nil,
         recordingSocket: @escaping RecordingSocketFactory = { URLSessionRecordingSocket(request: $0) }) {
        self.configuration = configuration
        self.recordingSocketFactory = recordingSocket
        self.recorder = recorder ?? AudioRecorder()
        self.audioDevices = audioDevices ?? AudioDeviceStore()
        self.serverClientFactory = serverClient
        preferences = clientPreferences ?? ClientPreferencesStore(root: configuration.url.deletingLastPathComponent())
        microphones = MicrophonePreferencesStore(configuration: configuration)
        permissions = startServices ? PermissionSnapshot.capture()
            : PermissionSnapshot(microphone: false, accessibility: false, inputMonitoring: false)
        applyConfiguration(configuration.configuration)
        hotkey.key = shortcut
        microphones.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &subscriptions)
        preferences.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &subscriptions)
        configuration.$configuration.removeDuplicates().sink { [weak self] in self?.applyConfiguration($0) }.store(in: &subscriptions)
        guard startServices else { return }
        bindServices()
        self.audioDevices.start()
        installLifecycleObservers()
        refreshPermissions()
        CapturedAudio.cleanupOrphans()
        recoverPendingRecordings()
        try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("SottoDuo-remote-preview"))
        hasInitialized = true
        refreshRemoteButtons()
        refreshDJIMicButton()
        updateLoginItem()
        refreshServer()
        sourceMonitorTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, !isShuttingDown else { return }
                try? await refreshAudioSources()
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
            }
        }
        monitorTask = Task { [weak self] in
            var count = 0
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
                guard let self, !isShuttingDown else { return }
                await checkServer(refreshData: count % 3 == 0 && !isBusy)
                count += 1
            }
        }
    }

    private func applyConfiguration(_ settings: SottoDuoConfiguration) {
        guard !isShuttingDown else { return }
        applyingConfiguration = true
        defer { applyingConfiguration = false }
        // This preference only affects the next take, so accept edits while busy.
        if muteOutputWhileRecording != settings.muteOutputWhileRecording { muteOutputWhileRecording = settings.muteOutputWhileRecording }
        guard !isBusy else { return }
        if let key = HoldKey(rawValue: settings.holdKey), shortcut != key { shortcut = key }
        if let mode = HotkeyActivationMode(rawValue: settings.activationMode), activationMode != mode { activationMode = mode }
        if launchAtLogin != settings.launchAtLogin { launchAtLogin = settings.launchAtLogin }
        if djiMicButtonEnabled != settings.djiMicButtonEnabled { djiMicButtonEnabled = settings.djiMicButtonEnabled }
    }

    private func client() throws -> ServerClient {
        try serverClientFactory?() ?? ServerClient(endpoint: preferences.endpoint, token: preferences.token)
    }

    private func refreshAudioSources() async throws {
        let connection = try client()
        let endpoint = preferences.endpoint
        let token = preferences.token
        do {
            let list = try await connection.audioSources()
            guard endpoint == preferences.endpoint, token == preferences.token, !Task.isCancelled else { return }
            microphones.updateRemote(list.sources, server: connection.endpoint.absoluteString,
                                     host: list.sharingHost, deviceID: preferences.deviceID)
        } catch {
            guard endpoint == preferences.endpoint, token == preferences.token, !Task.isCancelled else { throw error }
            microphones.clearRemote()
            throw error
        }
    }

    func refreshServer() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in await self?.checkServer(refreshData: true) }
    }

    private func checkServer(refreshData: Bool) async {
        guard !isCheckingServer, !isShuttingDown else { return }
        isCheckingServer = true
        let endpoint = preferences.endpoint
        defer { isCheckingServer = false }
        do {
            let connection = try client()
            let health = try await connection.health()
            guard endpoint == preferences.endpoint, !Task.isCancelled else { return }
            serverHealth = health
            serverStatusMessage = health.apiVersion != SottoDuoAPI.version
                ? (health.apiVersion > SottoDuoAPI.version ? "The server is newer than this app. Update SottoDuo on this Mac."
                    : "The server is older than this app. Update SottoDuo on the server.")
                : (health.ready ? "Server online" : (health.message ?? "Server models are not ready"))
            if !isBusy, activity == .idle { statusMessage = isServerReady ? "Ready when you are" : serverStatusMessage }
            if refreshData {
                do {
                    sharedPreferences = try await connection.preferences()
                    guard endpoint == preferences.endpoint, !Task.isCancelled else { return }
                    await updateHistory(connection: connection, append: false, preserveOlder: true)
                } catch {
                    guard endpoint == preferences.endpoint, !Task.isCancelled else { return }
                    // History/preferences failures do not invalidate a healthy capture.
                    errorMessage = error.localizedDescription
                }
            }
            if !isBusy { resumePendingTransfers() }
        } catch is CancellationError {
        } catch {
            guard endpoint == preferences.endpoint, !Task.isCancelled else { return }
            serverHealth = nil
            serverStatusMessage = Self.connectionMessage(error)
            // A durable local take keeps recording through a health blip. A
            // remote microphone lives on the server, so its own lease decides.
            if isCapturing { recordingFeedback.updateTransfer(connected: false) }
            else if !isBusy, activity == .idle { statusMessage = serverStatusMessage }
        }
    }

    /// Checks the address, token and API version before replacing a working connection.
    func saveConnection(endpoint: String, token: String, deviceName: String) {
        guard !isBusy, wisprFlowImportTask == nil else { return }
        guard serverClientFactory == nil, let probe = try? ServerClient(endpoint: endpoint, token: token) else {
            applyConnection(endpoint: endpoint, token: token, deviceName: deviceName)
            return
        }
        serverStatusMessage = "Checking connection…"
        Task { [weak self] in
            do {
                let health = try await probe.health()
                guard let self else { return }
                guard health.apiVersion == SottoDuoAPI.version else {
                    errorMessage = health.apiVersion > SottoDuoAPI.version
                        ? "The server is newer than this app. Update SottoDuo on this Mac."
                        : "The server is older than this app. Update SottoDuo on the server."
                    refreshServer()
                    return
                }
                applyConnection(endpoint: endpoint, token: token, deviceName: deviceName)
            } catch {
                guard let self else { return }
                if case ServerClientError.rejected(let status, _) = error, [401, 403].contains(status) {
                    errorMessage = "The server rejected this access token. Check it and try again."
                } else {
                    errorMessage = "Couldn't reach a SottoDuo server at that address. Check it and that the server is running."
                }
                refreshServer()
            }
        }
    }

    private func applyConnection(endpoint: String, token: String, deviceName: String) {
        guard preferences.save(endpoint: endpoint, token: token, deviceName: deviceName) else {
            errorMessage = preferences.errorMessage
            return
        }
        refreshRemoteButtons()
        continuationAnchors.removeAll()
        recoverPendingRecordings()
        microphones.clearRemote()
        serverHealth = nil
        sharedPreferences = nil
        generations = []
        historyPosition = .newest
        recordingHistoryPosition = .newest
        generationDetails = [:]
        selectedGenerationDetailID = nil
        recordingHistoryIDs = []
        recordingSnapshots = [:]
        historyRevision += 1
        isLoadingHistory = false
        hasMoreHistory = false
        serverStatusMessage = "Connecting…"
        refreshServer()
    }

    func refreshHistory() {
        Task { [weak self] in
            guard let self else { return }
            do { await updateHistory(connection: try client(), append: false) }
            catch { errorMessage = error.localizedDescription }
        }
    }

    func loadMoreHistory() {
        guard !isLoadingHistory, hasMoreHistory else { return }
        Task { [weak self] in
            guard let self else { return }
            do { await updateHistory(connection: try client(), append: true) }
            catch { errorMessage = error.localizedDescription }
        }
    }

    private func recordingHistoryPage(_ connection: ServerClient, before: String?, enabled: Bool) async throws -> RecordingPage {
        guard enabled else { return .init(items: []) }
        do { return try await connection.recordingHistory(before: before) }
        catch ServerClientError.rejected(let status, _) where status == 404 { return .init(items: []) }
    }

    private func legacyHistoryPage(_ connection: ServerClient, before: String?, source: String?, enabled: Bool) async throws -> GenerationPage {
        guard enabled else { return .init(items: []) }
        return try await connection.history(before: before, source: source)
    }

    /// Merges legacy generations and v2 recording sessions into one dated history.
    private func updateHistory(connection: ServerClient, append: Bool, preserveOlder: Bool = false) async {
        guard !isShuttingDown, !isLoadingHistory else { return }
        isLoadingHistory = true
        historyRevision += 1
        let revision = historyRevision
        let endpoint = preferences.endpoint
        let source = historySourceFilter
        let oldPosition = append ? historyPosition : .newest
        let newPosition = append ? recordingHistoryPosition : .newest
        defer { if historyRevision == revision { isLoadingHistory = false } }
        do {
            async let oldPage = legacyHistoryPage(connection, before: oldPosition.cursor,
                source: source == "all" ? nil : source, enabled: oldPosition != .end)
            async let newPage = recordingHistoryPage(connection, before: newPosition.cursor,
                enabled: source != "wispr-flow" && newPosition != .end)
            let (legacy, recordings) = try await (oldPage, newPage)
            guard endpoint == preferences.endpoint, source == historySourceFilter,
                  historyRevision == revision, !Task.isCancelled else { return }
            let merged = HistoryPagination.merge(
                legacy: legacy, from: oldPosition,
                sessions: .init(items: recordings.items.map(ServerClient.generationSummary), nextCursor: recordings.nextCursor),
                from: newPosition)
            let fetched = merged.items
            let fetchedIDs = Set(fetched.map(\.id))
            for snapshot in recordings.items { recordingSnapshots[snapshot.id] = snapshot }
            for item in fetched where generationDetails[item.id]?.status != item.status {
                generationDetails[item.id] = nil
            }
            let retainingLoadedPages = preserveOlder && generations.count > fetched.count
            if append || retainingLoadedPages {
                generations = fetched + generations.filter { !fetchedIDs.contains($0.id) }
                recordingHistoryIDs.formUnion(recordings.items.map(\.id))
            } else {
                generations = fetched
                recordingHistoryIDs = Set(recordings.items.map(\.id))
            }
            generations.sort(by: HistoryPagination.newer)
            if append || !retainingLoadedPages {
                historyPosition = merged.legacy
                recordingHistoryPosition = merged.sessions
            }
            hasMoreHistory = historyPosition != .end || recordingHistoryPosition != .end
        } catch is CancellationError {
        } catch let error as URLError where error.code == .cancelled {
            // A newer refresh superseded this one.
        } catch {
            guard !Task.isCancelled, historyRevision == revision else { return }
            errorMessage = error.localizedDescription
        }
    }

    func generationDetail(_ id: UUID) -> GenerationRecord? {
        generationDetails[id] ?? generations.first { $0.id == id }
    }

    func loadGenerationDetail(_ id: UUID) {
        // Selection changes also fence older responses when this detail is already cached.
        selectedGenerationDetailID = id
        guard recordingHistoryIDs.contains(id), generationDetails[id] == nil,
              !loadingGenerationDetails.contains(id) else { return }
        let endpoint = preferences.endpoint
        let source = historySourceFilter
        loadingGenerationDetails.insert(id)
        Task { [weak self] in
            guard let self else { return }
            defer { loadingGenerationDetails.remove(id) }
            do {
                let value = try await client().materializedRecording(id)
                guard selectedGenerationDetailID == id, endpoint == preferences.endpoint,
                      source == historySourceFilter, !Task.isCancelled else { return }
                // Keep only the selected full transcript: long sessions must not
                // accumulate in memory while browsing the compact history list.
                if value.status == .completed { generationDetails = [id: value] }
            } catch {
                guard selectedGenerationDetailID == id, endpoint == preferences.endpoint,
                      source == historySourceFilter, !Task.isCancelled else { return }
                errorMessage = error.localizedDescription
            }
        }
    }

    func retryPendingRecordings() {
        failedRecoveryIDs.removeAll()
        recoverPendingRecordings()
    }

    func setHistorySourceFilter(_ source: String) {
        guard ["all", "sottoduo", "wispr-flow"].contains(source), source != historySourceFilter else { return }
        historySourceFilter = source
        generations = []
        historyPosition = .newest
        recordingHistoryPosition = .newest
        generationDetails = [:]
        selectedGenerationDetailID = nil
        recordingHistoryIDs = []
        recordingSnapshots = [:]
        historyRevision += 1
        isLoadingHistory = false
        hasMoreHistory = false
        refreshHistory()
    }

    func prepareWisprFlowImport() {
        guard wisprFlowImportTask == nil else { return }
        wisprFlowPrepareRevision += 1
        let revision = wisprFlowPrepareRevision
        wisprFlowPrepareTask?.cancel()
        wisprFlowPrepareGate?.cancel()
        let gate = WisprFlowPreparationGate()
        wisprFlowPrepareGate = gate
        retireWisprFlowReader()
        wisprFlowImportState = .preparing
        wisprFlowDestinationEndpoint = preferences.endpoint
        // Schedule the worker before the main-actor continuation. Quit may
        // synchronously wait on the gate before that continuation starts.
        let snapshotTask = Task.detached(priority: .utility) {
            defer { gate.finish() }
            let reader = try WisprFlowSourceReader()
            guard gate.register(reader) else {
                reader.close()
                throw CancellationError()
            }
            return reader
        }
        wisprFlowPrepareTask = Task { [weak self] in
            guard let self else { gate.cancel(); return }
            defer {
                if revision == wisprFlowPrepareRevision { wisprFlowPrepareTask = nil }
            }
            do {
                let reader = try await snapshotTask.value
                var transferred = false
                defer {
                    if !transferred {
                        Task.detached(priority: .utility) { reader.close() }
                    }
                }
                try Task.checkCancellation()
                guard revision == wisprFlowPrepareRevision else { return }
                guard gate.transfer(reader) else { return }
                wisprFlowReader = reader
                transferred = true
                let knownCount: Int?
                let destinationError: String?
                do {
                    knownCount = try await client().knownWisprFlowSourceIDs(reader.sourceIDs).count
                    destinationError = nil
                } catch {
                    knownCount = nil
                    if let clientError = error as? ServerClientError,
                       case .rejected(let status, _) = clientError, status == 404 {
                        destinationError = "This server does not support Wispr Flow imports. Connect the new SottoDuo Dev server."
                    } else {
                        destinationError = "Cannot check the destination server: \(error.localizedDescription)"
                    }
                }
                try Task.checkCancellation()
                guard revision == wisprFlowPrepareRevision else { return }
                wisprFlowImportState = .preview(reader.preview, knownCount: knownCount,
                                               destinationError: destinationError)
            } catch is CancellationError {
            } catch {
                guard revision == wisprFlowPrepareRevision, !Task.isCancelled else { return }
                wisprFlowImportState = .failed(error.localizedDescription)
            }
        }
    }

    func startWisprFlowImport() {
        guard case .preview(let preview, _, let destinationError) = wisprFlowImportState,
              destinationError == nil,
              let reader = wisprFlowReader,
              wisprFlowImportTask == nil, !isBusy else { return }
        guard wisprFlowDestinationEndpoint == preferences.endpoint else {
            wisprFlowImportState = .failed("The server connection changed. Preview the import again.")
            return
        }
        let connection: ServerClient
        do { connection = try client() }
        catch { wisprFlowImportState = .failed(error.localizedDescription); return }
        let counts = WisprFlowImportCounts(total: reader.sourceIDs.count)
        wisprFlowImportRevision += 1
        let revision = wisprFlowImportRevision
        // The import task owns this reader until its detached work and artifact
        // cleanup finish. A new preview may start immediately after cancellation.
        wisprFlowActiveReaders[revision] = reader
        wisprFlowReader = nil
        wisprFlowImportState = .running(preview, counts)
        wisprFlowImportTask = Task { [weak self] in
            await self?.runWisprFlowImport(reader: reader, preview: preview, connection: connection,
                                           counts: counts, revision: revision)
        }
    }

    func cancelWisprFlowImport() {
        if case .running(let preview, let counts) = wisprFlowImportState {
            // Awaiting an unstructured reader task does not wake when its parent
            // is cancelled. Release the sheet now; the old task retains and
            // cleans its reader when materialization actually stops.
            wisprFlowImportRevision += 1
            wisprFlowMaterializationTask?.cancel()
            wisprFlowMaterializationTask = nil
            wisprFlowImportTask?.cancel()
            wisprFlowImportTask = nil
            wisprFlowDestinationEndpoint = nil
            wisprFlowImportState = .finished(preview, counts, cancelled: true)
        }
        wisprFlowPrepareTask?.cancel()
    }

    func closeWisprFlowImportSheet() {
        guard wisprFlowImportTask == nil else { return }
        wisprFlowPrepareRevision += 1
        wisprFlowPrepareTask?.cancel()
        wisprFlowPrepareGate?.cancel()
        retireWisprFlowReader()
        wisprFlowDestinationEndpoint = nil
        wisprFlowImportState = .idle
    }

    private func runWisprFlowImport(reader: WisprFlowSourceReader, preview: WisprFlowImportPreview,
                                    connection: ServerClient, counts initialCounts: WisprFlowImportCounts,
                                    revision: Int) async {
        var counts = initialCounts
        var cancelled = false
        var stoppedEarly = false
        var completionAttempted = false
        for sourceID in reader.sourceIDs {
            if Task.isCancelled { cancelled = true; break }
            var materializedSession: WisprFlowSourceSession?
            var activeTransferID: UUID?
            do {
                let session = try await materializeWisprFlowSession(reader: reader, sourceID: sourceID,
                                                                     revision: revision)
                materializedSession = session
                try Task.checkCancellation()
                let manifests = try await Task.detached(priority: .utility) {
                    try session.artifacts.map {
                        try ServerClient.wisprFlowArtifactManifest(filename: $0.filename, url: $0.url)
                    }
                }.value
                try Task.checkCancellation()
                let input = WisprFlowImportRequest(sourceID: session.sourceID, createdAt: session.createdAt,
                                                   sourceStatus: session.sourceStatus, finalText: session.displayText,
                                                   rawText: session.rawText, durationSeconds: session.durationSeconds,
                                                   variantNames: session.availableVariants, artifacts: manifests,
                                                   unarchivedArtifacts: session.unarchivedArtifacts.isEmpty
                                                       ? nil : session.unarchivedArtifacts)
                let transfer = try await connection.beginWisprFlowImport(input)
                activeTransferID = transfer.id
                for (artifact, manifest) in zip(session.artifacts, manifests) {
                    try Task.checkCancellation()
                    let receipt = try await connection.uploadWisprFlowArtifact(artifact.url, filename: artifact.filename,
                                                                               contentType: artifact.contentType, to: transfer.id)
                    guard receipt.filename == manifest.filename, receipt.byteCount == manifest.byteCount else {
                        throw ServerClientError.invalidResponse
                    }
                }
                try Task.checkCancellation()
                // A cancelled/lost response can hide a durable server commit.
                completionAttempted = true
                let result = try await connection.completeWisprFlowImport(transfer.id)
                activeTransferID = nil
                switch result.outcome {
                case .imported: counts.imported += 1
                case .enriched: counts.enriched += 1
                case .skipped: counts.skipped += 1
                case .partial:
                    counts.partial += 1
                    if counts.unarchivedWarning == nil {
                        // Exact sizes and hashes stay in each entry's source data, not the UI.
                        let names = session.unarchivedArtifacts.isEmpty
                            ? result.unarchivedArtifactNames.map(\.rawValue)
                            : session.unarchivedArtifacts.map(\.filename.rawValue)
                        let mediaWarning = names.isEmpty ? nil
                            : "Some recordings are missing files Wispr Flow did not keep (\(Set(names).sorted().joined(separator: ", "))). Each entry's Full source data lists them."
                        let warnings = [mediaWarning, session.provenanceWarning].compactMap { $0 }
                        if !warnings.isEmpty { counts.unarchivedWarning = warnings.joined(separator: "\n") }
                    }
                }
            } catch is CancellationError {
                cancelled = true
            } catch {
                if Task.isCancelled {
                    cancelled = true
                } else {
                    counts.failed += 1
                    if counts.warning == nil {
                        counts.warning = "Session \(sourceID.uuidString): \(error.localizedDescription)"
                    }
                    if error is URLError { stoppedEarly = true }
                    if let clientError = error as? ServerClientError,
                       case .rejected(let status, _) = clientError, [401, 403].contains(status) {
                        stoppedEarly = true
                    }
                }
            }
            if let activeTransferID {
                Task.detached(priority: .utility) {
                    try? await connection.cancelWisprFlowImport(activeTransferID)
                }
            }
            if let materializedSession {
                Task.detached(priority: .utility) {
                    reader.discardArtifacts(for: materializedSession)
                }
            }
            if Task.isCancelled { cancelled = true }
            if cancelled { break }
            counts.processed += 1
            if revision == wisprFlowImportRevision { wisprFlowImportState = .running(preview, counts) }
            if stoppedEarly { break }
        }
        if !cancelled, !stoppedEarly, preview.dictionaryCount > 0 {
            do {
                let dictionary = try await Task.detached(priority: .utility) {
                    try reader.dictionaryArtifactURL()
                }.value
                try Task.checkCancellation()
                guard let dictionary else { throw ServerClientError.invalidResponse }
                _ = try await connection.archiveWisprFlowDictionary(dictionary)
                counts.dictionaryArchived = true
            } catch is CancellationError {
                cancelled = true
            } catch {
                let dictionaryWarning = "Dictionary archive failed: \(error.localizedDescription)"
                counts.warning = [counts.warning, dictionaryWarning].compactMap { $0 }.joined(separator: "\n")
            }
        }
        cancelled = cancelled || Task.isCancelled
        await Task.detached(priority: .utility) { reader.close() }.value
        wisprFlowActiveReaders.removeValue(forKey: revision)
        if completionAttempted || counts.imported + counts.enriched + counts.skipped + counts.partial > 0 {
            if revision == wisprFlowImportRevision, historySourceFilter != "wispr-flow" {
                setHistorySourceFilter("wispr-flow")
            } else {
                // A cancelled run can still have committed on the server.
                // Refresh the user's current view without changing its filter.
                refreshHistory()
            }
        }
        guard revision == wisprFlowImportRevision else { return }
        wisprFlowImportTask = nil
        wisprFlowDestinationEndpoint = nil
        wisprFlowImportState = .finished(preview, counts, cancelled: cancelled)
    }

    private func materializeWisprFlowSession(reader: WisprFlowSourceReader, sourceID: UUID,
                                              revision: Int) async throws -> WisprFlowSourceSession {
        let task = Task.detached(priority: .utility) {
            try reader.session(for: sourceID)
        }
        if revision == wisprFlowImportRevision { wisprFlowMaterializationTask = task }
        defer {
            if revision == wisprFlowImportRevision { wisprFlowMaterializationTask = nil }
        }
        return try await task.value
    }

    private func retireWisprFlowReader() {
        guard let reader = wisprFlowReader else { return }
        wisprFlowReader = nil
        Task.detached(priority: .utility) { reader.close() }
    }

    func updateSharedPreferences(_ value: ServerPreferences, expectedRevision: Int? = nil) {
        guard !isSavingPreferences, let snapshot = sharedPreferences else { return }
        isSavingPreferences = true
        Task { [weak self] in
            guard let self else { return }
            defer { isSavingPreferences = false }
            do {
                let endpoint = preferences.endpoint
                let saved = try await client().updatePreferences(.init(revision: expectedRevision ?? snapshot.revision, preferences: value))
                guard endpoint == preferences.endpoint else { return }
                sharedPreferences = saved
                errorMessage = nil
            } catch { errorMessage = error.localizedDescription; refreshServer() }
        }
    }

    func deleteGeneration(_ id: UUID) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let connection = try client()
                if recordingHistoryIDs.contains(id) { try await connection.discardRecording(id) }
                else { try await connection.delete(id) }
                generationDetails[id] = nil
                recordingHistoryIDs.remove(id)
                generations.removeAll { $0.id == id }
                continuationAnchors.removeAll { $0.generationID == id }
            } catch { errorMessage = error.localizedDescription }
        }
    }

    func openGenerationAudio(_ generation: GenerationRecord, kind: AudioKind, runID: UUID? = nil) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let connection = try client()
                let audio: URL
                if recordingHistoryIDs.contains(generation.id) { audio = try await connection.recordingAudio(generation.id, kind: kind, runID: runID) }
                else { audio = try await connection.audio(generation.id, kind: kind) }
                NSWorkspace.shared.open(audio)
            }
            catch { errorMessage = error.localizedDescription }
        }
    }

    /// A long recording paused before it finished; only the computer that made it can resume it.
    func isPausedRecording(_ id: UUID) -> Bool {
        guard let snapshot = recordingSnapshots[id] else { return false }
        return snapshot.captureState == .interrupted && snapshot.processingState != .completed
            && snapshot.processingState != .failed
    }

    func recordingGapSeconds(_ id: UUID) -> TimeInterval {
        recordingSnapshots[id]?.runTimings?.reduce(0) { $0 + Double($1.gapBeforeMilliseconds ?? 0) / 1000 } ?? 0
    }

    func originalRecordingRuns(_ id: UUID) -> [RecordingStreamCheckpoint] {
        recordingSnapshots[id]?.streams.filter { $0.kind == .original && $0.frameCount > 0 } ?? []
    }

    func openWisprFlowArtifact(_ generation: GenerationRecord, filename: WisprFlowArtifactName) {
        guard generation.importedSource?.artifactNames.contains(filename) == true else { return }
        Task { [weak self] in
            guard let self else { return }
            do { NSWorkspace.shared.open(try await client().wisprFlowArtifact(generation.id, filename: filename)) }
            catch { errorMessage = error.localizedDescription }
        }
    }

    private static func connectionMessage(_ error: Error) -> String {
        if error is URLError { return "Server offline · Recording unavailable" }
        return error.localizedDescription
    }

    func toggleTestRecording() {
        guard !hotkey.isHoldingFn else { return }
        if isCapturing { finishDictation() }
        else { beginDictation(trigger: .test) }
    }

    /// A user cancel never throws away a take with usable audio: the server still
    /// transcribes it into history, and the HUD offers a short window to paste it
    /// after all. A second cancel closes that window early. Device-initiated
    /// cancels (`undoable: false`) discard the take as before.
    func cancelDictation(undoable: Bool = true) {
        guard isBusy else { return }
        if undoable, isUndoPending {
            // One Escape can reach both the key listener and a focused view;
            // only a later, separate cancel closes the window it just opened.
            if ProcessInfo.processInfo.systemUptime - undoOpenedAt > 0.3 { closeUndoWindow() }
            return
        }
        if undoable, activity == .recording, ProcessInfo.processInfo.systemUptime - recordingStart >= Self.minimumTake {
            finishDictation(cancelled: true)
            return
        }
        if isCapturing, resumingRecordingID != nil {
            // The spool holds the session's earlier runs; never discard them here.
            pauseResumedRecording("Resume cancelled. The saved recording is unchanged.")
        } else if isCapturing {
            let generation = activeGenerationID
            let connection = activeClient
            let shouldCancel = remoteCapture?.shouldCancelServer ?? true
            if let spool = activeSpool {
                // Explicit discard waits for the writer to close before tombstoning
                // files. Interruption and quit take a separate preservation path.
                recorder.stopAcceptingAudio()
                let stopped = recorder.stopCapture()
                recorderStopTask = stopped
                resetSession()
                Task { [weak self] in
                    _ = try? await stopped.value
                    try? spool.requestDiscard()
                    self?.finishDiscard(spool)
                }
            } else {
                resetSession()
                if shouldCancel, let generation, let connection { Task { await connection.discardRecordingRetrying(generation) } }
            }
            showCancelled()
        } else if activity.isBusy, let pending = pendingDictations.last(where: { $0.session == sessionID }) {
            // The text is already in the field; the take settles once its receipt returns.
            guard !pending.inserted else { return }
            // Already headed to history only; cancelling the server run would lose it.
            if undoable, pending.gate.state == .discard { return }
            if undoable, pending.gate.hold() { openUndoWindow(for: pending); return }
            cancelPending(pending)
        } else if let earlier = pendingDictations.last {
            // The HUD shows a settled result or error. Dismissing it must not
            // cancel older work that the HUD does not show.
            showEarlierDictation(earlier)
            return
        } else { showCancelled() }
        refreshServer()
    }

    /// Paste a cancelled take after all, as though it had ended normally.
    func undoCancellation() {
        guard let take = undoTake else { return }
        undoTask?.cancel(); undoTask = nil
        undoTake = nil
        undoDeadline = nil
        if take.session == sessionID { statusMessage = "Transcribing…" }
        take.gate.decide(true)
    }

    /// Close the undo window now, keeping the cancelled take in history only.
    func keepCancelledTake() {
        closeUndoWindow()
    }

    private func openUndoWindow(for take: PendingDictation) {
        hudTask?.cancel()
        undoTask?.cancel()
        undoTake = take
        undoOpenedAt = ProcessInfo.processInfo.systemUptime
        undoDeadline = Date().addingTimeInterval(Self.undoWindow)
        statusMessage = "Cancelled. Saving to history."
        onHUDVisibility?(true)
        undoTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(Self.undoWindow)) } catch { return }
            self?.closeUndoWindow()
        }
    }

    /// Drops the undo window when its take ends without reaching the gate.
    private func clearUndo(for take: PendingDictation?) {
        guard undoTake != nil, take == nil || undoTake === take else { return }
        undoTask?.cancel(); undoTask = nil
        undoTake = nil
        undoDeadline = nil
    }

    private func closeUndoWindow() {
        undoTask?.cancel(); undoTask = nil
        let take = undoTake
        undoTake = nil
        undoDeadline = nil
        guard let take else { return }
        if take.session == sessionID { statusMessage = "Saving to history…" }
        take.gate.decide(false)
    }

    /// Re-runs transcription on a failed or cancelled recording's saved audio.
    /// The result lands in history only; nothing is pasted.
    func retryGeneration(_ id: UUID) {
        // One retry per recording at a time; a second would be rejected and
        // leave an error over the first one's result.
        guard serverHealth?.generationRetry == true, retryingGenerationIDs.insert(id).inserted else { return }
        let isRecording = recordingHistoryIDs.contains(id)
        Task { [weak self] in
            guard let self else { return }
            defer { retryingGenerationIDs.remove(id) }
            do {
                let connection = try client()
                if isRecording {
                    // Resumes from the session's committed text. History keeps the
                    // compact summary; the selected detail reloads the full result.
                    replaceRecording(try await connection.retryRecording(id))
                    let settled = try await connection.recordingEvents(id) { [weak self] snapshot in
                        await self?.replaceRecording(snapshot)
                    }
                    generationDetails[id] = nil
                    if settled.processingState != .completed { errorMessage = settled.error ?? "Transcription failed again." }
                    else {
                        // The server now holds the result; a local copy left from the
                        // failed run is redundant, and discarding it would erase both.
                        if let spool = pendingSpools[id] {
                            recoveryTasks[id]?.cancel()
                            recoveryTasks[id] = nil
                            try? spool.discard()
                            pendingSpools[id] = nil
                            recoveredSpoolIDs.remove(id)
                            updatePendingRecordingSummary()
                        }
                        if selectedGenerationDetailID == id { loadGenerationDetail(id) }
                    }
                } else {
                    replaceGeneration(try await connection.retry(id))
                    let final = try await connection.events(id) { [weak self] record in
                        await self?.replaceGeneration(record)
                    }
                    replaceGeneration(final)
                    if final.status != .completed { errorMessage = final.error ?? "Transcription failed again." }
                }
            } catch { errorMessage = error.localizedDescription }
            refreshServer()
        }
    }

    @Published private(set) var retryingGenerationIDs = Set<UUID>()

    private func replaceRecording(_ snapshot: RecordingSnapshot) {
        recordingSnapshots[snapshot.id] = snapshot
        replaceGeneration(ServerClient.generationSummary(snapshot))
    }

    private func replaceGeneration(_ record: GenerationRecord) {
        guard let index = generations.firstIndex(where: { $0.id == record.id }) else { return }
        generations[index] = record
    }

    /// Cancelling the take the HUD shows hands the HUD to earlier work, if any.
    private func cancelPending(_ pending: PendingDictation) {
        let shown = !isCapturing && pending.session == sessionID
        pendingDictations.removeAll { $0 === pending }
        pending.cancel()
        let stopped = pending.stopped
        stopped?.cancel()
        if let spool = pending.spool {
            // Explicit discard: wait for this take's released writer, then remove both copies.
            Task { [weak self] in
                _ = try? await stopped?.value
                try? spool.requestDiscard()
                self?.finishDiscard(spool)
            }
        } else if pending.shouldCancelServer {
            // A remote stop in flight may already have sealed the audio on the server.
            Task { await pending.client.discardRecordingRetrying(pending.id) }
        }
        if shown { showCancelled() }
    }

    private func showCancelled() {
        liveTranscript = ""
        let remaining = pendingDictations.last?.session
        sessionID = remaining ?? UUID()
        displayedResult = nil
        activity = remaining == nil ? .idle : .transcribing
        statusMessage = remaining == nil ? "Cancelled" : "Cancelled · Earlier dictation is still processing"
        errorMessage = nil
        onHUDVisibility?(remaining != nil)
    }

    private func showEarlierDictation(_ pending: PendingDictation) {
        hudTask?.cancel()
        sessionID = pending.session
        displayedResult = nil
        activity = .transcribing
        errorMessage = nil
        statusMessage = "Earlier dictation is still processing"
        onHUDVisibility?(true)
    }

    private func resetSession() {
        hotkey.clearLatchedTake()
        liveTranscript = ""
        if let ticket = recordingTrigger?.buttonTicket { remoteButtons?.complete(ticket) }
        recordingTrigger = nil
        buttonSelectionAtStart = nil
        remoteButtonSource = nil
        sessionID = UUID()
        microphoneStartTask?.cancel(); microphoneStartTask = nil
        activationTimeoutTask?.cancel(); activationTimeoutTask = nil
        remoteCapture?.cancelMonitoring(); remoteCapture = nil
        resumingRecordingID = nil
        recordingTask?.cancel(); recordingTask = nil
        recordingContextTask?.cancel(); recordingContextTask = nil
        if let transport = recordingTransport { Task { await transport.cancel() } }
        recordingTransport = nil
        activeSpool = nil
        destinationTask?.cancel(); destinationTask = nil
        stopRecordingTimer()
        endCapturePowerActivity()
        recorder.cancel()
        outputMuter.restore()
        recorder.onChunk = nil
        insertionDestination = nil
        recordingListHint = nil
        recordingInputName = nil
        activeGenerationID = nil
        activeClient = nil
        recordingFeedback.reset()
    }

    /// A local take keeps any saved audio for Resume/Finish in history; an
    /// admitted session with no audio is discarded. Remote takes cancel on the server.
    private func failSession(_ message: String, cancelServer: Bool) {
        let generation = activeGenerationID
        let connection = activeClient
        guard let spool = activeSpool else {
            resetSession()
            showError(message)
            if cancelServer, let generation, let connection { Task { await connection.discardRecordingRetrying(generation) } }
            refreshHistory()
            return
        }
        recorder.stopAcceptingAudio()
        let stopped = recorder.stopCapture(pausing: true, interruption: message)
        recorderStopTask = stopped
        resetSession()
        showError(message)
        Task { [weak self] in
            _ = try? await stopped.value
            guard let self else { return }
            if spool.checkpoints.contains(where: { $0.kind == .inference && $0.frameCount > 0 }) {
                try? spool.pauseCapture(interrupted: message)
                if !spool.contextReady { try? spool.setContinuationID(nil) }
                recoverPendingRecordings()
            } else {
                // A refused microphone/open failure can leave an admitted server
                // session with zero audio. There is no prefix to recover in that case.
                try? spool.discard()
                if let generation, let connection { try? await connection.discardRecording(generation) }
            }
            refreshHistory()
        }
    }

    private var recordingRoot: URL {
        configuration.url.deletingLastPathComponent().appendingPathComponent("Recordings", isDirectory: true)
    }

    /// Reclaims sessions saved by a previous run, a failure or an interruption.
    /// Recovery only archives: it never restarts the microphone or pastes.
    private func recoverPendingRecordings() {
        guard !isShuttingDown else { return }
        reconcileAdmissions()
        let owned = Set(pendingSpools.keys).union(pendingDictations.compactMap { $0.spool?.snapshot.id })
            .union([activeSpool?.snapshot.id].compactMap { $0 }).union(discardingSpoolIDs)
        for spool in RecordingSpool.recover(in: recordingRoot, excluding: owned) {
            if spool.isDiscardRequested {
                finishDiscard(spool)
                continue
            }
            guard !spool.finalManifest.isEmpty else {
                // A process can close after admission but before hardware opens.
                try? spool.discard()
                if let connection = try? client(), connection.endpoint == spool.endpoint {
                    Task { await connection.discardRecordingRetrying(spool.snapshot.id) }
                }
                continue
            }
            pendingSpools[spool.snapshot.id] = spool
            recoveredSpoolIDs.insert(spool.snapshot.id)
        }
        updatePendingRecordingSummary()
        resumePendingTransfers()
    }

    /// A lost admission response may hide a server session that nothing would
    /// settle. The request is journaled so a replay, which admission answers
    /// idempotently, can find and discard it after any outage or relaunch.
    private struct UncertainAdmission: Codable {
        var request: CreateGenerationRequest
        var endpoint: URL
    }

    private var admissionRoot: URL {
        configuration.url.deletingLastPathComponent().appendingPathComponent("Admissions", isDirectory: true)
    }

    private func journalAdmission(_ request: CreateGenerationRequest, endpoint: URL) {
        let file = admissionRoot.appendingPathComponent("\(request.requestID.uuidString).json")
        try? FileManager.default.createDirectory(at: admissionRoot, withIntermediateDirectories: true)
        try? RecordingWire.encoder().encode(UncertainAdmission(request: request, endpoint: endpoint))
            .write(to: file, options: .atomic)
    }

    private func forgetAdmission(_ requestID: UUID) {
        try? FileManager.default.removeItem(at: admissionRoot.appendingPathComponent("\(requestID.uuidString).json"))
    }

    private func reconcileAdmissions() {
        guard let connection = try? client(),
              let files = try? FileManager.default.contentsOfDirectory(at: admissionRoot, includingPropertiesForKeys: nil)
        else { return }
        for file in files {
            guard let admission = try? RecordingWire.decoder().decode(UncertainAdmission.self, from: Data(contentsOf: file)) else {
                try? FileManager.default.removeItem(at: file); continue
            }
            let id = admission.request.requestID
            guard admission.endpoint == connection.endpoint, reconcilingAdmissionIDs.insert(id).inserted else { continue }
            Task { [weak self] in
                defer { self?.reconcilingAdmissionIDs.remove(id) }
                do {
                    let orphan = try await connection.createRecording(admission.request)
                    try await connection.discardRecording(orphan.id)
                } catch ServerClientError.rejected(404, _) {
                } catch { return }
                try? FileManager.default.removeItem(at: file)
            }
        }
    }

    private func resumePendingTransfers() {
        guard !isShuttingDown, let connection = try? client() else { return }
        for (id, spool) in pendingSpools {
            guard recoveryTasks[id] == nil, !failedRecoveryIDs.contains(id), spool.endpoint == connection.endpoint,
                  spool.deviceIdentity == preferences.deviceID else { continue }
            let transport = RecordingClient(client: connection, spool: spool, socketFactory: recordingSocketFactory)
            recoveryTasks[id] = Task { [weak self] in
                guard let self else { return }
                defer { recoveryTasks[id] = nil }
                do {
                    _ = try await transport.run()
                    guard !Task.isCancelled else { return }
                    // Launch/background recovery only archives. It must never
                    // use a stale destination or change the clipboard.
                    try spool.discard()
                    pendingSpools[id] = nil
                    recoveredSpoolIDs.remove(id)
                    updatePendingRecordingSummary()
                    recoveryMessage = "Recovered recording saved in history. Nothing was pasted."
                    refreshHistory()
                } catch is CancellationError {
                } catch {
                    // The transport retries transient failures itself.
                    failedRecoveryIDs.insert(id)
                    recoveryMessage = "Recording saved locally. " + error.localizedDescription
                }
            }
        }
        if pendingRecordingCount > 0 && recoveryMessage == nil {
            recoveryMessage = "\(pendingRecordingCount) recording\(pendingRecordingCount == 1 ? "" : "s") saved on this Mac \(pendingRecordingCount == 1 ? "is" : "are") waiting to upload"
        }
    }

    private func updatePendingRecordingSummary() {
        pendingRecordings = pendingSpools.values.map(\.snapshot).sorted { $0.createdAt > $1.createdAt }
        pendingRecordingCount = pendingRecordings.count
        if pendingRecordingCount == 0 { recoveryMessage = nil }
    }

    func discardPendingRecording(_ id: UUID) {
        guard let spool = pendingSpools[id] else { return }
        recoveryTasks[id]?.cancel()
        recoveryTasks[id] = nil
        do { try spool.requestDiscard() }
        catch { errorMessage = error.localizedDescription; return }
        pendingSpools[id] = nil
        recoveredSpoolIDs.remove(id)
        failedRecoveryIDs.remove(id)
        updatePendingRecordingSummary()
        finishDiscard(spool)
    }

    /// Deletes a tombstoned spool only once its server session is discarded.
    /// Otherwise recovery retries, so the server never keeps an orphaned take.
    private func finishDiscard(_ spool: RecordingSpool) {
        let id = spool.snapshot.id
        guard !discardingSpoolIDs.contains(id), let connection = try? client(),
              connection.endpoint == spool.endpoint else { return }
        discardingSpoolIDs.insert(id)
        Task { [weak self] in
            defer { self?.discardingSpoolIDs.remove(id) }
            do { try await connection.discardRecording(id) }
            catch ServerClientError.rejected(404, _) {}
            catch { return }
            try? spool.discard()
        }
    }

    /// The application waits for this before accepting Quit so the converter,
    /// PCM writer, and recovery manifest all finish while the process is alive.
    func prepareToQuit() async {
        isPreparingToQuit = true
        suppressDelivery = true
        recorder.stopAcceptingAudio()
        microphoneStartTask?.cancel()
        await recorder.preserve()
        // A released take's writer seals its spool before this process exits.
        _ = try? await recorderStopTask?.value
        // Send remote discards before exit; an expired lease would seal them into history.
        for discard in shutdown() { await discard.value }
    }

    func copyLastTranscript() {
        guard !lastTranscript.isEmpty, !isBusy else { return }
        switch DictationClipboard.copy(lastTranscript, to: .general) {
        case .success: lastDelivery = "Copied to clipboard"; lastDeliveryStatus = .copied
        case .failure(let error): lastDelivery = error.localizedDescription; lastDeliveryStatus = .failed
        }
    }

    func clearLastTranscript() {
        guard !isBusy else { return }
        continuationAnchors.removeAll()
        lastTranscript = ""; lastTranscriptionSeconds = nil; lastAudioSeconds = nil
        lastDelivery = ""; lastDeliveryStatus = .none; errorMessage = nil; activity = .idle
        recordingFeedback.reset()
    }

    func dismissFeedback() {
        guard !isBusy else { return }
        hudTask?.cancel()
        recordingFeedback.reset()
        onHUDVisibility?(false)
        if activity == .success { activity = .idle }
    }

    var pendingOutputRestore: Task<Void, Never>? { outputMuter.pendingRestore }

    @discardableResult
    func shutdown() -> [Task<Void, Never>] {
        guard !isShuttingDown else { return [] }
        isShuttingDown = true
        remoteButtons?.close(); remoteButtons = nil
        wisprFlowPrepareTask?.cancel(); wisprFlowImportTask?.cancel()
        wisprFlowMaterializationTask?.cancel()
        wisprFlowPrepareGate?.cancel(waitForWorker: true)
        wisprFlowPrepareGate = nil
        for reader in wisprFlowActiveReaders.values { reader.close() }
        wisprFlowActiveReaders.removeAll()
        wisprFlowReader?.close()
        wisprFlowReader = nil
        stopShortcutCheck()
        // Quit closes local capture durably; saved sessions finish on the next
        // launch without pasting. A remote take is cancelled unless sealed.
        let generation = activeGenerationID
        let connection = activeClient
        let shouldCancel = activeSpool == nil && (remoteCapture?.shouldCancelServer ?? true)
        resetSession()
        var discards: [Task<Void, Never>] = []
        if shouldCancel, let generation, let connection {
            discards.append(Task { try? await connection.discardRecording(generation, timeout: 3) })
        }
        discards += stopPendingDictations()
        for task in recoveryTasks.values { task.cancel() }
        recoveryTasks.removeAll()
        sourceMonitorTask?.cancel()
        monitorTask?.cancel(); refreshTask?.cancel(); hudTask?.cancel(); permissionTask?.cancel()
        configuration.stopWatching()
        subscriptions.removeAll()
        audioDevices.stop(); hotkey.stop(); djiMicButton.stop(); continuationAnchors.removeAll()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        for observer in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        if let lockObserver { DistributedNotificationCenter.default().removeObserver(lockObserver) }
        if let unlockObserver { DistributedNotificationCenter.default().removeObserver(unlockObserver) }
        try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("SottoDuo-remote-preview"))
        return discards
    }

    private func bindServices() {
        audioDevices.onChange = { [weak self] devices, defaultUID in
            guard let self else { return }
            microphones.update(devices: devices, systemDefaultUID: defaultUID)
            if !hasDetectedDJIMicrophone, devices.contains(where: {
                $0.name.localizedCaseInsensitiveContains("DJI")
                    || $0.name.caseInsensitiveCompare("Wireless Mic Rx") == .orderedSame
            }) {
                hasDetectedDJIMicrophone = true
                UserDefaults.standard.set(true, forKey: "hasDetectedDJIMicrophone")
            }
        }
        recorder.onLevel = { [weak self] level in guard let self, isCapturing else { return }; recordingFeedback.append(level) }
        recorder.onInterruption = { [weak self] message in
            guard let self, isCapturing else { return }
            if activeSpool != nil { preserveInterruptedRecording(message) }
            else { failSession(message, cancelServer: true) }
        }
        hotkey.onStatusChange = { [weak self] in self?.isHotkeyActive = $0 }
        djiMicButton.onStatusChange = { [weak self] in self?.djiMicButtonStatus = $0 }
        djiMicButton.onPress = { [weak self] in self?.receiveDJIMicButton($0) }
        djiMicButton.onDisconnect = { [weak self] id in
            guard let self, isCapturing, recordingTrigger == .dji(id) else { return }
            cancelDictation(undoable: false)
        }
        hotkey.onPress = { [weak self] in
            guard let self else { return false }
            if isCheckingShortcut {
                appendShortcutCheck("Shortcut recognized. Recording was intentionally skipped.")
                // No take started, so a double-tap monitor must not latch.
                return false
            }
            // The dictation key doubles as the undo shortcut; no new take, so no latch.
            if isUndoPending { undoCancellation(); return false }
            return beginDictation(trigger: .keyboard)
        }
        hotkey.onRelease = { [weak self] in
            guard let self else { return }
            if isCheckingShortcut { appendShortcutCheck("Hold released."); return }
            if recordingTrigger == .keyboard { finishDictation() }
        }
        hotkey.onCancel = { [weak self] in
            guard let self else { return }
            if isCheckingShortcut { appendShortcutCheck("Hold cancelled; microphone stayed off.") }
            else if isCapturing, recordingTrigger == .keyboard { cancelDictation() }
        }
        // An interrupted hold keeps its audio behind the undo window, like a cancel.
        hotkey.onInterruption = hotkey.onCancel
        hotkey.onEscape = { [weak self] in
            guard let self, !isCheckingShortcut else { return }
            if isBusy { cancelDictation() }
            else { dismissFeedback() }
        }
    }

    private func receiveDJIMicButton(_ deviceID: UInt64) {
        guard djiMicButtonEnabled, !isCheckingShortcut, !isShuttingDown, djiSuspensions.isEmpty else { return }
        switch DictationTrigger.djiButtonAction(deviceID: deviceID, activity: activity, current: recordingTrigger,
                                               hasPendingWork: !pendingDictations.isEmpty) {
        case .start: beginDictation(trigger: .dji(deviceID))
        case .finish: finishDictation()
        case .ignore: break
        }
    }

    /// Returns whether a take actually started. A double-tap monitor latches
    /// only on true, so a rejected start cannot leave a phantom recording.
    @discardableResult
    private func beginDictation(trigger: DictationTrigger) -> Bool {
        guard !isCapturing, !isShuttingDown, !isPreparingToQuit else { return false }
        let isTest = trigger == .test
        let buttonSource = trigger.buttonTicket == nil ? nil : remoteButtonSource
        stopShortcutCheck()
        guard isServerReady else { showError(serverStatusMessage); refreshServer(); onShowWindow?(); return false }
        // Starting a new take settles an open undo window: the cancelled take is kept.
        closeUndoWindow()
        hudTask?.cancel(); errorMessage = nil
        // Confirmed cursor moves matter only to takes that overlap them.
        if pendingDictations.isEmpty { insertionRebases.removeAll() }
        liveTranscript = ""
        sessionID = UUID()
        let current = sessionID
        isTestSession = isTest
        recordingTrigger = trigger
        buttonSelectionAtStart = trigger == .keyboard ? remoteButtons?.registrationID : nil
        suppressDelivery = false
        recordingConnected = false
        recordingBaseSeconds = 0
        recordingClipboardChangeCount = NSPasteboard.general.changeCount
        insertionDestination = nil
        recordingInputName = nil
        recordingFeedback.reset()
        activity = .starting
        statusMessage = "Connecting recording…"
        onHUDVisibility?(true)
        if muteOutputWhileRecording { outputMuter.mute() }
        if !isTest {
            let capture = TextInserter.beginDestinationCapture()
            destinationTask = capture
            Task { [weak self] in
                let destination = await capture.value
                guard let self, sessionID == current, isCapturing else { return }
                insertionDestination = destination
                prepareContinuation(for: destination.target.map(DictationDestination.field))
            }
        } else { prepareContinuation(for: .test) }
        let deadline = ProcessInfo.processInfo.systemUptime + Self.activationTimeoutSeconds
        activationTimeoutTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(Self.activationTimeoutSeconds)) } catch { return }
            guard let self, sessionID == current, activity == .starting else { return }
            failSession("The microphone did not start in time. Try another take.", cancelServer: true)
        }
        microphoneStartTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if sessionID == current {
                    microphoneStartTask = nil
                    activationTimeoutTask?.cancel(); activationTimeoutTask = nil
                }
            }
            do {
                // Discovery failure invalidates remote eligibility; local upload
                // admission still checks server availability independently.
                if buttonSource != nil {
                    let destination = await destinationTask?.value
                    guard sessionID == current, activity == .starting, !Task.isCancelled else { return }
                    guard destination?.target != nil else { throw ServerClientError.captureUnavailable("Focus an editable text field before starting a DJI button take.") }
                    insertionDestination = destination
                }
                if microphones.prefersRemoteInput && buttonSource == nil { try? await refreshAudioSources() }
                guard sessionID == current, activity == .starting, !Task.isCancelled else { return }
                let selectedInput: AudioInputDevice?
                if let buttonSource {
                    let connection = try client()
                    let sources = try await connection.audioSources().sources
                    guard let source = sources.first(where: { $0.identity == buttonSource && $0.isEligible() }) else {
                        throw ServerClientError.captureUnavailable("The DJI receiver is unavailable. Button takes do not use microphone fallback.")
                    }
                    selectedInput = AudioInputDevice(uid: source.identity.id, name: source.name, transport: .usb, remote: .init(server: connection.endpoint.absoluteString, hostID: source.identity.hostID))
                } else { selectedInput = microphones.resolution.device }
                guard let input = selectedInput else {
                    throw ServerClientError.captureUnavailable("No microphone is ready. Connect an input and try again.")
                }
                do {
                    try await startInput(input, session: current, requestID: current, isTest: isTest, deadline: deadline)
                } catch let error as ServerClientError {
                    // Only a definitive pre-ready rejection, or the server busy with
                    // another computer's take, permits one fresh admission.
                    let busy: Bool
                    switch error {
                    case .captureUnavailable: busy = false
                    case .captureBusy: busy = true
                    default: throw error
                    }
                    guard buttonSource == nil, input.remote != nil, sessionID == current, activity == .starting,
                          !Task.isCancelled, ProcessInfo.processInfo.systemUptime < deadline,
                          let fallback = microphones.localFallback else {
                        if busy {
                            // The server records one take at a time; name who holds it.
                            try? await refreshAudioSources()
                            let holder = microphones.busyFor(input)?.name ?? "another computer"
                            throw ServerClientError.captureUnavailable(
                                "\(microphones.hostName(input) ?? "The server") is busy with \(holder). Try again when it is free.")
                        }
                        throw error
                    }
                    try await startInput(fallback, session: current, requestID: UUID(), isTest: isTest, deadline: deadline)
                }
            } catch is CancellationError {
            } catch AudioRecordingError.cancelled {
            } catch {
                guard sessionID == current, !Task.isCancelled else { return }
                if error is URLError { serverHealth = nil; serverStatusMessage = Self.connectionMessage(error) }
                failSession(Self.connectionMessage(error), cancelServer: true)
                refreshServer()
            }
        }
        return true
    }

    private func startInput(_ input: AudioInputDevice, session current: UUID, requestID: UUID,
                            isTest: Bool, deadline: TimeInterval) async throws {
        try Task.checkCancellation()
        let inputName = microphones.qualifiedName(input)
        recordingInputName = inputName
        let base = try client()
        let device = DeviceIdentity(id: preferences.deviceID, name: preferences.deviceName)
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        guard remaining > 0 else { throw ServerClientError.captureUnavailable("The microphone did not start in time. Try another take.") }
        if let remote = input.remote {
            guard remote.server == base.endpoint.absoluteString else { throw ServerClientError.invalidResponse }
            let connection = try base.owningCapture()
            let source = AudioSourceIdentity(hostID: remote.hostID, id: input.uid)
            // The provider records one take at a time; an earlier take may still be draining.
            while pendingDictations.contains(where: { $0.capture.map { !$0.isSealed } ?? false }) {
                guard ProcessInfo.processInfo.systemUptime < deadline else {
                    throw ServerClientError.captureUnavailable("\(inputName) is still finishing your previous take. Try again.")
                }
                try await Task.sleep(for: .milliseconds(50))
                guard sessionID == current, activity == .starting else { return }
            }
            let available = deadline - ProcessInfo.processInfo.systemUptime
            guard available > 0 else { throw ServerClientError.captureUnavailable("The microphone did not start in time. Try another take.") }
            statusMessage = "Starting \(inputName)…"
            let created = try await connection.startCapture(.init(requestID: requestID, device: device,
                mode: isTest ? .test : .dictation, source: source, buttonTicket: recordingTrigger?.buttonTicket), timeout: available)
            guard sessionID == current, activity == .starting, !Task.isCancelled else {
                Task { await connection.discardRecordingRetrying(created.id) }; return
            }
            activeGenerationID = created.id; activeClient = connection
            guard created.capture?.source == source else { throw ServerClientError.invalidResponse }
            let capture = try RemoteCaptureSession(snapshot: created, connection: connection)
            remoteCapture = capture
            sharedPreferences = created.settings
            // Release the server's context hold as soon as the destination is known,
            // so speech is processed while the take records.
            let destinationCapture = destinationTask
            // The hold starts once the capture is ready; a context sent after it is ignored.
            let holdDeadline = ProcessInfo.processInfo.systemUptime + Self.remoteContextHold
            recordingContextTask = Task { [weak self] in
                let destination: InsertionDestination = isTest ? .clipboard : (await destinationCapture?.value ?? .clipboard)
                guard let self, !Task.isCancelled else { return }
                let continuationID = continuationID(for: destination, isTest: isTest) { $0.id == created.id }
                // Retry transient failures while the hold lasts; a rejection is final.
                while !Task.isCancelled {
                    let remaining = holdDeadline - ProcessInfo.processInfo.systemUptime
                    guard remaining > 0 else { return }
                    do { try await connection.setCaptureContext(created.id, continuationID: continuationID, timeout: remaining); return }
                    catch ServerClientError.rejected { return }
                    catch { try? await Task.sleep(for: .milliseconds(200)) }
                }
            }
            recordingStart = ProcessInfo.processInfo.systemUptime
            activity = .recording
            statusMessage = "Listening · \(inputName)"
            capture.monitor { [weak self] snapshot in
                guard let self, sessionID == current else { return }
                if isRecording {
                    if let peak = snapshot.capture?.peak { recordingFeedback.append(Float(peak)) }
                    if !snapshot.previewText.isEmpty { liveTranscript = snapshot.previewText }
                    if snapshot.recognition?.provider == .whisper {
                        statusMessage = snapshot.recognition?.fallbackReason == nil
                            ? "Listening · server recognition" : "Listening · server recognition (cloud unavailable)"
                    }
                } else { applyRecordingProgress(snapshot, session: current) }
            } onFailure: { [weak self] error in
                // After release the pending take's stop reports its own failure.
                guard let self, sessionID == current, isCapturing else { return }
                failSession(Self.connectionMessage(error), cancelServer: remoteCapture?.shouldCancelServer ?? true)
            }
        } else {
            guard permissions.microphone else {
                onShowWindow?()
                throw ServerClientError.captureUnavailable("Allow microphone access in macOS Settings to use the local input or microphone fallback.")
            }
            guard let deviceID = audioDevices.deviceID(for: input.uid) else {
                throw ServerClientError.captureUnavailable("The selected Mac microphone disconnected. Try another take.")
            }
            let connection = base
            // An older server must reject admission before the microphone starts.
            let capability: RecordingCapabilities
            do { capability = try await connection.recordingCapabilities() }
            catch ServerClientError.rejected(let status, _) where status == 404 {
                throw ServerClientError.rejected(404, "Update the server to support long recordings.")
            }
            guard capability.protocolName == RecordingWire.webSocketProtocol,
                  capability.maximumPCMBytes == RecordingWire.maximumPCMBytes else {
                throw ServerClientError.rejected(409, "This server does not support compatible long recordings. Update the server, then try again.")
            }
            let admission = CreateGenerationRequest(requestID: requestID, device: device, mode: isTest ? .test : .dictation)
            // Journaled before sending: the server may commit a session whose
            // response is lost to an outage or a crash. While in flight it is
            // this take's own admission, not an orphan to reconcile.
            journalAdmission(admission, endpoint: connection.endpoint)
            reconcilingAdmissionIDs.insert(requestID)
            let created: RecordingSnapshot
            do { created = try await connection.createRecording(admission) }
            catch {
                reconcilingAdmissionIDs.remove(requestID)
                if case ServerClientError.rejected(let status, _) = error, (400..<500).contains(status) {
                    forgetAdmission(requestID); throw error
                }
                Task { [weak self] in
                    for delay in [1, 5, 30] {
                        try? await Task.sleep(for: .seconds(delay))
                        self?.reconcileAdmissions()
                    }
                }
                throw error
            }
            reconcilingAdmissionIDs.remove(requestID)
            // Until the spool owns the session, the journal still settles it.
            guard sessionID == current, activity == .starting, !Task.isCancelled else {
                Task { await connection.discardRecordingRetrying(created.id) }; return
            }
            activeGenerationID = created.id; activeClient = connection
            let spool = try RecordingSpool(directory: recordingRoot.appendingPathComponent(created.id.uuidString),
                snapshot: created, endpoint: connection.endpoint, deviceIdentity: preferences.deviceID)
            forgetAdmission(requestID)
            // The server is reachable again, so settle any earlier uncertain admission.
            reconcileAdmissions()
            activeSpool = spool
            sharedPreferences = created.settings
            let destinationCapture = destinationTask
            // The uploader waits for this persisted decision, so it must outlive
            // the HUD session: a newer take must never strand an earlier upload.
            recordingContextTask = Task { [weak self] in
                let destination: InsertionDestination = isTest ? .clipboard : (await destinationCapture?.value ?? .clipboard)
                guard let self, !Task.isCancelled else { return }
                let continuationID = continuationID(for: destination, isTest: isTest) { $0.spool === spool }
                do { try spool.setContinuationID(continuationID) }
                catch { if activeSpool === spool { failSession(error.localizedDescription, cancelServer: false) } }
            }
            let transport = RecordingClient(client: connection, spool: spool, socketFactory: recordingSocketFactory)
            recordingTransport = transport
            recordingTask = Task { [weak self] in
                try await transport.run(onUpdate: { [weak self] snapshot in
                    await self?.applyRecordingProgress(snapshot, session: current)
                }, onConnectionChange: { [weak self] connected in
                    await self?.setRecordingConnection(connected, session: current)
                })
            }
            // A released take owns its teardown. Never let its asynchronous
            // stop consume the new microphone request.
            if let recorderStopTask { _ = try? await recorderStopTask.value }
            guard sessionID == current, activity == .starting, !Task.isCancelled else { return }
            recordingStart = ProcessInfo.processInfo.systemUptime
            statusMessage = "Starting microphone…"
            try await recorder.start(deviceID: deviceID, preserveOriginalAudio: created.settings.preferences.keepOriginalAudio,
                                     spool: spool)
            guard sessionID == current, activity == .starting, !Task.isCancelled else { return }
            capturePowerActivity = ProcessInfo.processInfo.beginActivity(
                options: [.idleSystemSleepDisabled], reason: "SottoDuo is recording dictation"
            )
            activity = .recording
            statusMessage = "Listening"
        }
        startRecordingTimer()
    }

    /// The server rejects shorter recordings, so they are discarded outright.
    private static let minimumTake: TimeInterval = 0.25
    /// Mirrors the server's context hold for remote captures.
    private static let remoteContextHold: TimeInterval = 3

    /// A cancelled take is processed exactly like a finished one, but only
    /// pasted if the user undoes the cancellation before its window closes.
    private func finishDictation(cancelled: Bool = false) {
        guard isCapturing, !isPreparingToQuit else { return }
        // A finished take must not leave a double-tap latch behind, matching
        // the failure and cancel paths.
        hotkey.clearLatchedTake()
        recorder.stopAcceptingAudio()
        if remoteCapture == nil { outputMuter.restore() }
        guard activity == .recording else {
            if resumingRecordingID != nil { pauseResumedRecording("Recording paused before the microphone became ready.") }
            else { cancelDictation() }
            return
        }
        let releasedAt = ProcessInfo.processInfo.systemUptime
        destinationTask?.finish()
        guard releasedAt - recordingStart >= Self.minimumTake || recordingBaseSeconds > 0 else { cancelDictation(); return }
        guard let id = activeGenerationID, let connection = activeClient,
              remoteCapture != nil || (activeSpool != nil && recordingTask != nil) else {
            failSession("This recording has no server session.", cancelServer: true); return
        }
        stopRecordingTimer(); endCapturePowerActivity(); resetLevels()
        activity = .transcribing
        statusMessage = remoteCapture == nil ? "Finishing dictation…" : "Stopping \(recordingInputName ?? "the shared mic")…"
        let current = sessionID
        let test = isTestSession
        let clipboardCount = recordingClipboardChangeCount
        let pending = PendingDictation(session: current, id: id, client: connection, spool: activeSpool,
                                       recording: recordingTask, transport: recordingTransport,
                                       capture: remoteCapture, destination: destinationTask, trigger: recordingTrigger,
                                       buttonSelection: buttonSelectionAtStart, cancelled: cancelled)
        pending.suppressDelivery = suppressDelivery
        if let spool = activeSpool { recoveredSpoolIDs.remove(spool.snapshot.id) }
        // Usually known at release, so a later take can continue a list in another field.
        let knownDestination: InsertionDestination? = test ? .clipboard : insertionDestination
        pending.target = knownDestination.map { Self.resolve($0, isTest: test, releasedAt: releasedAt) }
        pendingDictations.append(pending)
        if cancelled { openUndoWindow(for: pending) }
        // Hand this take to the pending entry so a new hold can start immediately.
        activeGenerationID = nil; activeClient = nil; remoteCapture = nil
        activeSpool = nil; recordingTask = nil; recordingTransport = nil; recordingContextTask = nil
        resumingRecordingID = nil; suppressDelivery = false; recordingBaseSeconds = 0
        destinationTask = nil; insertionDestination = nil; recordingListHint = nil; recordingInputName = nil
        recordingTrigger = nil; buttonSelectionAtStart = nil; remoteButtonSource = nil
        recorder.onChunk = nil
        let stopped = pending.capture == nil ? recorder.stopCapture() : nil
        pending.stopped = stopped
        if let stopped { recorderStopTask = stopped }
        let precedingDelivery = deliveryTail
        let insertionFinished = AsyncStream<Void>.makeStream()
        let task = Task { [weak self] in
            defer { insertionFinished.continuation.finish() }
            guard let self else { return }
            var recoverSaved = false
            defer {
                clearUndo(for: pending)
                pending.capture?.cancelMonitoring()
                if let ticket = pending.trigger?.buttonTicket { remoteButtons?.complete(ticket) }
                pendingDictations.removeAll { $0 === pending }
                // A remote take that ends before its seal callback still owes its mute,
                // unless a newer take is recording or still sealing.
                if pending.capture != nil, !isCapturing,
                   !pendingDictations.contains(where: { $0.capture.map { !$0.isSealed } ?? false }) {
                    outputMuter.restore()
                }
                if recoverSaved { recoverPendingRecordings() }
                if pendingDictations.isEmpty {
                    deliveryTail = nil
                    applyConfiguration(configuration.configuration)
                }
            }
            do {
                // stop() flushes the converter and seals the durable run. The spool
                // outlives this take until the server owns its assembled result.
                if let stopped { _ = try await stopped.value }
                try Task.checkCancellation()
                let target: (destination: InsertionDestination, anchor: DictationDestination?)
                if let known = pending.target { target = known }
                else {
                    target = Self.resolve(await pending.destination?.value ?? .clipboard, isTest: test, releasedAt: releasedAt)
                    pending.target = target
                }
                let resolved = target.destination, anchor = target.anchor
                // Queued takes must not both extend the last delivered list snapshot.
                // An earlier take that is unresolved or shares this anchor suppresses it.
                let sharesEarlierAnchor = pendingDictations.prefix { $0 !== pending }
                    .contains { earlier in earlier.target.map { $0.anchor == anchor } ?? true }
                let continuationID = sharesEarlierAnchor ? nil : anchor.flatMap { self.continuation(for: $0)?.generationID }
                try Task.checkCancellation()
                var result: GenerationRecord
                if let capture = pending.capture {
                    result = try await capture.stop(continuationID: continuationID) { [weak self] in
                        // A newer take may already be recording; it restores on its own release.
                        guard let self, !isCapturing else { return }
                        outputMuter.restore()
                    }
                } else {
                    guard let recording = pending.recording else { throw ServerClientError.invalidResponse }
                    pending.sealed = true // A sealed spool is finalized by the server, never cancelled.
                    result = try await recording.value
                }
                try Task.checkCancellation()
                guard result.status == .completed else {
                    throw ServerClientError.rejected(422, result.error ?? "The server could not process this recording.")
                }
                // Processing and uploads overlap. Clipboard/paste transactions
                // remain ordered and each keeps its original destination.
                await precedingDelivery?.value
                try Task.checkCancellation()
                // Decide only now, so a take still queued behind another can be cancelled with Undo.
                guard await pending.gate.consume() else {
                    // Cancelled and not undone: the transcript stays in history only.
                    // Nothing is inserted, so later takes need not wait for the receipt.
                    insertionFinished.continuation.finish()
                    try? pending.spool?.markDeliveryAttempted()
                    try? await recordDelivery(pending, receipt: DeliveryReceipt(status: "cancelled",
                        message: "Cancelled before pasting. Kept in history."))
                    try? pending.spool?.discard()
                    try Task.checkCancellation()
                    if sessionID == current {
                        lastDeliveryStatus = .kept
                        activity = .success
                        statusMessage = "Saved to history"
                        dismissHUDAfter(seconds: 1.2)
                    }
                    refreshServer()
                    return
                }
                await waitForCaptureRelease()
                try Task.checkCancellation()
                // Checkpoint before any delivery side effect. A crash or lost
                // receipt can never cause launch recovery to repeat a paste.
                try pending.spool?.markDeliveryAttempted()
                let receipt: DeliveryReceipt
                let showResult: @MainActor () -> Void
                if pending.suppressDelivery {
                    let message = "Saved in history. Nothing was pasted."
                    showResult = { [self] in
                        self.lastTranscript = result.finalText
                        self.lastAudioSeconds = result.audioSeconds
                        self.lastDelivery = message
                        self.lastDeliveryStatus = .saved
                        if self.sessionID == current { self.statusMessage = "Recording saved" }
                    }
                    showResult()
                    receipt = DeliveryReceipt(status: "none", message: message)
                } else {
                    let destination = rebasedDestination(resolved)
                    // Invalidate list state where this take lands, which a rebase may have moved.
                    let landing = destination == resolved ? anchor : destination.target.map(DictationDestination.field)
                    let delivery = await deliver(result, to: destination, anchor: landing, isTest: test,
                                                 clipboardCount: clipboardCount, session: current)
                    receipt = delivery.0
                    showResult = delivery.showResult
                }
                // Ordering covers the text transaction, not its non-fatal server receipt.
                pending.inserted = true
                insertionFinished.continuation.finish()
                try Task.checkCancellation()
                // Receipt failures never trigger a second insertion. They only
                // disable cross-take continuation until a confirmed receipt exists.
                do {
                    try await recordDelivery(pending, receipt: receipt)
                    if let index = continuationAnchors.firstIndex(where: { $0.generationID == id }) {
                        continuationAnchors[index].confirmed = true
                    }
                } catch { continuationAnchors.removeAll { $0.generationID == id } }
                // The assembled text and audio now belong to durable server
                // history; even an uncertain insertion is never retried.
                try? pending.spool?.discard()
                try Task.checkCancellation()
                // Other takes can change the shared last-delivery state during the receipt request.
                let delivered = DictationDeliveryStatus(rawValue: receipt.status) ?? .failed
                if pending.trigger == .keyboard, let registrationID = pending.buttonSelection, !result.insertionText.isEmpty,
                   !delivered.needsAttention {
                    let destination = remoteButtons
                    Task { try? await destination?.select(generationID: id, registrationID: registrationID) }
                }
                if sessionID == current {
                    // This result replaces any earlier take's warning shown meanwhile,
                    // and a later take's outcome if the HUD was handed back meanwhile.
                    errorMessage = nil
                    if displayedResult != current { showResult() }
                    activity = delivered == .failed ? .failed : .success
                    dismissHUDAfter(seconds: delivered.needsAttention ? 4 : 1.7)
                } else if delivered.needsAttention {
                    // A newer take owns the HUD and will replace this result.
                    errorMessage = "Earlier dictation: \(receipt.message ?? delivered.hudLabel)"
                }
                refreshServer()
            } catch {
                pending.recording?.cancel(); pending.destination?.cancel()
                if let transport = pending.transport { await transport.cancel() }
                if pending.spool == nil, pending.shouldCancelServer { Task { await connection.discardRecordingRetrying(id) } }
                if Task.isCancelled || error is CancellationError { return }
                if let recording = error as? AudioRecordingError, case .cancelled = recording { return }
                // Saved local audio is never lost to a failure: recovery finishes it archive-only.
                let savedLocally = pending.spool.map { spool in
                    spool.checkpoints.contains { $0.kind == .inference && $0.frameCount > 0 }
                } ?? false
                recoverSaved = savedLocally
                let failure = (savedLocally ? "Recording saved locally. " : "") + Self.connectionMessage(error)
                if sessionID == current {
                    liveTranscript = ""
                    if error is URLError { serverHealth = nil; serverStatusMessage = Self.connectionMessage(error) }
                    showError(failure)
                } else {
                    let message = "Earlier dictation failed: \(failure)"
                    errorMessage = message
                    lastDelivery = message
                    lastDeliveryStatus = .failed
                    displayedResult = nil
                    // An older job may fail while the microphone or a newer
                    // result owns the HUD. Keep that live activity intact.
                    if !activity.isBusy { showError(message) }
                }
                refreshHistory()
            }
        }
        pending.task = task
        // Even a failed/cancelled middle take must preserve the ordering link
        // to earlier deliveries for every later take.
        deliveryTail = Task {
            await precedingDelivery?.value
            for await _ in insertionFinished.stream {}
        }
    }

    private func recordDelivery(_ pending: PendingDictation, receipt: DeliveryReceipt) async throws {
        try await pending.client.recordingDelivery(pending.id, receipt: receipt)
    }

    /// The continuation a take recorded into `destination` may extend.
    /// Queued takes must not both extend the last delivered list snapshot:
    /// an earlier take that is unresolved or shares this anchor suppresses it.
    private func continuationID(for destination: InsertionDestination, isTest: Bool,
                                isTake: (PendingDictation) -> Bool) -> UUID? {
        let anchor: DictationDestination? = isTest ? .test
            : destination.target.flatMap { $0.selection == nil ? nil : .field($0) }
        let sharesEarlierAnchor = pendingDictations.prefix { !isTake($0) }
            .contains { earlier in earlier.target.map { $0.anchor == anchor } ?? true }
        return sharesEarlierAnchor ? nil : anchor.flatMap { continuation(for: $0)?.generationID }
    }

    private static func resolve(_ destination: InsertionDestination, isTest: Bool,
                                releasedAt: TimeInterval) -> (destination: InsertionDestination, anchor: DictationDestination?) {
        var resolved = destination
        if let target = destination.target, !InsertionCapturePolicy.permitsInsertion(capturedAt: target.capturedAt, releasedAt: releasedAt) {
            resolved = .clipboard
        }
        return (resolved, isTest ? .test : resolved.target.flatMap { $0.selection == nil ? nil : .field($0) })
    }

    private func setRecordingConnection(_ connected: Bool, session: UUID) {
        guard sessionID == session, isBusy else { return }
        recordingConnected = connected
        if isCapturing { recordingFeedback.updateTransfer(connected: connected) }
    }

    private func applyRecordingProgress(_ snapshot: RecordingSnapshot, session: UUID) {
        guard sessionID == session, isBusy else { return }
        if isCapturing {
            let capturedFrames = Int64(min(recordingFeedback.elapsedSeconds, Int(Int64.max / 16_000))) * 16_000
            recordingFeedback.updateTransfer(connected: recordingConnected,
                catchingUp: capturedFrames - snapshot.uploadedFrames > 5 * 16_000)
            if !snapshot.previewText.isEmpty { liveTranscript = snapshot.previewText }
            if let recognition = snapshot.recognition, recognition.provider == .whisper {
                statusMessage = recognition.fallbackReason == nil ? "Listening · server recognition" : "Listening · server recognition (cloud unavailable)"
            } else { statusMessage = "Listening" }
        } else {
            switch snapshot.processingState {
            case .queued: statusMessage = "Waiting for server…"
            case .processing: statusMessage = "Finishing dictation…"
            case .completed: statusMessage = "Preparing result…"
            case .failed: statusMessage = snapshot.error ?? "Processing stopped · Audio saved"
            }
        }
    }

    /// Ending a resumed take early pauses its session again with the earlier runs intact.
    private func pauseResumedRecording(_ message: String) {
        if activeSpool != nil { preserveInterruptedRecording(message) }
        else {
            resetSession()
            activity = .idle
            statusMessage = "Recording remains paused"
            recoverPendingRecordings()
        }
    }

    /// Interruption pauses the session durably; history offers Resume, Finish and Discard.
    private func preserveInterruptedRecording(_ message: String) {
        guard isCapturing, !isPreparingToQuit, let spool = activeSpool else { return }
        recorder.stopAcceptingAudio()
        destinationTask?.finish()
        suppressDelivery = true
        stopRecordingTimer(); endCapturePowerActivity(); resetLevels()
        activity = .transcribing
        statusMessage = "Saving interrupted recording…"
        let current = sessionID
        let id = spool.snapshot.id
        let contextTask = recordingContextTask
        let stopped = recorder.stopCapture(pausing: true, interruption: message)
        recorderStopTask = stopped
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try? await stopped.value
                try spool.pauseCapture(interrupted: message)
                await contextTask?.value
                guard sessionID == current, !Task.isCancelled else { return }
                if !spool.contextReady { try spool.setContinuationID(nil) }
                pendingSpools[id] = spool
                resetSession()
                activity = .success
                lastDeliveryStatus = .saved
                lastDelivery = "Recording paused. Resume or finish it in history."
                statusMessage = "Recording paused"
                recoveryMessage = message
                updatePendingRecordingSummary()
                recoverPendingRecordings()
                dismissHUDAfter(seconds: 3)
            } catch is CancellationError {
            } catch {
                guard sessionID == current, !Task.isCancelled else { return }
                failSession("Recording saved locally. " + error.localizedDescription, cancelServer: false)
            }
        }
    }

    func pendingRecordingAudioSeconds(_ id: UUID) -> TimeInterval {
        pendingSpools[id]?.checkpoints.filter { $0.kind == .inference }
            .reduce(0) { $0 + Double($1.frameCount) / 16_000 } ?? 0
    }

    func pendingRecordingIsPaused(_ id: UUID) -> Bool { pendingSpools[id]?.isPaused == true }

    func canResumePendingRecording(_ id: UUID) -> Bool {
        !isCapturing && !isPreparingToQuit && isServerReady && pendingSpools[id]?.isPaused == true
            && pendingSpools[id]?.isSealed == false
    }

    func canFinishPendingRecording(_ id: UUID) -> Bool {
        !isPreparingToQuit && pendingSpools[id]?.isSealed == false
    }

    func finishPendingRecording(_ id: UUID) {
        guard canFinishPendingRecording(id), let spool = pendingSpools[id] else { return }
        do {
            try spool.seal(interrupted: spool.interruption)
            failedRecoveryIDs.remove(id)
            updatePendingRecordingSummary()
            recoveryMessage = "Finishing saved recording. Nothing will be pasted."
            // A settled paused socket may be awaiting its next server message.
            // Reconnect from durable checkpoints to send the stop immediately.
            let recovery = recoveryTasks[id]
            recovery?.cancel()
            Task { [weak self] in
                await recovery?.value
                guard let self, !isShuttingDown else { return }
                recoveryTasks[id] = nil
                resumePendingTransfers()
            }
        } catch { errorMessage = error.localizedDescription }
    }

    /// Continues a paused session with a new capture run. Delivery stays
    /// suppressed for sessions recovered from an earlier launch.
    func resumePendingRecording(_ id: UUID) {
        guard canResumePendingRecording(id), let spool = pendingSpools[id] else { return }
        guard permissions.microphone, let input = microphones.resolution.device, input.remote == nil,
              let deviceID = audioDevices.deviceID(for: input.uid) else {
            showError("Connect an available Mac microphone and allow access before resuming.")
            return
        }
        let connection: ServerClient
        do { connection = try client() }
        catch { showError(error.localizedDescription); return }
        guard connection.endpoint == spool.endpoint, spool.deviceIdentity == preferences.deviceID else {
            showError("Connect to this recording’s original server before resuming.")
            return
        }
        let recovered = recoveredSpoolIDs.contains(id)
        closeUndoWindow()
        resumingRecordingID = id
        recordingBaseSeconds = spool.checkpoints.filter { $0.kind == .inference }
            .reduce(0) { $0 + Double($1.frameCount) / 16_000 }
        stopShortcutCheck()
        hudTask?.cancel()
        sessionID = UUID()
        let current = sessionID
        activity = .starting
        statusMessage = "Resuming saved recording…"
        errorMessage = nil
        recordingTrigger = .toggle
        isTestSession = spool.snapshot.mode == .test
        suppressDelivery = recovered
        recordingConnected = false
        recordingClipboardChangeCount = NSPasteboard.general.changeCount
        insertionDestination = nil
        recordingInputName = microphones.qualifiedName(input)
        recordingFeedback.reset()
        onHUDVisibility?(true)
        if muteOutputWhileRecording { outputMuter.mute() }
        let destinationCapture = isTestSession ? nil : TextInserter.beginDestinationCapture()
        destinationTask = destinationCapture
        if let destinationCapture {
            Task { [weak self] in
                let destination = await destinationCapture.value
                guard let self, sessionID == current, isCapturing else { return }
                insertionDestination = destination
            }
        }
        microphoneStartTask = Task { [weak self] in
            guard let self else { return }
            defer { if sessionID == current { microphoneStartTask = nil } }
            do {
                let health = try await connection.health()
                let capability = try await connection.recordingCapabilities()
                guard health.ready, health.apiVersion == SottoDuoAPI.version,
                      capability.protocolName == RecordingWire.webSocketProtocol,
                      capability.maximumPCMBytes == RecordingWire.maximumPCMBytes else {
                    throw ServerClientError.rejected(503, "The original server must be ready before resuming.")
                }
                let snapshot = try await connection.recording(id)
                guard snapshot.captureState != .discarded, snapshot.stopRuns == nil,
                      snapshot.processingState != .completed else {
                    throw ServerClientError.rejected(409, "This recording is already finalized. Start a new dictation.")
                }
                guard sessionID == current, !Task.isCancelled else { return }
                // Close the prior synchronization socket before admitting a new
                // run. Server epochs fence any delayed work from that socket.
                let recovery = recoveryTasks[id]
                recovery?.cancel()
                await recovery?.value
                guard sessionID == current, !Task.isCancelled else { return }
                recoveryTasks[id] = nil
                failedRecoveryIDs.remove(id)
                try spool.markSnapshot(snapshot)
                try spool.prepareToResume()
                activeSpool = spool
                activeGenerationID = id
                activeClient = connection
                sharedPreferences = snapshot.settings
                pendingSpools[id] = nil
                updatePendingRecordingSummary()
                recordingFeedback.updateElapsed(recordingBaseSeconds)
                let transport = RecordingClient(client: connection, spool: spool, socketFactory: recordingSocketFactory)
                recordingTransport = transport
                recordingTask = Task { [weak self] in
                    try await transport.run(onUpdate: { [weak self] progress in
                        await self?.applyRecordingProgress(progress, session: current)
                    }, onConnectionChange: { [weak self] connected in
                        await self?.setRecordingConnection(connected, session: current)
                    })
                }
                if let recorderStopTask { _ = try? await recorderStopTask.value }
                guard sessionID == current, !Task.isCancelled else { return }
                recordingStart = ProcessInfo.processInfo.systemUptime
                try await recorder.start(deviceID: deviceID,
                    preserveOriginalAudio: snapshot.settings.preferences.keepOriginalAudio, spool: spool)
                guard sessionID == current, !Task.isCancelled else { return }
                capturePowerActivity = ProcessInfo.processInfo.beginActivity(
                    options: [.idleSystemSleepDisabled], reason: "SottoDuo is recording dictation"
                )
                activity = .recording
                statusMessage = "Listening"
                startRecordingTimer()
            } catch is CancellationError {
            } catch {
                guard sessionID == current, !Task.isCancelled else { return }
                // Resume failure never destroys the earlier run or silently
                // finalizes it; the same prefix remains available in history.
                if activeSpool == nil {
                    resetSession()
                    showError(error.localizedDescription)
                    recoverPendingRecordings()
                } else { preserveInterruptedRecording(error.localizedDescription) }
            }
        }
    }

    /// Starts or ends a hands-free take from the app's own button.
    func toggleDictation() {
        guard !hotkey.isHoldingFn else { return }
        if isCapturing { finishDictation() }
        else { beginDictation(trigger: .toggle) }
    }

    func stopDictation() { finishDictation() }

    private func deliver(_ record: GenerationRecord, to destination: InsertionDestination,
                         anchor: DictationDestination?, isTest: Bool, clipboardCount: Int,
                         session: UUID) async -> (DeliveryReceipt, showResult: @MainActor () -> Void) {
        if sessionID == session { liveTranscript = "" }
        var transcript = record.previewText.isEmpty ? record.finalText : record.previewText
        let message: String
        let deliveryStatus: DictationDeliveryStatus
        let status: String
        if isTest {
            rememberContinuation(record, at: .test)
            message = "Test complete. Nothing was pasted."
            deliveryStatus = .tested
            status = record.finalText.isEmpty ? "No speech detected" : "Ready to copy"
        } else if record.insertionText.isEmpty {
            if record.continuation == nil && record.previewText.isEmpty {
                message = "No speech detected"; deliveryStatus = .none
            } else if let confirmed = TextInserter.unchangedAnchor(destination.target) {
                rememberContinuation(record, at: .field(confirmed))
                message = "List updated. Nothing was pasted."; deliveryStatus = .listUpdated
            } else {
                message = "List state unchanged: the original cursor could not be confirmed."
                deliveryStatus = .unconfirmed
            }
            status = message
        } else {
            if sessionID == session { activity = .delivering; statusMessage = "Inserting at your cursor…" }
            let inserter = TextInserter()
            let outcome = await inserter.deliver(record.insertionText, copying: record.finalText,
                                                  to: destination, clipboardUnchangedSince: clipboardCount,
                                                  waitUntilReady: { await self.waitForCaptureRelease() },
                                                  isCaptureActive: { self.isHoldingCapture })
            guard !Task.isCancelled else { return (DeliveryReceipt(status: "failed", message: "Delivery cancelled"), {}) }
            if let anchor { continuationAnchors.removeAll { $0.destination == anchor } }
            switch outcome {
            case .inserted:
                if let target = inserter.confirmedAnchor {
                    // A newer hold may capture the old cursor while validation waits.
                    if let original = destination.target, let rebaseCutoff = inserter.dispatchedAt {
                        insertionRebases.inserted(at: original, confirmed: target, capturedBefore: rebaseCutoff)
                    }
                    rememberContinuation(record, at: .field(target))
                }
                message = "Inserted at your cursor"; deliveryStatus = .inserted; status = "Inserted"
            case .copied(let reason):
                transcript = record.finalText; message = reason; deliveryStatus = .copied; status = "Copied"
            case .unconfirmed(let backup):
                transcript = record.finalText
                message = backup ? "Insertion unconfirmed. Copied to clipboard if needed." : "Insertion unconfirmed. Your words are here to copy."
                deliveryStatus = .unconfirmed; status = "Check insertion"
            case .failed(let reason):
                transcript = record.finalText; message = reason; deliveryStatus = .failed; status = "Ready to copy"
            }
        }
        let shownTranscript = transcript
        let showResult = { [self] in
            lastTranscript = shownTranscript
            lastAudioSeconds = record.audioSeconds
            lastTranscriptionSeconds = (record.speech?.processingSeconds ?? 0) + (record.proofreading?.processingSeconds ?? 0)
            lastDelivery = message
            lastDeliveryStatus = deliveryStatus
            displayedResult = session
            if sessionID == session { statusMessage = status }
        }
        showResult()
        return (DeliveryReceipt(status: deliveryStatus.rawValue, message: message), showResult)
    }

    private func rebasedDestination(_ destination: InsertionDestination) -> InsertionDestination {
        guard let target = destination.target else { return destination }
        return .field(insertionRebases.destination(for: target, capturedAt: target.capturedAt) { TextInserter.unchangedAnchor($0) != nil })
    }

    /// Delivery never overlaps a hold, including a press still inside its acceptance delay.
    private var isHoldingCapture: Bool { isCapturing || hotkey.isHoldInProgress }

    private func waitForCaptureRelease() async {
        while isHoldingCapture, (try? await Task.sleep(for: .milliseconds(50))) != nil {}
    }

    private func stopPendingDictations() -> [Task<Void, Never>] {
        clearUndo(for: nil)
        var discards: [Task<Void, Never>] = []
        for pending in pendingDictations {
            pending.cancel()
            // Durable local takes stay on disk and are recovered archive-only.
            if pending.spool == nil, pending.shouldCancelServer {
                discards.append(Task { try? await pending.client.discardRecording(pending.id, timeout: 3) })
            }
        }
        pendingDictations.removeAll()
        deliveryTail = nil
        insertionRebases.removeAll()
        return discards
    }

    private func continuation(for destination: DictationDestination) -> ContinuationAnchor? {
        let now = ProcessInfo.processInfo.systemUptime
        continuationAnchors.removeAll { now < $0.timestamp || now - $0.timestamp >= 15 * 60 }
        return continuationAnchors.last { $0.destination == destination && $0.confirmed }
    }

    private func prepareContinuation(for destination: DictationDestination?) {
        if let destination, let list = continuation(for: destination)?.continuation.list {
            recordingListHint = list.style == .numbered ? "Continuing at item \(list.nextNumber)" : "Continuing your list"
        } else { recordingListHint = nil }
    }

    private func rememberContinuation(_ record: GenerationRecord, at destination: DictationDestination) {
        continuationAnchors.removeAll { $0.destination == destination }
        guard let continuation = record.continuation else { return }
        continuationAnchors.append(.init(destination: destination, generationID: record.id, continuation: continuation,
                                         timestamp: ProcessInfo.processInfo.systemUptime))
        continuationAnchors = Array(continuationAnchors.suffix(8))
    }

    private func showError(_ message: String) {
        recordingFeedback.reset()
        activity = .failed; errorMessage = message; statusMessage = message
        onHUDVisibility?(true)
        dismissHUDAfter(seconds: 4)
    }

    private func dismissHUDAfter(seconds: Double) {
        hudTask?.cancel()
        hudTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            guard let self, !activity.isBusy else { return }
            // A newer take's result was shown; return the HUD to earlier work.
            if let earlier = pendingDictations.last { showEarlierDictation(earlier); return }
            onHUDVisibility?(false)
            recordingFeedback.reset()
            if activity == .success { activity = .idle; statusMessage = isServerReady ? "Ready when you are" : serverStatusMessage }
        }
    }

    private func installLifecycleObservers() {
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) {
            [weak self] _ in MainActor.assumeIsolated { self?.refreshPermissions(); self?.refreshServer() }
        })
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.willPowerOffNotification] {
            workspaceObservers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) {
                [weak self] _ in MainActor.assumeIsolated {
                    self?.djiSuspensions.insert(name.rawValue)
                    self?.restForSystem(sleeping: name != NSWorkspace.sessionDidResignActiveNotification)
                }
            })
        }
        for (resume, pause) in [(NSWorkspace.didWakeNotification, NSWorkspace.willSleepNotification),
                                (NSWorkspace.sessionDidBecomeActiveNotification, NSWorkspace.sessionDidResignActiveNotification)] {
            workspaceObservers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: resume, object: nil, queue: .main) {
                [weak self] _ in MainActor.assumeIsolated {
                    self?.djiSuspensions.remove(pause.rawValue)
                    self?.refreshDJIMicButton()
                }
            })
        }
        lockObserver = DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) {
            [weak self] _ in MainActor.assumeIsolated {
                self?.djiSuspensions.insert("screenLocked")
                self?.restForSystem(sleeping: false)
            }
        }
        unlockObserver = DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) {
            [weak self] _ in MainActor.assumeIsolated {
                self?.djiSuspensions.remove("screenLocked")
                self?.refreshDJIMicButton()
            }
        }
    }

    /// Lock or a session switch keeps local capture running but archive-only;
    /// sleep pauses it durably. Remote takes still cancel, as the Mac cannot paste.
    private func restForSystem(sleeping: Bool) {
        stopShortcutCheck()
        remoteButtons?.disarm()
        let message = "Recording interrupted while your Mac was away. Check shared history for completed results."
        suppressDelivery = true
        for pending in pendingDictations where pending.spool != nil { pending.suppressDelivery = true }
        let remote = pendingDictations.filter { $0.spool == nil }
        for pending in remote {
            pending.cancel()
            if pending.shouldCancelServer { Task { await pending.client.discardRecordingRetrying(pending.id) } }
        }
        pendingDictations.removeAll { pending in remote.contains { $0 === pending } }
        if isCapturing {
            if activeSpool == nil { failSession(message, cancelServer: remoteCapture?.shouldCancelServer ?? true) }
            else if sleeping { preserveInterruptedRecording("Recording stopped because your Mac is going to sleep.") }
        } else if !remote.isEmpty { showError(message) }
        continuationAnchors.removeAll()
        refreshDJIMicButton()
    }

    func refreshRemoteButtons() {
        guard !isBusy else { return }
        remoteButtons?.close(); remoteButtons = nil; remoteButtonState = nil
        guard hasInitialized, !isShuttingDown, preferences.remoteButtonEnabled, let connection = try? client() else { return }
        remoteButtons = RemoteButtonDestination(connection: connection,
            device: .init(id: preferences.deviceID, name: preferences.deviceName),
            available: { [weak self] in
                guard let self, !isShuttingDown, djiSuspensions.isEmpty, permissions.accessibility else { return false }
                guard let session = CGSessionCopyCurrentDictionary() as? [String: Any], session[kCGSessionOnConsoleKey as String] as? Bool == true else { return false }
                return session["CGSSessionScreenIsLocked"] as? Bool != true
            }, receive: { [weak self] command in
                guard let self else { return false }
                let ticket = command.takeID
                switch command.action {
                case .start:
                    guard !isBusy, isServerReady, !isCheckingShortcut else { return false }
                    remoteButtonSource = command.source
                    beginDictation(trigger: .remoteButton(ticket))
                    return recordingTrigger == .remoteButton(ticket)
                case .stop:
                    if recordingTrigger == .remoteButton(ticket) { finishDictation() }
                case .cancel:
                    if recordingTrigger == .remoteButton(ticket) { cancelDictation(undoable: false) }
                    else if let pending = pendingDictations.first(where: { $0.trigger == .remoteButton(ticket) }),
                            pending.shouldCancelServer { cancelPending(pending) }
                }
                return true
            }, cancelled: { [weak self] in
                guard let self else { return }
                for pending in pendingDictations where pending.trigger?.buttonTicket != nil && pending.shouldCancelServer {
                    cancelPending(pending)
                }
                if recordingTrigger?.buttonTicket != nil { cancelDictation(undoable: false) }
            }, changed: { [weak self] state in
                // An unregistered Mac polls the button's state instead; see refreshButtonState.
                if let state { self?.remoteButtonState = state }
            })
        remoteButtons?.start()
    }

    /// Where the DJI button types, shared by every computer on the server.
    func setButtonTarget(_ target: ButtonTarget) async throws {
        let endpoint = preferences.endpoint
        let state = try await client().setButtonTarget(target)
        guard endpoint == preferences.endpoint else { return }
        remoteButtonState = state
    }

    /// While this Mac is not a registered destination, heartbeats do not report the button's state.
    func refreshButtonState() async {
        guard remoteButtons?.registrationID == nil, let connection = try? client() else { return }
        let endpoint = preferences.endpoint
        let state: ButtonDestinationState? = try? await connection.buttonDestination(method: "GET")
        guard remoteButtons?.registrationID == nil, endpoint == preferences.endpoint else { return }
        remoteButtonState = state
    }

    private func refreshDJIMicButton() {
        guard hasInitialized, !isShuttingDown else { return }
        djiMicButton.refresh(enabled: djiMicButtonEnabled, suspended: !djiSuspensions.isEmpty)
    }

    func retryDJIMicButton() {
        guard hasInitialized, !isShuttingDown, !isBusy else { return }
        djiMicButton.retry(enabled: djiMicButtonEnabled, suspended: !djiSuspensions.isEmpty)
    }

    func refreshPermissions() {
        let current = PermissionSnapshot.capture()
        if current != permissions { permissions = current }
        audioDevices.refresh()
        refreshDJIMicButton()
        if permissions.canListenForHotkey {
            isHotkeyActive = hotkey.start()
        } else {
            hotkey.stop()
            isHotkeyActive = false
        }
    }

    func requestMicrophone() {
        if permissions.microphone {
            PermissionManager.openMicrophoneSettings()
            return
        }
        Task {
            _ = await PermissionManager.requestMicrophone()
            refreshPermissions()
        }
    }

    func requestAccessibility() {
        if permissions.accessibility { PermissionManager.openAccessibilitySettings() }
        else { PermissionManager.requestAccessibility() }
        retryPermissions()
    }

    func requestInputMonitoring() {
        if permissions.inputMonitoring { PermissionManager.openInputMonitoringSettings() }
        else { PermissionManager.requestInputMonitoring() }
        retryPermissions()
    }

    func startShortcutCheck() {
        guard !isBusy, !isCheckingShortcut else { return }
        refreshPermissions()
        shortcutCheckStarted = ProcessInfo.processInfo.systemUptime
        shortcutCheckEntries = []
        isCheckingShortcut = true
        hotkey.onDiagnostic = { [weak self] message in self?.appendShortcutCheck(message) }
        hotkey.requireFreshHold()
        appendShortcutCheck("Checking \(shortcut.title) for 60 seconds. The microphone stays off.")
        appendShortcutCheck("Listener: \(isHotkeyActive ? "enabled" : "unavailable"); Accessibility: \(permissions.accessibility); Input Monitoring: \(permissions.inputMonitoring).")
        shortcutCheckTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 60_000_000_000) }
            catch { return }
            guard !Task.isCancelled else { return }
            self?.stopShortcutCheck()
        }
    }

    func stopShortcutCheck() {
        guard isCheckingShortcut else { return }
        // Reset before leaving check mode: a delayed callback must never start
        // the microphone just because this check timed out during a held key.
        hotkey.requireFreshHold()
        appendShortcutCheck("Check ended. No audio was recorded.")
        hotkey.onDiagnostic = nil
        isCheckingShortcut = false
        shortcutCheckTask?.cancel()
        shortcutCheckTask = nil
    }

    private func appendShortcutCheck(_ message: String) {
        guard isCheckingShortcut else { return }
        let elapsed = ProcessInfo.processInfo.systemUptime - shortcutCheckStarted
        let context = NSApp.isActive ? "SottoDuo" : "background"
        shortcutCheckEntries.append(String(format: "%.2fs", elapsed) + " [\(context)] " + message)
        shortcutCheckEntries = Array(shortcutCheckEntries.suffix(16))
        shortcutCheckText = shortcutCheckEntries.joined(separator: "\n")
    }

    private func startRecordingTimer() {
        stopRecordingTimer()
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.isCapturing else { return }
                let now = ProcessInfo.processInfo.systemUptime
                // Recording sessions have no duration limit; the take ends on release.
                self.recordingFeedback.updateElapsed(self.recordingBaseSeconds + now - self.recordingStart)
            }
        }
        timer.tolerance = 0.025
        recordingTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func endCapturePowerActivity() {
        if let capturePowerActivity { ProcessInfo.processInfo.endActivity(capturePowerActivity) }
        capturePowerActivity = nil
    }

    private func stopRecordingTimer() {
        recordingTimer?.invalidate()
        recordingTimer = nil
    }

    private func resetLevels() {
        recordingFeedback.clearLevels()
    }

    private func retryPermissions() {
        permissionTask?.cancel()
        permissionTask = Task { [weak self] in
            for _ in 0..<30 {
                do { try await Task.sleep(nanoseconds: 2_000_000_000) }
                catch { return }
                guard let self else { return }
                refreshPermissions()
                if allPermissionsGranted { return }
            }
        }
    }

    private func updateLoginItem() {
        guard !updatingLogin else { return }
        updatingLogin = true
        defer { updatingLogin = false }
        loginItemError = nil
        let status = SMAppService.mainApp.status
        if launchAtLogin, status == .enabled { return }
        if launchAtLogin, status == .requiresApproval {
            loginItemError = "Allow SottoDuo in System Settings → General → Login Items to finish enabling this preference."
            return
        }
        // A rebuilt accessory app may report .notFound even though login is
        // already off. Do not attempt to unregister an absent service.
        if !launchAtLogin, status != .enabled, status != .requiresApproval { return }
        do {
            if launchAtLogin { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            if launchAtLogin, SMAppService.mainApp.status == .requiresApproval {
                loginItemError = "Allow SottoDuo in System Settings → General → Login Items to finish enabling this preference."
            }
        } catch {
            // Keep the desired setting consistent between UI and JSON. A denied
            // OS operation must not trigger file rollback/retry feedback loops.
            loginItemError = "Couldn’t update launch at login: \(error.localizedDescription)"
        }
    }


}
