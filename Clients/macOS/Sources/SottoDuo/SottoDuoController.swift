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

/// The desktop never owns a durable generation or a model process. A take has
/// one accepted server generation, one bounded upload, and at most one delivery.
@MainActor
final class SottoDuoController: ObservableObject {
    @Published var activity: DictationActivity = .idle
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
    private var historyCursor: String?
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
    var isCapturing: Bool { activity.isCapturing }
    var recordingUsesClipboard: Bool { isCapturing && insertionDestination == .clipboard }
    var isBusy: Bool { activity.isBusy }
    var canCancelWithEscape: Bool { !hotkey.isHoldingFn }
    var isServerReady: Bool { serverHealth?.ready == true && serverHealth?.apiVersion == SottoDuoAPI.version }
    var canTest: Bool { isServerReady && microphones.resolution.device != nil && !isBusy }
    var selectedInputName: String { microphones.resolution.device?.displayName ?? "No microphone available" }
    var usesRemoteInput: Bool { microphones.resolution.device?.remote != nil }
    var mayUseLocalMicrophone: Bool {
        guard let selected = microphones.resolution.device else { return false }
        if selected.remote == nil { return true }
        return microphones.localFallback != nil
    }
    var allPermissionsGranted: Bool { (usesRemoteInput || permissions.microphone) && permissions.accessibility }
    var onHUDVisibility: ((Bool) -> Void)?
    var onShowWindow: (() -> Void)?

    private let recorder = AudioRecorder()
    private let audioDevices = AudioDeviceStore()
    private let hotkey = HotkeyMonitor()
    private let djiMicButton = DJIMicButtonMonitor()
    private var djiSuspensions: Set<String> = []
    private var remoteButtons: RemoteButtonDestination?
    private var buttonSelectionAtStart: UUID?
    private var remoteButtonSource: AudioSourceIdentity?
    @Published private(set) var remoteButtonState: ButtonDestinationState?
    private var recordingTrigger: DictationTrigger?
    private let inserter = TextInserter()
    private var subscriptions: Set<AnyCancellable> = []
    private var applyingConfiguration = false
    private var recordingTimer: Timer?
    private var recordingStart: TimeInterval = 0
    private var microphoneStartTask: Task<Void, Never>?
    private var transcriptionTask: Task<Void, Never>?
    private var uploadTask: Task<FinishGenerationRequest, Error>?
    private var uploadPipe: AudioChunkPipe?
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
    private var activeGenerationID: UUID?
    private var activeClient: ServerClient?
    private var serverSealed = false
    @Published private var insertionDestination: InsertionDestination?
    private var destinationTask: InsertionDestinationCapture?
    private var recordingClipboardChangeCount = 0
    private struct ContinuationAnchor {
        let destination: DictationDestination
        let generationID: UUID
        let continuation: DictationContinuation
        let timestamp: TimeInterval
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

    init(configuration: ConfigurationStore, startServices: Bool = true, clientPreferences: ClientPreferencesStore? = nil) {
        self.configuration = configuration
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
        audioDevices.start()
        installLifecycleObservers()
        refreshPermissions()
        // Capture files are temporary only; server history is never examined here.
        CapturedAudio.cleanupOrphans()
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
        guard !isBusy, !isShuttingDown else { return }
        applyingConfiguration = true
        if let key = HoldKey(rawValue: settings.holdKey), shortcut != key { shortcut = key }
        if let mode = HotkeyActivationMode(rawValue: settings.activationMode), activationMode != mode { activationMode = mode }
        if launchAtLogin != settings.launchAtLogin { launchAtLogin = settings.launchAtLogin }
        if djiMicButtonEnabled != settings.djiMicButtonEnabled { djiMicButtonEnabled = settings.djiMicButtonEnabled }
        applyingConfiguration = false
    }

    private func client() throws -> ServerClient {
        try ServerClient(endpoint: preferences.endpoint, token: preferences.token)
    }

    private func refreshAudioSources() async throws {
        let connection = try client()
        let endpoint = preferences.endpoint
        let token = preferences.token
        do {
            let sources = try await connection.audioSources()
            guard endpoint == preferences.endpoint, token == preferences.token, !Task.isCancelled else { return }
            microphones.updateRemote(sources, server: connection.endpoint.absoluteString)
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
            serverStatusMessage = health.apiVersion != SottoDuoAPI.version ? "Server API version is incompatible"
                : (health.ready ? "Server online" : (health.message ?? "Server models are not ready"))
            if !isBusy, activity == .idle { statusMessage = isServerReady ? "Ready when you are" : serverStatusMessage }
            if refreshData {
                let source = historySourceFilter
                async let settings = connection.preferences()
                async let page = connection.history(source: source == "all" ? nil : source)
                let (saved, history) = try await (settings, page)
                guard endpoint == preferences.endpoint, source == historySourceFilter, !Task.isCancelled else { return }
                sharedPreferences = saved
                if generations.count > history.items.count, history.nextCursor != nil,
                   let oldest = history.items.last?.createdAt {
                    let ids = Set(history.items.map(\.id))
                    let older = generations.filter { $0.createdAt < oldest && !ids.contains($0.id) }
                    generations = history.items + older
                } else {
                    generations = history.items
                    historyCursor = history.nextCursor
                    hasMoreHistory = history.nextCursor != nil
                }
            }
        } catch is CancellationError {
        } catch {
            guard endpoint == preferences.endpoint, !Task.isCancelled else { return }
            serverHealth = nil
            serverStatusMessage = Self.connectionMessage(error)
            if isCapturing { failSession(serverStatusMessage, cancelServer: true) }
            else if !isBusy, activity == .idle { statusMessage = serverStatusMessage }
        }
    }

    func saveConnection(endpoint: String, token: String, deviceName: String) {
        guard !isBusy, wisprFlowImportTask == nil else { return }
        guard preferences.save(endpoint: endpoint, token: token, deviceName: deviceName) else {
            errorMessage = preferences.errorMessage
            return
        }
        refreshRemoteButtons()
        continuationAnchors.removeAll()
        microphones.clearRemote()
        serverHealth = nil
        sharedPreferences = nil
        generations = []
        historyCursor = nil
        hasMoreHistory = false
        serverStatusMessage = "Connecting…"
        refreshServer()
    }

    func refreshHistory() {
        Task { [weak self] in
            guard let self else { return }
            do {
                let endpoint = preferences.endpoint
                let source = historySourceFilter
                let page = try await client().history(source: source == "all" ? nil : source)
                guard endpoint == preferences.endpoint, source == historySourceFilter else { return }
                generations = page.items
                historyCursor = page.nextCursor
                hasMoreHistory = page.nextCursor != nil
            } catch { errorMessage = error.localizedDescription }
        }
    }

    func loadMoreHistory() {
        guard !isLoadingHistory, let cursor = historyCursor else { return }
        isLoadingHistory = true
        Task { [weak self] in
            guard let self else { return }
            defer { isLoadingHistory = false }
            do {
                let endpoint = preferences.endpoint
                let source = historySourceFilter
                let page = try await client().history(before: cursor, source: source == "all" ? nil : source)
                guard endpoint == preferences.endpoint, historyCursor == cursor, source == historySourceFilter else { return }
                let existing = Set(generations.map(\.id))
                generations += page.items.filter { !existing.contains($0.id) }
                historyCursor = page.nextCursor
                hasMoreHistory = page.nextCursor != nil
            } catch { errorMessage = error.localizedDescription }
        }
    }

    func setHistorySourceFilter(_ source: String) {
        guard ["all", "sottoduo", "wispr-flow"].contains(source), source != historySourceFilter else { return }
        historySourceFilter = source
        generations = []
        historyCursor = nil
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
                        let sourceReported = session.unarchivedArtifacts.map { omitted in
                            "\(omitted.filename.rawValue) (\(ByteCountFormatter.string(fromByteCount: Int64(omitted.byteCount), countStyle: .file)), SHA-256 \(omitted.sha256))"
                        }
                        let mediaNames = sourceReported.isEmpty
                            ? result.unarchivedArtifactNames.map(\.rawValue).joined(separator: ", ")
                            : sourceReported.joined(separator: ", ")
                        let mediaWarning = mediaNames.isEmpty ? nil
                            : "Session \(sourceID.uuidString) has unarchived media: \(mediaNames). Source version details are in source.json."
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
                try await client().delete(id)
                generations.removeAll { $0.id == id }
                continuationAnchors.removeAll { $0.generationID == id }
            } catch { errorMessage = error.localizedDescription }
        }
    }

    func openGenerationAudio(_ generation: GenerationRecord, kind: AudioKind) {
        Task { [weak self] in
            guard let self else { return }
            do { NSWorkspace.shared.open(try await client().audio(generation.id, kind: kind)) }
            catch { errorMessage = error.localizedDescription }
        }
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
        else if !isBusy { beginDictation(trigger: .test) }
    }

    func cancelDictation() {
        guard isBusy else { return }
        let generation = activeGenerationID
        let connection = activeClient
        resetSession()
        activity = .idle
        statusMessage = "Cancelled"
        errorMessage = nil
        onHUDVisibility?(false)
        if let generation, let connection {
            Task { [weak self] in
                try? await connection.cancel(generation)
                self?.refreshServer()
            }
        }
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
        transcriptionTask?.cancel(); transcriptionTask = nil
        uploadPipe?.cancel(); uploadPipe = nil
        uploadTask?.cancel(); uploadTask = nil
        destinationTask?.cancel(); destinationTask = nil
        stopRecordingTimer()
        recorder.cancel()
        recorder.onChunk = nil
        insertionDestination = nil
        recordingListHint = nil
        recordingInputName = nil
        activeGenerationID = nil
        activeClient = nil
        serverSealed = false
        recordingFeedback.reset()
    }

    private func failSession(_ message: String, cancelServer: Bool) {
        let generation = activeGenerationID
        let connection = activeClient
        resetSession()
        showError(message)
        if cancelServer, let generation, let connection { Task { try? await connection.cancel(generation) } }
        refreshHistory()
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

    func shutdown() {
        guard !isShuttingDown else { return }
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
        // Quitting the client cancels an incomplete recording. A sealed server
        // generation remains independently owned and may complete in history.
        let generation = activeGenerationID
        let connection = activeClient
        let shouldCancel = remoteCapture?.shouldCancelServer ?? !serverSealed
        resetSession()
        if shouldCancel, let generation, let connection { Task { try? await connection.cancel(generation) } }
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
        recorder.onInterruption = { [weak self] message in self?.failSession(message, cancelServer: true) }
        hotkey.onStatusChange = { [weak self] in self?.isHotkeyActive = $0 }
        djiMicButton.onStatusChange = { [weak self] in self?.djiMicButtonStatus = $0 }
        djiMicButton.onPress = { [weak self] in self?.receiveDJIMicButton($0) }
        djiMicButton.onDisconnect = { [weak self] id in
            guard let self, isCapturing, recordingTrigger == .dji(id) else { return }
            cancelDictation()
        }
        hotkey.onPress = { [weak self] in
            guard let self else { return false }
            if isCheckingShortcut {
                appendShortcutCheck("Shortcut recognized. Recording was intentionally skipped.")
                // No take started, so a double-tap monitor must not latch.
                return false
            }
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
            else if isBusy, recordingTrigger == .keyboard { cancelDictation() }
        }
        hotkey.onEscape = { [weak self] in
            guard let self, !isCheckingShortcut else { return }
            if isBusy { cancelDictation() }
            else { dismissFeedback() }
        }
    }

    private func receiveDJIMicButton(_ deviceID: UInt64) {
        guard djiMicButtonEnabled, !isCheckingShortcut, !isShuttingDown, djiSuspensions.isEmpty else { return }
        switch DictationTrigger.djiButtonAction(deviceID: deviceID, activity: activity, current: recordingTrigger) {
        case .start: beginDictation(trigger: .dji(deviceID))
        case .finish: finishDictation()
        case .ignore: break
        }
    }

    /// Returns whether a take actually started. A double-tap monitor latches
    /// only on true, so a rejected start cannot leave a phantom recording.
    @discardableResult
    private func beginDictation(trigger: DictationTrigger) -> Bool {
        guard !isBusy, !isShuttingDown else { return false }
        let isTest = trigger == .test
        let buttonSource = trigger.buttonTicket == nil ? nil : remoteButtonSource
        stopShortcutCheck()
        guard isServerReady else { showError(serverStatusMessage); refreshServer(); onShowWindow?(); return false }
        hudTask?.cancel(); errorMessage = nil
        liveTranscript = ""
        sessionID = UUID()
        let current = sessionID
        isTestSession = isTest
        recordingTrigger = trigger
        buttonSelectionAtStart = trigger == .keyboard ? remoteButtons?.registrationID : nil
        serverSealed = false
        recordingClipboardChangeCount = NSPasteboard.general.changeCount
        insertionDestination = nil
        recordingInputName = nil
        recordingFeedback.reset()
        activity = .starting
        statusMessage = "Connecting recording…"
        onHUDVisibility?(true)
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
                    let sources = try await connection.audioSources()
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
                } catch ServerClientError.captureUnavailable(let message) {
                    // Only a definitive pre-ready rejection permits one fresh admission.
                    guard buttonSource == nil, input.remote != nil, sessionID == current, activity == .starting,
                          !Task.isCancelled, ProcessInfo.processInfo.systemUptime < deadline,
                          let fallback = microphones.localFallback else { throw ServerClientError.captureUnavailable(message) }
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
        recordingInputName = input.displayName
        let base = try client()
        let device = DeviceIdentity(id: preferences.deviceID, name: preferences.deviceName)
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        guard remaining > 0 else { throw ServerClientError.captureUnavailable("The microphone did not start in time. Try another take.") }
        if let remote = input.remote {
            guard remote.server == base.endpoint.absoluteString else { throw ServerClientError.invalidResponse }
            let connection = try base.owningCapture()
            let source = AudioSourceIdentity(hostID: remote.hostID, id: input.uid)
            statusMessage = "Starting remote microphone…"
            let requestedAt = ProcessInfo.processInfo.systemUptime
            let created = try await connection.startCapture(.init(requestID: requestID, device: device,
                mode: isTest ? .test : .dictation, source: source, buttonTicket: recordingTrigger?.buttonTicket), timeout: remaining)
            guard sessionID == current, activity == .starting, !Task.isCancelled else {
                Task { try? await connection.cancel(created.id) }; return
            }
            activeGenerationID = created.id; activeClient = connection
            guard created.capture?.source == source else { throw ServerClientError.invalidResponse }
            let capture = try RemoteCaptureSession(record: created, connection: connection, requestedAt: requestedAt)
            remoteCapture = capture
            sharedPreferences = created.settings
            recordingStart = ProcessInfo.processInfo.systemUptime
            activity = .recording
            statusMessage = "Listening · remote microphone → this Mac"
            capture.monitor { [weak self] record in
                guard let self, sessionID == current else { return }
                if isRecording {
                    if let peak = record.capture?.peak { recordingFeedback.append(Float(peak)) }
                    if let recognition = record.recognition { applyRecognition(recognition, session: current) }
                } else { applyProgress(record, session: current) }
            } onFailure: { [weak self] error in
                guard let self, sessionID == current else { return }
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
            let created = try await connection.create(.init(requestID: requestID, device: device, mode: isTest ? .test : .dictation), timeout: remaining)
            guard sessionID == current, activity == .starting, !Task.isCancelled else {
                Task { try? await connection.cancel(created.id) }; return
            }
            activeGenerationID = created.id; activeClient = connection
            guard created.status == .receiving, created.capture == nil else { throw ServerClientError.invalidResponse }
            sharedPreferences = created.settings
            let pipe = AudioChunkPipe { [weak self] error in
                Task { @MainActor [weak self] in
                    guard let self, sessionID == current else { return }
                    failSession(error.localizedDescription, cancelServer: true)
                }
            }
            uploadPipe = pipe
            recorder.onChunk = { pipe.append($0) }
            uploadTask = Task { [weak self] in
                do {
                    if created.recognition != nil {
                        return try await connection.uploadStreaming(pipe.stream, to: created.id,
                            preserveOriginal: created.settings.preferences.keepOriginalAudio) { [weak self] recognition in
                                await self?.applyRecognition(recognition, session: current)
                            }
                    }
                    return try await connection.upload(pipe.stream, to: created.id, preserveOriginal: created.settings.preferences.keepOriginalAudio)
                } catch {
                    if let self, sessionID == current, !Task.isCancelled { failSession(Self.connectionMessage(error), cancelServer: true) }
                    throw error
                }
            }
            recordingStart = ProcessInfo.processInfo.systemUptime
            statusMessage = "Starting microphone…"
            try await recorder.start(deviceID: deviceID, preserveOriginalAudio: created.settings.preferences.keepOriginalAudio)
            guard sessionID == current, activity == .starting, !Task.isCancelled else { return }
            activity = .recording
            statusMessage = "Listening"
        }
        startRecordingTimer()
    }

    private func finishDictation(atLimit: Bool = false) {
        guard isCapturing else { return }
        // A take ended by the duration limit must not leave a double-tap
        // latch behind, matching the failure and cancel paths.
        hotkey.clearLatchedTake()
        recorder.stopAcceptingAudio()
        guard activity == .recording else { cancelDictation(); return }
        let releasedAt = ProcessInfo.processInfo.systemUptime
        destinationTask?.finish()
        guard releasedAt - recordingStart >= 0.25 else { cancelDictation(); return }
        guard let id = activeGenerationID, let connection = activeClient else {
            failSession("This recording has no server session.", cancelServer: true); return
        }
        stopRecordingTimer(); resetLevels()
        recordingFeedback.finish(atLimit: atLimit)
        activity = .transcribing
        statusMessage = remoteCapture == nil ? "Finishing upload…" : "Stopping remote microphone…"
        let capture = remoteCapture
        let uploadTask = uploadTask
        let uploadPipe = uploadPipe
        let current = sessionID
        let test = isTestSession
        let capturedDestination = insertionDestination
        let pendingDestination = destinationTask
        let clipboardCount = recordingClipboardChangeCount
        transcriptionTask = Task { [weak self] in
            guard let self else { return }
            var capturedAudio: CapturedAudio?
            defer { capturedAudio?.cleanup() }
            do {
                var finish: FinishGenerationRequest?
                if capture == nil {
                    guard let uploadTask, let uploadPipe else { throw ServerClientError.invalidResponse }
                    let audio = try await recorder.stop()
                    capturedAudio = audio
                    guard sessionID == current, !Task.isCancelled else { return }
                    uploadPipe.finish()
                    finish = try await uploadTask.value
                    guard sessionID == current, !Task.isCancelled else { return }
                    audio.cleanup()
                    capturedAudio = nil
                }
                let destination: InsertionDestination
                if test { destination = .clipboard }
                else if let capturedDestination { destination = capturedDestination }
                else { destination = await pendingDestination?.value ?? .clipboard }
                let resolved: InsertionDestination
                if let target = destination.target, !InsertionCapturePolicy.permitsInsertion(capturedAt: target.capturedAt, releasedAt: releasedAt) {
                    resolved = .clipboard
                } else { resolved = destination }
                let anchor: DictationDestination? = test ? .test : resolved.target.flatMap { $0.selection == nil ? nil : .field($0) }
                let continuationID = anchor.flatMap { self.continuation(for: $0)?.generationID }
                guard sessionID == current, !Task.isCancelled else { return }
                var result: GenerationRecord
                if let capture {
                    result = try await capture.stop(continuationID: continuationID)
                    serverSealed = true
                } else {
                    guard var finish else { throw ServerClientError.invalidResponse }
                    finish.continuationID = continuationID
                    serverSealed = true // An interrupted response may still mean the server accepted the seal.
                    result = try await connection.finish(id, value: finish)
                    guard sessionID == current, !Task.isCancelled else { return }
                    if !result.status.isTerminal {
                        result = try await connection.events(id) { [weak self] record in
                            await self?.applyProgress(record, session: current)
                        }
                    }
                }
                guard sessionID == current, !Task.isCancelled else { return }
                guard result.status == .completed else {
                    throw ServerClientError.rejected(422, result.error ?? "The server could not process this recording.")
                }
                await deliver(result, to: resolved, anchor: anchor, isTest: test, clipboardCount: clipboardCount, session: current)
                guard sessionID == current, !Task.isCancelled else { return }
                let receipt = DeliveryReceipt(status: lastDeliveryStatus.rawValue, message: lastDelivery)
                // Receipt failures never trigger a second insertion. They only
                // disable cross-take continuation until a confirmed receipt exists.
                do { try await connection.delivery(id, receipt: receipt) }
                catch { continuationAnchors.removeAll { $0.generationID == id } }
                guard sessionID == current, !Task.isCancelled else { return }
                // A tap made while the take was finishing must not pair with
                // one made after it, matching the cancel and failure paths.
                hotkey.clearLatchedTake()
                capture?.cancelMonitoring(); remoteCapture = nil
                activeGenerationID = nil; activeClient = nil; self.uploadTask = nil; self.uploadPipe = nil
                destinationTask = nil; insertionDestination = nil; recordingListHint = nil; recordingInputName = nil
                recorder.onChunk = nil
                if let ticket = recordingTrigger?.buttonTicket { remoteButtons?.complete(ticket) }
                else if recordingTrigger == .keyboard, let registrationID = buttonSelectionAtStart, !result.insertionText.isEmpty, lastDeliveryStatus != .failed, lastDeliveryStatus != .unconfirmed {
                    let destination = remoteButtons
                    Task { try? await destination?.select(generationID: id, registrationID: registrationID) }
                }
                recordingTrigger = nil; remoteButtonSource = nil; buttonSelectionAtStart = nil
                activity = lastDeliveryStatus == .failed ? .failed : .success
                dismissHUDAfter(seconds: lastDeliveryStatus == .failed || lastDeliveryStatus == .unconfirmed ? 4 : 1.7)
                refreshServer()
                applyConfiguration(configuration.configuration)
            } catch is CancellationError {
            } catch AudioRecordingError.cancelled {
            } catch {
                guard sessionID == current, !Task.isCancelled else { return }
                if error is URLError { serverHealth = nil; serverStatusMessage = Self.connectionMessage(error) }
                failSession(Self.connectionMessage(error), cancelServer: capture?.shouldCancelServer ?? !serverSealed)
            }
        }
    }

    private func applyRecognition(_ recognition: RecognitionState, session: UUID) {
        guard sessionID == session, isCapturing else { return }
        liveTranscript = recognition.partialText ?? ""
        if recognition.provider == .whisper {
            statusMessage = recognition.fallbackReason == nil ? "Listening · server recognition" : "Listening · server recognition (cloud unavailable)"
        }
    }

    private func applyProgress(_ generation: GenerationRecord, session: UUID) {
        guard sessionID == session, isBusy else { return }
        switch generation.status {
        case .receiving: statusMessage = remoteCapture == nil ? "Finishing upload…" : "Stopping remote microphone…"
        case .queued: statusMessage = "Waiting for server…"
        case .transcribing: statusMessage = "Transcribing on server…"
        case .proofreading: statusMessage = "Proofreading on server…"
        case .completed: statusMessage = "Preparing result…"
        case .failed, .cancelled: statusMessage = generation.error ?? "Processing stopped"
        }
    }

    private func deliver(_ record: GenerationRecord, to destination: InsertionDestination,
                         anchor: DictationDestination?, isTest: Bool, clipboardCount: Int, session: UUID) async {
        liveTranscript = ""
        lastTranscript = record.previewText.isEmpty ? record.finalText : record.previewText
        lastAudioSeconds = record.audioSeconds
        lastTranscriptionSeconds = (record.speech?.processingSeconds ?? 0) + (record.proofreading?.processingSeconds ?? 0)
        if isTest {
            rememberContinuation(record, at: .test)
            lastDelivery = "Test complete. Nothing was pasted."
            lastDeliveryStatus = .tested
            statusMessage = record.finalText.isEmpty ? "No speech detected" : "Ready to copy"
            return
        }
        if record.insertionText.isEmpty {
            if record.continuation == nil && record.previewText.isEmpty {
                lastDelivery = "No speech detected"; lastDeliveryStatus = .none
            } else if let confirmed = TextInserter.unchangedAnchor(destination.target) {
                rememberContinuation(record, at: .field(confirmed))
                lastDelivery = "List updated. Nothing was pasted."; lastDeliveryStatus = .listUpdated
            } else {
                lastDelivery = "List state unchanged: the original cursor could not be confirmed."
                lastDeliveryStatus = .unconfirmed
            }
            statusMessage = lastDelivery
            return
        }
        activity = .delivering
        statusMessage = "Inserting at your cursor…"
        let outcome = await inserter.deliver(record.insertionText, copying: record.finalText,
                                              to: destination, clipboardUnchangedSince: clipboardCount)
        guard sessionID == session, !Task.isCancelled else { return }
        if let anchor { continuationAnchors.removeAll { $0.destination == anchor } }
        switch outcome {
        case .inserted:
            if let target = inserter.confirmedAnchor { rememberContinuation(record, at: .field(target)) }
            lastDelivery = "Inserted at your cursor"; lastDeliveryStatus = .inserted; statusMessage = "Inserted"
        case .copied(let reason):
            lastTranscript = record.finalText; lastDelivery = reason; lastDeliveryStatus = .copied; statusMessage = "Copied"
        case .unconfirmed(let backup):
            lastTranscript = record.finalText
            lastDelivery = backup ? "Insertion unconfirmed. Copied to clipboard if needed." : "Insertion unconfirmed. Your words are here to copy."
            lastDeliveryStatus = .unconfirmed; statusMessage = "Check insertion"
        case .failed(let reason):
            lastTranscript = record.finalText; lastDelivery = reason; lastDeliveryStatus = .failed; statusMessage = "Ready to copy"
        }
    }

    private func continuation(for destination: DictationDestination) -> ContinuationAnchor? {
        let now = ProcessInfo.processInfo.systemUptime
        continuationAnchors.removeAll { now < $0.timestamp || now - $0.timestamp >= 15 * 60 }
        return continuationAnchors.last { $0.destination == destination }
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
            guard let self, !isBusy else { return }
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
                    self?.restForSystem()
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
                self?.restForSystem()
            }
        }
        unlockObserver = DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) {
            [weak self] _ in MainActor.assumeIsolated {
                self?.djiSuspensions.remove("screenLocked")
                self?.refreshDJIMicButton()
            }
        }
    }

    private func restForSystem() {
        stopShortcutCheck()
        remoteButtons?.disarm()
        if isBusy {
            let cancelServer = remoteCapture?.shouldCancelServer ?? !serverSealed
            failSession("Recording interrupted while your Mac was away. Check shared history for completed results.", cancelServer: cancelServer)
        }
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
                    if recordingTrigger == .remoteButton(ticket), !serverSealed { cancelDictation() }
                }
                return true
            }, cancelled: { [weak self] in
                guard let self, recordingTrigger?.buttonTicket != nil, !serverSealed else { return }
                cancelDictation()
            }, changed: { [weak self] in self?.remoteButtonState = $0 })
        remoteButtons?.start()
    }

    func selectRemoteButtonDestination() {
        Task { [weak self] in
            guard let self, let remoteButtons else { return }
            do { try await remoteButtons.select() } catch { errorMessage = error.localizedDescription }
        }
    }

    func disarmRemoteButtonDestination() { remoteButtons?.disarm() }

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
                let elapsed = ProcessInfo.processInfo.systemUptime - self.recordingStart
                let maximum = self.remoteCapture.map { $0.stopAt - self.recordingStart } ?? LifecyclePolicy.maximumRecordingSeconds
                self.recordingFeedback.updateElapsed(elapsed, maximumSeconds: maximum)
                if elapsed >= maximum { self.finishDictation(atLimit: true) }
            }
        }
        timer.tolerance = 0.025
        recordingTimer = timer
        RunLoop.main.add(timer, forMode: .common)
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
