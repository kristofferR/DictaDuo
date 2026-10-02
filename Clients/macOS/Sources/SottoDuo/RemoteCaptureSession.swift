import Foundation
import SottoDuoAPI

/// One owned take. Event loss never reconnects or authorizes delayed insertion.
@MainActor
final class RemoteCaptureSession {
    let id: UUID
    let source: AudioSourceIdentity
    let connection: ServerClient
    /// Reserve five seconds for drain and one for the stop request before the
    /// server's 180-second admission deadline. Use the client's earlier send time.
    let stopAt: TimeInterval
    private(set) var isSealed = false
    private(set) var sealMayHaveSucceeded = false
    var shouldCancelServer: Bool { !isSealed && !sealMayHaveSucceeded }
    private var stopping = false
    private var cancelled = false
    private var leaseTask: Task<Void, Never>?
    private var eventTask: Task<GenerationRecord, Error>?

    init(record: GenerationRecord, connection: ServerClient, requestedAt: TimeInterval) throws {
        guard record.status == .receiving, let capture = record.capture, capture.state == .recording else {
            throw ServerClientError.invalidResponse
        }
        id = record.id; source = capture.source; self.connection = connection
        stopAt = requestedAt + 174
    }

    func monitor(onUpdate: @escaping @MainActor (GenerationRecord) -> Void,
                 onFailure: @escaping @MainActor (Error) -> Void) {
        eventTask = Task { [weak self, connection, id] in
            do {
                return try await connection.events(id) { [weak self] record in
                    await self?.receive(record, onUpdate: onUpdate, onFailure: onFailure)
                }
            } catch {
                if let self, !cancelled, !Task.isCancelled { onFailure(error) }
                throw error
            }
        }
        leaseTask = Task { [weak self, connection, id] in
            var consecutiveFailures = 0
            while !Task.isCancelled {
                do {
                    try await connection.heartbeat(id)
                    consecutiveFailures = 0
                    try await Task.sleep(for: .seconds(1))
                } catch {
                    guard let self, !cancelled, !isSealed, !Task.isCancelled else { return }
                    // A heartbeat can race the seal acknowledgement on the event stream.
                    if stopping, let record = try? await connection.generation(id, timeout: 1),
                       record.capture?.state == .sealed, record.capture?.source == source {
                        markSealed(); return
                    }
                    guard !cancelled, !isSealed, !Task.isCancelled else { return }
                    // One immediate, one-second retry fits inside the six-second lease.
                    // An explicit server rejection (including source loss) is final.
                    consecutiveFailures += 1
                    if error is URLError, consecutiveFailures == 1 { continue }
                    onFailure(error)
                    return
                }
            }
        }
    }

    private func receive(_ record: GenerationRecord, onUpdate: @MainActor (GenerationRecord) -> Void,
                         onFailure: @MainActor (Error) -> Void) {
        guard !cancelled else { return }
        guard record.capture?.source == source else { onFailure(ServerClientError.invalidResponse); return }
        if record.capture?.state == .sealed { markSealed() }
        if record.capture?.state == .stopped || (!stopping && record.status != .receiving) {
            onFailure(ServerClientError.captureUnavailable(record.error ?? "The remote microphone stopped. Try another take."))
            return
        }
        onUpdate(record)
    }

    func stop(continuationID: UUID?, onSealed: () -> Void = {}) async throws -> GenerationRecord {
        stopping = true
        sealMayHaveSucceeded = true
        let record = try await connection.stopCapture(id, continuationID: continuationID)
        guard !cancelled, !Task.isCancelled else { throw CancellationError() }
        guard record.capture?.state == .sealed, record.capture?.source == source else {
            throw ServerClientError.invalidResponse
        }
        markSealed()
        onSealed()
        if record.status.isTerminal {
            eventTask?.cancel(); eventTask = nil
            return record
        }
        guard let eventTask else { throw ServerClientError.disconnected }
        return try await eventTask.value
    }

    private func markSealed() {
        isSealed = true
        leaseTask?.cancel(); leaseTask = nil
    }

    func cancelMonitoring() {
        cancelled = true
        leaseTask?.cancel(); leaseTask = nil
        eventTask?.cancel(); eventTask = nil
    }

    deinit { leaseTask?.cancel(); eventTask?.cancel() }
}
