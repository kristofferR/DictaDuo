import Foundation
import DictaDuoAPI

/// An ephemeral server lease. Neither reconnect nor app launch selects this Mac.
@MainActor
final class RemoteButtonDestination {
    private struct Registration {
        let id: UUID
        let connection: ServerClient
        var acknowledgement: UUID?
    }
    private let connection: ServerClient
    private let device: DeviceIdentity
    private let available: () -> Bool
    private let receive: (ButtonCommand) -> Bool
    private let cancelled: () -> Void
    private let changed: (ButtonDestinationState?) -> Void
    private var registration: Registration?
    private var task: Task<Void, Never>?
    private var epoch = UUID()
    private var lastTick = Date()
    private var closed = false

    init(connection: ServerClient, device: DeviceIdentity, available: @escaping () -> Bool,
         receive: @escaping (ButtonCommand) -> Bool, cancelled: @escaping () -> Void,
         changed: @escaping (ButtonDestinationState?) -> Void) {
        self.connection = connection; self.device = device; self.available = available
        self.receive = receive; self.cancelled = cancelled; self.changed = changed
    }
    func start() {
        guard task == nil, !closed else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, !closed else { return }
                do { try await tick() } catch { disarm() }
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
            }
        }
    }
    func disarm() {
        epoch = UUID()
        let old = registration
        registration = nil; changed(nil); cancelled()
        if let old { Task { _ = try? await old.connection.buttonDestination("/\(old.id)", method: "DELETE") } }
    }
    func close() { closed = true; task?.cancel(); task = nil; disarm() }
    var registrationID: UUID? { registration?.id }

    func select(generationID: UUID? = nil, registrationID: UUID? = nil) async throws {
        guard let registration, available(), !closed, registrationID == nil || registrationID == registration.id else { throw ServerClientError.disconnected }
        let state = try await registration.connection.buttonDestination("/\(registration.id)/select",
            body: ServerClient.encode(SelectButtonDestination(generationID: generationID)))
        if self.registration?.id == registration.id { changed(state) }
    }
    func complete(_ ticket: UUID) {
        guard let registration else { return }
        Task { [weak self] in
            do {
                _ = try await registration.connection.buttonDestination("/\(registration.id)/complete",
                    body: ServerClient.encode(CompleteButtonTake(takeID: ticket)))
            } catch {
                if self?.registration?.id == registration.id { self?.disarm() }
            }
        }
    }
    func tick() async throws {
        let now = Date()
        let gap = now.timeIntervalSince(lastTick)
        defer { lastTick = Date() }
        guard gap >= 0, gap < 3, available(), !closed else { disarm(); return }
        let current = epoch
        if registration == nil {
            let candidate = Registration(id: UUID(), connection: try connection.owningDestination())
            let state = try await candidate.connection.buttonDestination(body: ServerClient.encode(RegisterButtonDestination(
                id: candidate.id, device: .init(id: device.id, name: device.name))))
            guard current == epoch, !closed, available(), !Task.isCancelled else {
                _ = try? await candidate.connection.buttonDestination("/\(candidate.id)", method: "DELETE")
                return
            }
            registration = candidate; changed(state)
        }
        guard let registration else { return }
        let state = try await registration.connection.buttonDestination("/\(registration.id)/heartbeat",
            body: ServerClient.encode(HeartbeatButtonDestination(acknowledgement: registration.acknowledgement)))
        guard current == epoch, !closed, available(), !Task.isCancelled else { return }
        changed(state)
        guard let command = state.command, command.id != registration.acknowledgement else { return }
        guard command.expiresAt > Date() else { disarm(); return }
        self.registration?.acknowledgement = command.id
        if !receive(command) { complete(command.takeID) }
    }
}
