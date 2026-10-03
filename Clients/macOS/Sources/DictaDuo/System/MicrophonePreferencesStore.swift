import Combine
import Foundation
import DictaDuoCore
import DictaDuoAPI

enum MicrophoneProfileError: LocalizedError, Equatable {
    case emptyName
    case duplicateName
    case lastProfile
    case missingProfile

    var errorDescription: String? {
        switch self {
        case .emptyName: "Give the priority list a name."
        case .duplicateName: "A priority list already has that name."
        case .lastProfile: "Keep at least one priority list."
        case .missingProfile: "That priority list is no longer available."
        }
    }
}

/// Preferences and connected-device snapshots, with no microphone ownership.
@MainActor
final class MicrophonePreferencesStore: ObservableObject {
    @Published private(set) var preferences: MicrophonePreferences
    @Published private(set) var availableDevices: [AudioInputDevice] = []
    @Published private(set) var systemDefaultUID: String?
    @Published private(set) var storageError: String?
    /// Sharing computers' names by host ID. Kept while offline so saved inputs still read naturally.
    @Published private(set) var hostNames: [String: String] = [:]
    /// The connected server's computer name; `hostNames` also remembers earlier servers.
    @Published private(set) var currentHostName: String?
    private var localDevices: [AudioInputDevice] = []
    private var remoteSources: [String: AudioSource] = [:]
    private var remoteDevices: [AudioInputDevice] = []
    /// This computer's identity; a shared source recording for anyone else is busy.
    private var deviceID: String?
    private var publishedAvailability: [String: String] = [:]
    private let configuration: ConfigurationStore
    private var subscriptions: Set<AnyCancellable> = []

    init(configuration: ConfigurationStore) {
        self.configuration = configuration
        preferences = configuration.configuration.microphones
        storageError = configuration.errorMessage
        configuration.$configuration
            .map(\.microphones)
            .removeDuplicates()
            .sink { [weak self] value in self?.preferences = value }
            .store(in: &subscriptions)
        configuration.$errorMessage
            .removeDuplicates()
            .sink { [weak self] message in self?.storageError = message }
            .store(in: &subscriptions)
    }

    var activeProfile: MicrophoneProfile { preferences.activeProfile }
    var prefersRemoteInput: Bool {
        switch preferences.selection {
        case .automatic: activeProfile.priority.contains { $0.remote != nil }
        case .fixed(let device): device.remote != nil
        case .systemDefault: false
        }
    }
    var resolution: MicrophoneResolution {
        MicrophoneSelectionPolicy.resolve(preferences: preferences, available: availableDevices.filter { isEligible($0) }, systemDefaultUID: systemDefaultUID)
    }
    var otherDevices: [AudioInputDevice] {
        let preferred = Set(activeProfile.priority.map(\.id))
        return availableDevices.filter { !preferred.contains($0.id) }
    }

    func connectedDevice(id: String) -> AudioInputDevice? {
        availableDevices.first { $0.id == id }
    }

    func isEligible(_ device: AudioInputDevice, at now: Date = Date()) -> Bool {
        device.remote == nil ? localDevices.contains(where: { $0.id == device.id })
            : remoteSources[device.id]?.isEligible(at: now) == true && busyFor(device) == nil
    }

    func source(_ device: AudioInputDevice) -> AudioSource? { remoteSources[device.id] }

    /// The other computer whose take holds this shared source, if any.
    func busyFor(_ device: AudioInputDevice) -> DeviceIdentity? {
        guard let holder = remoteSources[device.id]?.recordingFor, holder.id != deviceID else { return nil }
        return DeviceIdentity(id: holder.id, name: holder.name)
    }

    /// The sharing computer's name, or its host ID before the server has named it.
    func hostName(_ device: AudioInputDevice) -> String? {
        device.remote.map { hostNames[$0.hostID] ?? $0.hostID }
    }

    func qualifiedName(_ device: AudioInputDevice) -> String { device.qualifiedName(host: hostName(device)) }

    func availability(_ device: AudioInputDevice) -> String {
        guard device.remote != nil else { return isEligible(device) ? "Connected" : "Disconnected" }
        // Unlisted: offline, or no longer shared with this Mac.
        guard let source = remoteSources[device.id] else { return "Not available" }
        if let holder = busyFor(device) { return "Busy · \(holder.name) is dictating" }
        if isEligible(device) { return "Ready" }
        if !source.present || source.link == .disconnected { return "Disconnected" }
        if source.audioHealth == .degraded { return "Audio degraded" }
        return "Unavailable"
    }

    func updateRemote(_ sources: [AudioSource], server: String, host: SharingHost? = nil, deviceID: String? = nil) {
        self.deviceID = deviceID
        if currentHostName != host?.name { currentHostName = host?.name }
        if let host {
            var names = hostNames
            for source in sources { names[source.identity.hostID] = host.name }
            if names != hostNames { hostNames = names }
        }
        remoteSources = [:]
        remoteDevices = sources.prefix(32).compactMap { source in
            let device = AudioInputDevice(uid: source.identity.id, name: source.name,
                transport: AudioInputTransport(rawValue: source.transport.rawValue) ?? .other,
                remote: RemoteInputHost(server: server, hostID: source.identity.hostID))
            guard remoteSources[device.id] == nil else { return nil }
            remoteSources[device.id] = source
            return device
        }
        rebuildDevices()
    }

    func clearRemote() {
        remoteSources = [:]; remoteDevices = []
        currentHostName = nil
        rebuildDevices()
    }

    func resolution(excluding id: String) -> MicrophoneResolution {
        MicrophoneSelectionPolicy.resolve(preferences: preferences,
            available: availableDevices.filter { $0.id != id && isEligible($0) }, systemDefaultUID: systemDefaultUID)
    }

    var localFallback: AudioInputDevice? {
        MicrophoneSelectionPolicy.resolve(preferences: preferences,
            available: localDevices.filter { isEligible($0) }, systemDefaultUID: systemDefaultUID).device
    }

    private func rebuildDevices() {
        let devices = localDevices + remoteDevices
        let statuses = Dictionary(devices.map { ($0.id, availability($0)) }, uniquingKeysWith: { first, _ in first })
        // Timestamp-only polls do not repaint the settings/controller. A status
        // transition must still invalidate resolution when device metadata is unchanged.
        if availableDevices != devices { availableDevices = devices }
        else if publishedAvailability != statuses { objectWillChange.send() }
        publishedAvailability = statuses
    }

    func update(devices: [AudioInputDevice], systemDefaultUID: String?) {
        localDevices = devices
        rebuildDevices()
        if self.systemDefaultUID != systemDefaultUID { self.systemDefaultUID = systemDefaultUID }
        guard configuration.isLoaded else { return }
        // Refresh names/transport without forgetting offline favorites or order.
        var next = preferences
        for index in next.profiles.indices {
            next.profiles[index].priority = next.profiles[index].priority.map { connectedDevice(id: $0.id) ?? $0 }
        }
        if case .fixed(let device) = next.selection, let connected = connectedDevice(id: device.id) {
            next.selection = .fixed(connected)
        }
        save(next)
    }

    func select(_ selection: MicrophoneSelection) {
        var next = preferences
        next.selection = selection
        save(next)
    }

    func selectProfile(_ id: String) {
        guard preferences.profiles.contains(where: { $0.id == id }) else { return }
        var next = preferences
        next.activeProfileID = id
        save(next)
    }

    func addProfile(named name: String) -> Result<Void, MicrophoneProfileError> {
        switch validatedName(name) {
        case .failure(let error): return .failure(error)
        case .success(let name):
            var next = preferences
            let profile = MicrophoneProfile(name: name)
            next.profiles.append(profile)
            next.activeProfileID = profile.id
            save(next)
            return .success(())
        }
    }

    func renameProfile(_ id: String, to name: String) -> Result<Void, MicrophoneProfileError> {
        guard let index = preferences.profiles.firstIndex(where: { $0.id == id }) else { return .failure(.missingProfile) }
        switch validatedName(name, excluding: id) {
        case .failure(let error): return .failure(error)
        case .success(let name):
            var next = preferences
            next.profiles[index].name = name
            save(next)
            return .success(())
        }
    }

    func removeProfile(_ id: String) -> Result<Void, MicrophoneProfileError> {
        guard preferences.profiles.contains(where: { $0.id == id }) else { return .failure(.missingProfile) }
        guard preferences.profiles.count > 1 else { return .failure(.lastProfile) }
        var next = preferences
        next.profiles.removeAll { $0.id == id }
        save(next)
        return .success(())
    }

    func addToPriority(_ device: AudioInputDevice) {
        editPriority { entries in
            guard !entries.contains(where: { $0.id == device.id }) else { return }
            entries.append(device)
        }
    }

    func removeFromPriority(id: String) {
        editPriority { $0.removeAll { $0.id == id } }
    }

    func movePriority(fromOffsets offsets: IndexSet, toOffset destination: Int) {
        editPriority { entries in
            let indices = offsets.filter { entries.indices.contains($0) }
            guard !indices.isEmpty, (0...entries.count).contains(destination) else { return }
            let moved = indices.map { entries[$0] }
            let selected = Set(indices)
            var remaining = entries.enumerated().filter { !selected.contains($0.offset) }.map(\.element)
            let insertion = destination - indices.filter { $0 < destination }.count
            remaining.insert(contentsOf: moved, at: insertion)
            entries = remaining
        }
    }

    func movePriority(id: String, by offset: Int) {
        editPriority { entries in
            guard [-1, 1].contains(offset), let index = entries.firstIndex(where: { $0.id == id }),
                  entries.indices.contains(index + offset) else { return }
            entries.swapAt(index, index + offset)
        }
    }

    private func editPriority(_ edit: (inout [AudioInputDevice]) -> Void) {
        var next = preferences
        guard let index = next.profiles.firstIndex(where: { $0.id == next.activeProfileID }) else { return }
        edit(&next.profiles[index].priority)
        save(next)
    }

    private func validatedName(_ name: String, excluding id: String? = nil) -> Result<String, MicrophoneProfileError> {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return .failure(.emptyName) }
        guard !preferences.profiles.contains(where: { $0.id != id && $0.name.localizedCaseInsensitiveCompare(name) == .orderedSame }) else {
            return .failure(.duplicateName)
        }
        return .success(name)
    }

    private func save(_ value: MicrophonePreferences) {
        let value = value.normalized()
        guard value != preferences else { return }
        configuration.update { $0.microphones = value }
    }
}
