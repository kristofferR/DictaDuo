import Foundation
import DictaDuoAPI

/// One owned take on a recording session that a server-hosted microphone feeds.
/// Event loss while recording never reconnects or authorizes delayed insertion.
@MainActor
final class RemoteCaptureSession {
    let id: UUID
    let source: AudioSourceIdentity
    let connection: ServerClient
    /// The server holds the take's audio: sealed by stop, or kept after an interruption.
    private(set) var isSealed = false
    private(set) var sealMayHaveSucceeded = false
    var shouldCancelServer: Bool { !isSealed && !sealMayHaveSucceeded }
    private var stopping = false
    private var cancelled = false
    private var leaseTask: Task<Void, Never>?
    private var eventTask: Task<Void, Never>?
    private var onUpdate: (@MainActor (RecordingSnapshot) -> Void)?

    init(snapshot: RecordingSnapshot, connection: ServerClient) throws {
        guard snapshot.captureState == .recording, let capture = snapshot.capture, capture.state == .recording else {
            throw ServerClientError.invalidResponse
        }
        id = snapshot.id; source = capture.source; self.connection = connection
    }

    func monitor(onUpdate: @escaping @MainActor (RecordingSnapshot) -> Void,
                 onFailure: @escaping @MainActor (Error) -> Void) {
        self.onUpdate = onUpdate
        eventTask = Task { [weak self, connection, id] in
            do {
                _ = try await connection.recordingEvents(id, recover: false) { [weak self] snapshot in
                    await self?.receive(snapshot, onFailure: onFailure)
                }
            } catch {
                // After stop, the seal response and the processing stream decide.
                guard let self, !cancelled, !stopping, !Task.isCancelled else { return }
                onFailure(error)
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
                    if stopping, let snapshot = try? await connection.recording(id),
                       snapshot.capture?.state == .sealed, snapshot.capture?.source == source {
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

    private func receive(_ snapshot: RecordingSnapshot, onFailure: @MainActor (Error) -> Void) {
        guard !cancelled else { return }
        guard snapshot.capture?.source == source else { onFailure(ServerClientError.invalidResponse); return }
        if snapshot.capture?.state == .sealed { markSealed() }
        if !stopping {
            if snapshot.capture?.state == .stopped, snapshot.captureState != .discarded {
                // The server sealed what was captured and finishes it archive-only.
                markSealed()
                let reason = snapshot.error ?? "The shared mic stopped."
                onFailure(ServerClientError.captureUnavailable("\(reason) The recording is saved in history."))
                return
            }
            if snapshot.processingState == .failed, snapshot.captureState == .recording {
                // Recognition gave up mid-take: seal what was captured and keep it for retry.
                markSealed()
                Task { [connection, id] in _ = try? await connection.stopCapture(id, continuationID: nil) }
                onFailure(ServerClientError.captureUnavailable(snapshot.error ?? "Recognition failed. The recording is saved in history."))
                return
            }
            if snapshot.captureState != .recording {
                onFailure(ServerClientError.captureUnavailable(snapshot.error ?? "The shared mic stopped. Try another take."))
                return
            }
        }
        onUpdate?(snapshot)
    }

    /// Seals the take, then follows its processing to the materialized result.
    func stop(continuationID: UUID?, onSealed: () -> Void = {}) async throws -> GenerationRecord {
        stopping = true
        sealMayHaveSucceeded = true
        let sealed = try await connection.stopCapture(id, continuationID: continuationID)
        guard !cancelled, !Task.isCancelled else { throw CancellationError() }
        guard sealed.capture?.state == .sealed, sealed.capture?.source == source else {
            throw ServerClientError.invalidResponse
        }
        markSealed()
        onSealed()
        // The audio is durable now; processing may outlast a connection.
        eventTask?.cancel(); eventTask = nil
        if !sealed.isSettled {
            _ = try await connection.recordingEvents(id) { [weak self] snapshot in
                await self?.forward(snapshot)
            }
        }
        guard !cancelled, !Task.isCancelled else { throw CancellationError() }
        return try await connection.materializedRecording(id)
    }

    private func forward(_ snapshot: RecordingSnapshot) {
        guard !cancelled else { return }
        onUpdate?(snapshot)
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
