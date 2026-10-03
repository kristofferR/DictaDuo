import AVFoundation
import CoreAudio
import Combine
import Foundation
import DictaDuoAPI
import DictaDuoCore
import XCTest
@testable import DictaDuo

final class DictationQueueTests: XCTestCase {
    @MainActor
    func testLaterDeliveriesProceedWhileEarlierReceiptResponsesArePending() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        fixture.server.holdDeliveryResponses = true
        for count in 1...3 {
            try await fixture.recordAndRelease()
            try await waitUntil { fixture.server.finishing.count == count }
        }
        let takes = fixture.server.created
        fixture.server.complete(takes[2], text: "Third take")
        fixture.server.complete(takes[1], text: "Second take")
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(fixture.server.deliveries.isEmpty)
        fixture.server.complete(takes[0], text: "First take")
        try await waitUntil { fixture.server.deliveries.count == 3 }
        XCTAssertEqual(Set(fixture.server.deliveries), Set(takes))
        XCTAssertEqual(fixture.deliveredTranscripts, ["First take", "Second take", "Third take"])
        XCTAssertEqual(fixture.controller.lastTranscript, "Third take")
        XCTAssertTrue(fixture.controller.isBusy, "Receipt requests remain owned by their pending takes")
        for take in takes.reversed() { fixture.server.releaseDelivery(take) }
        try await waitUntil { !fixture.controller.isBusy }
        XCTAssertEqual(fixture.controller.lastTranscript, "Third take")
    }

    @MainActor
    func testHandedBackTakeRestoresItsResultWhenItsReceiptSettles() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        fixture.server.holdDeliveryResponses = true
        for count in 1...2 {
            try await fixture.recordAndRelease()
            try await waitUntil { fixture.server.finishing.count == count }
        }
        let takes = fixture.server.created
        fixture.server.complete(takes[0], text: "First take")
        fixture.server.complete(takes[1], text: "Second take")
        try await waitUntil { fixture.server.deliveries.count == 2 }
        fixture.server.releaseDelivery(takes[1])
        try await waitUntil { fixture.controller.activity == .success }
        try await waitUntil { fixture.controller.statusMessage == "Earlier dictation is still processing" }
        // Both test receipts share a status and message, so only the take's identity tells them apart.
        fixture.server.releaseDelivery(takes[0])
        try await waitUntil { !fixture.controller.isBusy }
        XCTAssertEqual(fixture.controller.lastTranscript, "First take")
        XCTAssertEqual(fixture.controller.statusMessage, "Ready to copy")
    }

    @MainActor
    func testEscapeAfterInsertionDoesNotCancelTheTakeAwaitingItsReceipt() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        fixture.server.holdDeliveryResponses = true
        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 1 }
        let take = try XCTUnwrap(fixture.server.created.first)
        fixture.server.complete(take, text: "Inserted take")
        try await waitUntil { fixture.server.deliveries == [take] }
        fixture.controller.cancelDictation()
        fixture.server.releaseDelivery(take)
        try await waitUntil { !fixture.controller.isBusy }
        XCTAssertFalse(fixture.server.cancelled.contains(take))
        XCTAssertEqual(fixture.controller.activity, .success)
    }

    @MainActor
    func testAncillaryRefreshFailureAfterOlderReceiptDoesNotCancelNewCapture() async throws {
        for path in ["preferences", "generations"] {
            let fixture = try QueueControllerFixture()
            defer { fixture.close() }
            try await fixture.ready()
            try await fixture.recordAndRelease()
            try await waitUntil { fixture.server.finishing.count == 1 }
            let first = try XCTUnwrap(fixture.server.created.first)
            fixture.server.holdDeliveryResponses = true
            fixture.server.complete(first, text: "Earlier result")
            try await waitUntil { fixture.server.deliveries == [first] }

            fixture.controller.toggleTestRecording()
            try await waitUntil { fixture.controller.isRecording }
            let second = try XCTUnwrap(fixture.server.created.last)
            fixture.server.failedRefreshPath = path
            fixture.server.releaseDelivery(first)
            try await waitUntil { fixture.server.refreshFailures > 0 && !fixture.controller.isCheckingServer }
            XCTAssertTrue(fixture.controller.isRecording, "A failed \(path) refresh must not cancel the newer take")
            XCTAssertTrue(fixture.controller.isServerReady)
            XCTAssertFalse(fixture.server.cancelled.contains(second))
            fixture.controller.cancelDictation()
        }
    }

    @MainActor
    func testCancellingReleasedTakeBeforeStopRunsCancelsItsTransferredTeardown() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        fixture.controller.toggleTestRecording()
        try await waitUntil { fixture.controller.isRecording }
        try await Task.sleep(for: .milliseconds(275))
        let first = try XCTUnwrap(fixture.server.created.first)
        fixture.controller.toggleTestRecording()
        // An undoable cancel would keep the released take; discarding must reach its teardown.
        fixture.controller.cancelDictation(undoable: false)
        try await waitUntil {
            fixture.server.cancelled.contains(first) && !fixture.controller.isBusy && fixture.hardware.stoppedRequest != nil
        }
        XCTAssertTrue(try XCTUnwrap(fixture.hardware.stoppedRequest).isCancelled,
                      "Cancelling the pending take must reach its independent recorder stop task")
        XCTAssertFalse(fixture.server.finishing.contains(first))
        fixture.controller.toggleTestRecording()
        try await waitUntil { fixture.controller.isRecording }
        fixture.controller.cancelDictation()
    }

    @MainActor
    func testReleasedTakesUploadIndependentlyAndDeliverInRecordingOrder() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 1 }
        let first = try XCTUnwrap(fixture.server.created.first)

        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 2 }
        let second = try XCTUnwrap(fixture.server.created.last)
        XCTAssertNotEqual(first, second)
        XCTAssertTrue(fixture.controller.canTest, "A server queue must not disable the next recording")

        fixture.server.complete(second, text: "Second take")
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(fixture.server.deliveries.isEmpty, "A fast later result must wait for the earlier destination transaction")
        fixture.server.complete(first, text: "First take")
        try await waitUntil { fixture.server.deliveries.count == 2 && !fixture.controller.isBusy }
        XCTAssertEqual(Set(fixture.server.deliveries), Set([first, second]))
        XCTAssertEqual(fixture.deliveredTranscripts, ["First take", "Second take"])
        XCTAssertEqual(fixture.controller.lastTranscript, "Second take")
        XCTAssertEqual(fixture.controller.activity, .success)
        XCTAssertNil(fixture.controller.errorMessage)
    }

    @MainActor
    func testOlderCompletionCannotReplaceNewRecordingState() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 1 }
        let first = try XCTUnwrap(fixture.server.created.first)

        fixture.controller.toggleTestRecording()
        try await waitUntil { fixture.controller.isRecording }
        fixture.server.complete(first, text: "Earlier result")
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(fixture.controller.isRecording)
        XCTAssertEqual(fixture.controller.statusMessage, "Listening")
        XCTAssertTrue(fixture.server.deliveries.isEmpty, "Delivery waits for the active capture to release")
        XCTAssertNil(fixture.controller.errorMessage)
        fixture.controller.cancelDictation()
        try await waitUntil { fixture.server.deliveries == [first] && !fixture.controller.isBusy }
        XCTAssertEqual(fixture.controller.lastTranscript, "Earlier result")
    }

    @MainActor
    func testSameTurnRepressAndCancelCannotDiscardReleasedAudio() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        fixture.controller.toggleTestRecording()
        try await waitUntil { fixture.controller.isRecording }
        try await Task.sleep(for: .milliseconds(275))
        let first = try XCTUnwrap(fixture.server.created.first)

        // No suspension between release, repress, and cancel: the old stop task
        // has not run yet, so a shared recorder request would be stolen here.
        fixture.controller.toggleTestRecording()
        fixture.controller.toggleTestRecording()
        XCTAssertEqual(fixture.controller.activity, .starting)
        fixture.controller.cancelDictation()
        try await waitUntil { fixture.server.finishing.contains(first) }
        XCTAssertFalse(fixture.server.cancelled.contains(first))
        fixture.server.complete(first, text: "Keep these words")
        try await waitUntil { fixture.server.deliveries == [first] && !fixture.controller.isBusy }
        XCTAssertEqual(fixture.controller.lastTranscript, "Keep these words")
        XCTAssertNil(fixture.controller.errorMessage)
    }

    @MainActor
    func testCancellingLatestQueuedTakePreservesEarlierWork() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 1 }
        let first = try XCTUnwrap(fixture.server.created.first)
        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 2 }
        let second = try XCTUnwrap(fixture.server.created.last)

        // Cancelling a queued take keeps it in history instead of discarding it.
        fixture.controller.cancelDictation()
        XCTAssertTrue(fixture.controller.isUndoPending)
        fixture.controller.keepCancelledTake()
        fixture.server.complete(first, text: "Earlier take survives")
        fixture.server.complete(second, text: "Kept only")
        try await waitUntil { fixture.server.deliveries.count == 2 && !fixture.controller.isBusy }
        XCTAssertTrue(fixture.server.cancelled.isEmpty)
        XCTAssertEqual(fixture.server.deliveries, [first, second])
        XCTAssertEqual(fixture.server.receipt(first), "tested")
        XCTAssertEqual(fixture.server.receipt(second), "cancelled")
        XCTAssertEqual(fixture.controller.lastTranscript, "Earlier take survives")
        XCTAssertNil(fixture.controller.errorMessage)
    }

    @MainActor
    func testCancellingMiddleTakeDoesNotLetLaterDeliveryOvertakeEarlierWork() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 1 }
        let first = try XCTUnwrap(fixture.server.created.first)
        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 2 }
        let kept = try XCTUnwrap(fixture.server.created.last)
        fixture.controller.cancelDictation()
        fixture.controller.keepCancelledTake()

        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 3 }
        let third = try XCTUnwrap(fixture.server.created.last)
        fixture.server.complete(third, text: "Third take")
        fixture.server.complete(kept, text: "Kept only")
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(fixture.server.deliveries.isEmpty, "A kept middle take must retain its preceding delivery dependency")
        fixture.server.complete(first, text: "First take")
        try await waitUntil { fixture.server.deliveries.count == 3 && !fixture.controller.isBusy }
        XCTAssertEqual(Set(fixture.server.deliveries), Set([first, kept, third]))
        XCTAssertEqual(fixture.deliveredTranscripts, ["First take", "Third take"])
        XCTAssertEqual(fixture.server.receipt(kept), "cancelled")
        XCTAssertEqual(fixture.controller.lastTranscript, "Third take")
    }

    @MainActor
    func testQueuedTakesDoNotReuseTheSameDeliveredListContinuation() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 1 }
        let delivered = try XCTUnwrap(fixture.server.created.first)
        fixture.server.complete(delivered, text: "1. First item", listNextNumber: 2)
        try await waitUntil { fixture.server.deliveries == [delivered] && !fixture.controller.isBusy }

        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 2 }
        let second = try XCTUnwrap(fixture.server.created.last)
        XCTAssertEqual(fixture.server.finishValue(second)?.continuationID, delivered)
        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 3 }
        let third = try XCTUnwrap(fixture.server.created.last)
        XCTAssertNil(fixture.server.finishValue(third)?.continuationID,
                     "A queued take must not independently extend the same old numbered-list snapshot")
        XCTAssertEqual(fixture.server.deliveries, [delivered], "Uploading and sealing must not wait for the preceding result")
        fixture.server.complete(second, text: "2. Second item", listNextNumber: 3)
        fixture.server.complete(third, text: "Third take")
        try await waitUntil { fixture.server.deliveries.count == 3 && !fixture.controller.isBusy }
    }

    @MainActor
    func testOlderFailureIsVisibleWithoutReplacingTheActiveRecording() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 1 }
        let first = try XCTUnwrap(fixture.server.created.first)
        fixture.controller.toggleTestRecording()
        try await waitUntil { fixture.controller.isRecording }
        fixture.server.fail(first, message: "Speech processing failed")
        try await waitUntil { fixture.controller.errorMessage?.contains("Speech processing failed") == true }
        XCTAssertEqual(fixture.controller.activity, .recording)
        XCTAssertEqual(fixture.controller.statusMessage, "Listening")
        XCTAssertEqual(fixture.controller.lastDeliveryStatus, .failed)
        XCTAssertTrue(fixture.controller.lastDelivery.contains("Earlier dictation failed"))
        XCTAssertTrue(fixture.server.deliveries.isEmpty)
        fixture.controller.cancelDictation()
    }

    @MainActor
    func testNewerSuccessClearsOlderFailureMessage() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        for count in 1...2 {
            try await fixture.recordAndRelease()
            try await waitUntil { fixture.server.finishing.count == count }
        }
        let takes = fixture.server.created
        fixture.server.fail(takes[0], message: "Speech processing failed")
        try await waitUntil { fixture.controller.errorMessage?.contains("Speech processing failed") == true }
        fixture.server.complete(takes[1], text: "Second take")
        try await waitUntil { fixture.server.deliveries == [takes[1]] && !fixture.controller.isBusy }
        XCTAssertEqual(fixture.controller.activity, .success)
        XCTAssertNil(fixture.controller.errorMessage)
    }

    @MainActor
    func testDismissingNewerFailureKeepsEarlierTakeAndReturnsHUDToIt() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 1 }
        let first = try XCTUnwrap(fixture.server.created.first)
        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 2 }
        let second = try XCTUnwrap(fixture.server.created.last)

        fixture.server.fail(second, message: "Second failed")
        try await waitUntil { fixture.controller.activity == .failed }
        fixture.controller.cancelDictation()
        XCTAssertFalse(fixture.server.cancelled.contains(first), "Dismissing a newer failure must not cancel older work")
        XCTAssertEqual(fixture.controller.activity, .transcribing)
        fixture.server.complete(first, text: "First take")
        try await waitUntil { fixture.server.deliveries == [first] && !fixture.controller.isBusy }
        XCTAssertEqual(fixture.controller.activity, .success)
        XCTAssertEqual(fixture.controller.lastTranscript, "First take")
    }

    @MainActor
    func testDismissingUnrelatedStartErrorDoesNotCancelPendingTake() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 1 }
        let first = try XCTUnwrap(fixture.server.created.first)

        fixture.controller.permissions = PermissionSnapshot(microphone: false, accessibility: false, inputMonitoring: false)
        fixture.controller.toggleTestRecording()
        // The fork checks local microphone access after resolving the input.
        try await waitUntil { fixture.controller.activity == .failed }
        fixture.controller.cancelDictation()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(fixture.server.cancelled.contains(first))
        fixture.server.complete(first, text: "First take")
        try await waitUntil { fixture.server.deliveries == [first] && !fixture.controller.isBusy }
    }

    @MainActor
    func testRepeatedCancellationKeepsTheTakeAndAllowsAnotherHold() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 1 }
        let first = try XCTUnwrap(fixture.server.created.first)
        try await fixture.recordAndRelease()
        try await waitUntil { fixture.server.finishing.count == 2 }
        let second = try XCTUnwrap(fixture.server.created.last)

        fixture.controller.cancelDictation()
        XCTAssertTrue(fixture.controller.isUndoPending)
        try await Task.sleep(for: .milliseconds(350))
        // A separate, later cancel closes the window and keeps the take.
        fixture.controller.cancelDictation()
        XCTAssertFalse(fixture.controller.isUndoPending)
        fixture.server.complete(first, text: "First take")
        fixture.server.complete(second, text: "Kept only")
        try await waitUntil { fixture.server.deliveries.count == 2 && !fixture.controller.isBusy }
        XCTAssertTrue(fixture.server.cancelled.isEmpty)
        XCTAssertEqual(fixture.server.receipt(second), "cancelled")
        XCTAssertEqual(fixture.controller.lastTranscript, "First take")
        fixture.controller.toggleTestRecording()
        try await waitUntil { fixture.controller.isRecording }
        fixture.controller.cancelDictation(undoable: false)
    }
}

extension DictationQueueTests {
    @MainActor
    func testCancelledTakeIsKeptInHistoryWithoutDelivering() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        fixture.controller.toggleTestRecording()
        try await waitUntil { fixture.controller.isRecording }
        try await Task.sleep(for: .milliseconds(275))
        fixture.controller.cancelDictation()
        XCTAssertTrue(fixture.controller.isUndoPending)
        let id = try XCTUnwrap(fixture.server.created.first)
        try await waitUntil { fixture.server.finishing.contains(id) }
        XCTAssertFalse(fixture.server.cancelled.contains(id), "A cancelled take is still sealed and transcribed")
        fixture.controller.keepCancelledTake()
        XCTAssertFalse(fixture.controller.isUndoPending)
        fixture.server.complete(id, text: "Kept words")
        try await waitUntil { fixture.server.receipt(id) != nil && !fixture.controller.isBusy }
        XCTAssertEqual(fixture.server.receipt(id), "cancelled")
        XCTAssertEqual(fixture.controller.lastDeliveryStatus, .kept)
        XCTAssertNotEqual(fixture.controller.lastTranscript, "Kept words")
    }

    @MainActor
    func testUndoDeliversACancelledTakeAsUsual() async throws {
        let fixture = try QueueControllerFixture()
        defer { fixture.close() }
        try await fixture.ready()
        fixture.controller.toggleTestRecording()
        try await waitUntil { fixture.controller.isRecording }
        try await Task.sleep(for: .milliseconds(275))
        fixture.controller.cancelDictation()
        // The same Escape reaching a second handler must not close the window.
        fixture.controller.cancelDictation()
        XCTAssertTrue(fixture.controller.isUndoPending)
        let id = try XCTUnwrap(fixture.server.created.first)
        try await waitUntil { fixture.server.finishing.contains(id) }
        fixture.controller.undoCancellation()
        fixture.server.complete(id, text: "Undone words")
        try await waitUntil { fixture.server.receipt(id) != nil && !fixture.controller.isBusy }
        XCTAssertEqual(fixture.server.receipt(id), "tested")
        XCTAssertEqual(fixture.controller.lastTranscript, "Undone words")
    }
}

@MainActor
private func waitUntil(_ predicate: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
    let deadline = ContinuousClock.now + .seconds(5)
    while !predicate(), ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertTrue(predicate(), "Timed out waiting for dictation state", file: file, line: line)
    if !predicate() { throw URLError(.timedOut) }
}

@MainActor
private final class QueueControllerFixture {
    let server = QueueHTTPFixture()
    let hardware = QueueAudioHardware()
    let controller: DictaDuoController
    private(set) var deliveredTranscripts: [String] = []
    private var transcriptSubscription: AnyCancellable?
    private let root = FileManager.default.temporaryDirectory.appendingPathComponent("DictaDuo-queue-tests-\(UUID())")

    init() throws {
        let server = server
        let device = AudioInputDevice(uid: "queue-test", name: "Synthetic microphone", transport: .usb)
        let devices = AudioDeviceStore(hardware: AudioHardwareClient(snapshot: {
            AudioHardwareSnapshot(deviceIDs: [42], inputs: [AudioInputHandle(deviceID: 42, device: device)], systemDefaultID: 42)
        }, observe: { _, _, _, _ in nil }))
        devices.start()
        let hardware = hardware
        let recorder = AudioRecorder(worker: AudioCaptureWorker(makeHardware: { _ in hardware }),
                                     microphoneAuthorized: { true }, sleepNotifications: NotificationCenter())
        let configuration = ConfigurationStore(file: ConfigurationFile(url: root.appendingPathComponent("config.json")))
        controller = DictaDuoController(configuration: configuration, startServices: false,
                                   recorder: recorder, audioDevices: devices,
                                   serverClient: { try ServerClient(endpoint: server.endpoint, token: "", session: server.session) },
                                   recordingSocket: { request in try server.socket(for: request) })
        controller.microphones.update(devices: [device], systemDefaultUID: device.uid)
        controller.permissions = PermissionSnapshot(microphone: true, accessibility: false, inputMonitoring: false)
        transcriptSubscription = controller.$lastTranscript.filter { !$0.isEmpty }.sink { [weak self] text in
            self?.deliveredTranscripts.append(text)
        }
    }

    func ready() async throws {
        controller.refreshServer()
        try await waitUntil { self.controller.canTest }
    }

    func recordAndRelease() async throws {
        controller.toggleTestRecording()
        do { try await waitUntil { self.controller.isRecording } }
        catch { XCTFail("Not recording: \(controller.statusMessage) · \(controller.errorMessage ?? "")"); throw error }
        try await Task.sleep(for: .milliseconds(275))
        controller.toggleTestRecording()
    }

    func close() {
        controller.shutdown()
        // Shutdown submits best-effort server cancellation tasks. Their captured
        // clients keep this session alive until those requests have been sent.
        try? FileManager.default.removeItem(at: root)
    }
}

private final class QueueAudioHardware: AudioCaptureHardware, @unchecked Sendable {
    private var writer: RecordingWriter?
    private var request: AudioCaptureRequest?
    private let lock = NSLock()
    private var lastStoppedRequest: AudioCaptureRequest?
    var stoppedRequest: AudioCaptureRequest? { lock.withLock { lastStoppedRequest } }

    func start(request: AudioCaptureRequest, deviceID: AudioDeviceID?, preserveOriginalAudio: Bool,
               onLevel: @escaping @Sendable (Float) -> Void,
               onInterruption: @escaping @Sendable (String) -> Void) throws {
        try request.requireOpen()
        self.request = request
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let writer = try RecordingWriter(inputFormat: format, preserveOriginalAudio: preserveOriginalAudio,
                                         onLevel: { _ in }, onError: { _ in }, onChunk: request.onChunk, spool: request.spool)
        self.writer = writer
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8_000))
        buffer.frameLength = 8_000
        try XCTUnwrap(buffer.floatChannelData)[0].initialize(repeating: 0.1, count: 8_000)
        writer.append(buffer)
    }

    func stop() -> RecordingWriter? {
        lock.withLock { lastStoppedRequest = request }
        request = nil
        defer { writer = nil }
        return writer
    }

    func cancel() { writer?.cancel(); writer = nil }
}

/// A v2 recording server in memory. HTTP admission/history/receipts use the
/// real URLSession client; each session's WebSocket is an interactive fake that
/// acknowledges audio and completes only when a test says so.
private final class QueueHTTPFixture: @unchecked Sendable {
    struct FinishValue { let continuationID: UUID? }
    let id = UUID().uuidString.lowercased()
    let session: URLSession
    var endpoint: String { "https://\(id).queue-test" }
    private let lock = NSLock()
    private var snapshots: [UUID: RecordingSnapshot] = [:]
    private var order: [UUID] = []
    private var results: [UUID: GenerationRecord] = [:]
    private var contexts: [UUID: UUID] = [:]
    private var stopped = Set<UUID>()
    private var sockets: [UUID: [QueueRecordingSocket]] = [:]
    private var delivered: [UUID] = []
    private var receiptStatuses: [UUID: String] = [:]
    private var discards: [UUID] = []
    var created: [UUID] { lock.withLock { order } }
    var finishing: Set<UUID> { lock.withLock { stopped } }
    private var heldDeliveries: [UUID: QueueURLProtocol] = [:]
    private var holdingDeliveries = false
    private var refreshFailurePath: String?
    private var failedRefreshes = 0
    var holdDeliveryResponses: Bool {
        get { lock.withLock { holdingDeliveries } }
        set { lock.withLock { holdingDeliveries = newValue } }
    }
    var failedRefreshPath: String? {
        get { lock.withLock { refreshFailurePath } }
        set { lock.withLock { refreshFailurePath = newValue } }
    }
    var refreshFailures: Int { lock.withLock { failedRefreshes } }
    var deliveries: [UUID] { lock.withLock { delivered } }
    var cancelled: [UUID] { lock.withLock { discards } }
    func receipt(_ id: UUID) -> String? { lock.withLock { receiptStatuses[id] } }
    func finishValue(_ id: UUID) -> FinishValue? {
        lock.withLock { stopped.contains(id) ? FinishValue(continuationID: contexts[id]) : nil }
    }

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [QueueURLProtocol.self]
        session = URLSession(configuration: configuration)
        QueueURLProtocol.register(self)
    }

    deinit { QueueURLProtocol.unregister(id) }

    func releaseDelivery(_ id: UUID) {
        let response = lock.withLock { heldDeliveries.removeValue(forKey: id) }
        response?.respondEmpty()
    }

    func socket(for request: URLRequest) throws -> any RecordingSocket {
        let parts = try XCTUnwrap(request.url).pathComponents
        let recording = try XCTUnwrap(UUID(uuidString: parts[3]))
        let socket = QueueRecordingSocket(fixture: self, recording: recording)
        lock.withLock { sockets[recording, default: []].append(socket) }
        return socket
    }

    func complete(_ id: UUID, text: String, listNextNumber: Int? = nil) {
        finishProcessing(id) { snapshot in
            snapshot.processingState = .completed
            var result = ServerClient.generationSummary(snapshot)
            result.status = .completed
            result.finalText = text
            result.insertionText = text
            if let listNextNumber {
                result.continuation = .init(list: .init(style: .numbered, nextNumber: listNextNumber),
                                            preview: text, boundary: .line)
            }
            return result
        }
    }

    func fail(_ id: UUID, message: String) {
        finishProcessing(id) { snapshot in
            snapshot.processingState = .failed
            snapshot.error = message
            return nil
        }
    }

    private func finishProcessing(_ id: UUID, _ update: (inout RecordingSnapshot) -> GenerationRecord?) {
        let (message, targets) = lock.withLock { () -> (RecordingServerMessage?, [QueueRecordingSocket]) in
            guard var snapshot = snapshots[id] else { return (nil, []) }
            snapshot.revision += 1
            results[id] = update(&snapshot)
            snapshots[id] = snapshot
            return (.progress(snapshot), sockets[id] ?? [])
        }
        if let message { targets.forEach { $0.push(message) } }
    }

    /// Applies one client control or audio message and returns the server reply.
    fileprivate func handle(_ recording: UUID, control: RecordingClientMessage?, audio: RecordingAudioMessage?) -> RecordingServerMessage? {
        lock.withLock {
            guard var snapshot = snapshots[recording] else {
                return .error(.init(code: "not_found", message: "Recording not found.", retryable: false))
            }
            snapshot.revision += 1
            defer { snapshots[recording] = snapshot }
            if let audio {
                let header = audio.header
                let index = snapshot.streams.firstIndex { $0.runID == header.runID && $0.kind == header.kind }
                var stream = index.map { snapshot.streams[$0] }
                    ?? RecordingStreamCheckpoint(runID: header.runID, kind: header.kind, format: header.format)
                stream.nextSequence = header.sequence + 1
                stream.frameCount = header.firstFrame + header.frameCount
                if let index { snapshot.streams[index] = stream } else { snapshot.streams.append(stream) }
                if header.kind == .inference { snapshot.uploadedFrames = snapshot.streams.filter { $0.kind == .inference }.reduce(0) { $0 + $1.frameCount } }
                return .ack(.init(runID: header.runID, kind: header.kind, nextSequence: stream.nextSequence,
                                  frameCount: stream.frameCount, revision: snapshot.revision))
            }
            switch control {
            case .resume:
                snapshot.epoch += 1
                return .snapshot(snapshot)
            case .context(let request):
                contexts[recording] = request.continuationID
                snapshot.continuationID = request.continuationID
                return .snapshot(snapshot)
            case .pause(let request):
                snapshot.closedRuns = (snapshot.closedRuns ?? []) + request.runs.filter { !(snapshot.closedRuns ?? []).contains($0) }
                snapshot.runTimings = request.runTimings
                snapshot.captureState = .interrupted
                return .snapshot(snapshot)
            case .stop(let request):
                stopped.insert(recording)
                snapshot.stopRuns = request.runs
                snapshot.captureState = .stopped
                if snapshot.processingState == .queued { snapshot.processingState = .processing }
                return .progress(snapshot)
            case .ping, .none:
                return .snapshot(snapshot)
            }
        }
    }

    func handle(_ transport: QueueURLProtocol) throws {
        let request = transport.request
        let parts = request.url!.pathComponents
        let failRefresh = lock.withLock {
            guard request.httpMethod == "GET", parts.last == refreshFailurePath else { return false }
            failedRefreshes += 1
            return true
        }
        if failRefresh { transport.respondEmpty(status: 503); return }
        if parts.last == "health" {
            let model = ModelRuntimeInfo(modelID: "test", backend: "test", ready: true)
            transport.respond(ServerHealth(ready: true, speech: model, proofreading: model))
        } else if parts.last == "preferences" {
            transport.respond(PreferencesSnapshot())
        } else if parts == ["/", "v1", "generations"] {
            transport.respond(GenerationPage(items: []))
        } else if parts == ["/", "v2", "recordings", "capabilities"] {
            transport.respondWire(RecordingCapabilities())
        } else if parts == ["/", "v2", "recordings"], request.httpMethod == "POST" {
            let create = try RecordingWire.decoder().decode(CreateGenerationRequest.self, from: body(request))
            let snapshot = RecordingSnapshot(id: UUID(), requestID: create.requestID, device: create.device,
                                             mode: create.mode, settings: .init())
            lock.withLock { snapshots[snapshot.id] = snapshot; order.append(snapshot.id) }
            transport.respondWire(snapshot)
        } else if parts == ["/", "v2", "recordings"] {
            transport.respondWire(RecordingPage(items: lock.withLock { order.compactMap { snapshots[$0] } }))
        } else if parts.count >= 4, parts[1] == "v2", let id = UUID(uuidString: parts[3]) {
            switch parts.count == 4 ? "detail" : parts.last {
            case "detail":
                let detail = lock.withLock { snapshots[id].map { RecordingDetail(snapshot: $0, result: results[id]) } }
                if let detail { transport.respondWire(detail) } else { transport.respondEmpty(status: 404) }
            case "discard":
                lock.withLock { discards.append(id) }
                transport.respondEmpty()
            case "delivery":
                let receipt = try RecordingWire.decoder().decode(DeliveryReceipt.self, from: body(request))
                let held = lock.withLock {
                    delivered.append(id); receiptStatuses[id] = receipt.status
                    if holdingDeliveries { heldDeliveries[id] = transport }
                    return holdingDeliveries
                }
                if !held { transport.respondEmpty() }
            default: transport.respondEmpty(status: 404)
            }
        } else { transport.respondEmpty(status: 404) }
    }

    private func body(_ request: URLRequest) throws -> Data {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 8192)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

/// One fake WebSocket connection; replies are queued in arrival order.
private final class QueueRecordingSocket: RecordingSocket, @unchecked Sendable {
    private let fixture: QueueHTTPFixture
    private let recording: UUID
    private let lock = NSLock()
    private var inbox: [RecordingServerMessage] = []
    private var closed = false

    init(fixture: QueueHTTPFixture, recording: UUID) { self.fixture = fixture; self.recording = recording }

    func push(_ message: RecordingServerMessage) { lock.withLock { if !closed { inbox.append(message) } } }

    func send(binary: Data) async throws {
        if let reply = fixture.handle(recording, control: nil, audio: try RecordingWire.decodeAudio(binary)) { push(reply) }
    }

    func send(control: Data) async throws {
        let message = try RecordingWire.decoder().decode(RecordingClientMessage.self, from: control)
        if let reply = fixture.handle(recording, control: message, audio: nil) { push(reply) }
    }

    func receive() async throws -> Data {
        while true {
            let next = try lock.withLock { () -> RecordingServerMessage? in
                if closed { throw URLError(.networkConnectionLost) }
                return inbox.isEmpty ? nil : inbox.removeFirst()
            }
            if let next { return try RecordingWire.encoder().encode(next) }
            try await Task.sleep(for: .milliseconds(2))
        }
    }

    func close() { lock.withLock { closed = true } }
}

private final class QueueURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var fixtures: [String: WeakFixture] = [:]
    private struct WeakFixture { weak var value: QueueHTTPFixture? }
    private let responseLock = NSLock()
    private var stopped = false
    static func register(_ fixture: QueueHTTPFixture) { lock.withLock { fixtures[fixture.id] = WeakFixture(value: fixture) } }
    static func unregister(_ id: String) { _ = lock.withLock { fixtures.removeValue(forKey: id) } }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".queue-test") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let id = String((request.url?.host ?? "").dropLast(".queue-test".count))
        guard let fixture = Self.lock.withLock({ Self.fixtures[id]?.value }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost)); return
        }
        do { try fixture.handle(self) }
        catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() { responseLock.withLock { stopped = true } }

    func respond<T: APIWireModel>(_ value: T) {
        do { respondData(try DictaDuoAPI.encodeWire(value), status: 200) }
        catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    func respondWire<T: Encodable>(_ value: T) {
        do { respondData(try RecordingWire.encoder().encode(value), status: 200) }
        catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    func respondEmpty(status: Int = 200) { respondData(Data(), status: status) }
    private func respondData(_ data: Data, status: Int) {
        let shouldRespond = responseLock.withLock {
            guard !stopped else { return false }
            stopped = true
            return true
        }
        guard shouldRespond else { return }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

