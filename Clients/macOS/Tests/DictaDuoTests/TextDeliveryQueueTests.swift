import AppKit
import XCTest
@testable import DictaDuo

final class TextDeliveryQueueTests: XCTestCase {
    @MainActor
    func testRebaseCutoffIncludesTakeCapturedDuringDeferredValidation() async throws {
        for strategy in [TextDeliveryStrategy.nativeSelection, .keyboardPaste] {
            let fixture = QueuedDeliveryFixture()
            defer { fixture.pasteboard.releaseGlobally() }
            fixture.captureOnValidation = strategy == .nativeSelection ? 1 : 2
            let outcome = await fixture.deliver(strategy: strategy)
            XCTAssertEqual(outcome, .inserted)
            let capturedAt = Double(try XCTUnwrap(fixture.captureOnValidation))
            let cutoff = try XCTUnwrap(fixture.dispatchValidationRead)
            XCTAssertGreaterThan(cutoff, capturedAt)
            var rebases = ConfirmedInsertionRebases<Int>()
            rebases.inserted(at: 0, confirmed: 5, capturedBefore: cutoff)
            XCTAssertEqual(rebases.destination(for: 0, capturedAt: capturedAt) { $0 == 5 }, 5)
            XCTAssertEqual(rebases.destination(for: 0, capturedAt: cutoff + 1) { _ in true }, 0)
        }
    }

    @MainActor
    func testCaptureResumingDuringPreflightWaitsAndRevalidatesBeforeNativeInsertion() async {
        let fixture = QueuedDeliveryFixture()
        defer { fixture.pasteboard.releaseGlobally() }
        fixture.captureOnValidation = 1
        let result = await fixture.deliver(strategy: .nativeSelection)
        XCTAssertEqual(result, .inserted)
        XCTAssertEqual(fixture.waitsDuringCapture, 1)
        XCTAssertEqual(fixture.validationReads, 2)
        XCTAssertEqual(fixture.nativeWrites, 1)
        XCTAssertEqual(fixture.pasteWrites, 0)
    }

    @MainActor
    func testCaptureResumingAfterClipboardStagingRestoresClipboardBeforeWaiting() async {
        let fixture = QueuedDeliveryFixture()
        defer { fixture.pasteboard.releaseGlobally() }
        fixture.captureOnValidation = 2
        let result = await fixture.deliver(strategy: .keyboardPaste)
        XCTAssertEqual(result, .inserted)
        XCTAssertEqual(fixture.waitsDuringCapture, 1)
        XCTAssertEqual(fixture.clipboardWhileWaiting, "Original clipboard")
        XCTAssertEqual(fixture.validationReads, 4)
        XCTAssertEqual(fixture.pasteWrites, 1)
        XCTAssertEqual(fixture.pasteboard.string(forType: .string), "Original clipboard")
    }

    @MainActor
    func testCaptureResumingAfterNativeWriteDoesNotRetryInsertion() async {
        let fixture = QueuedDeliveryFixture()
        defer { fixture.pasteboard.releaseGlobally() }
        fixture.captureOnConfirmation = true
        let result = await fixture.deliver(strategy: .nativeSelection)
        XCTAssertEqual(result, .inserted)
        XCTAssertEqual(fixture.waitsDuringCapture, 0)
        XCTAssertEqual(fixture.nativeWrites, 1)
    }

    @MainActor
    func testCaptureResumingAfterPasteDispatchDoesNotRetryInsertion() async {
        let fixture = QueuedDeliveryFixture()
        defer { fixture.pasteboard.releaseGlobally() }
        fixture.captureOnConfirmation = true
        let result = await fixture.deliver(strategy: .keyboardPaste)
        XCTAssertEqual(result, .inserted)
        XCTAssertEqual(fixture.waitsDuringCapture, 0)
        XCTAssertEqual(fixture.pasteWrites, 1)
    }

    @MainActor
    func testEarlierTakeClipboardWritesDoNotBlockQueuedTakeButUserCopyDoes() {
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        pasteboard.setString("Original clipboard", forType: .string)
        let heldAt = pasteboard.changeCount
        XCTAssertNoThrow(try DictationClipboard.copy("First take", to: pasteboard, onlyIfUnchangedSince: heldAt).get())
        XCTAssertNoThrow(try DictationClipboard.copy("Second take", to: pasteboard, onlyIfUnchangedSince: heldAt).get(),
                         "A queued take captured its baseline before the earlier take's own write")
        pasteboard.clearContents()
        pasteboard.setString("User copy", forType: .string)
        guard case .failure(.changed) = DictationClipboard.copy("Third take", to: pasteboard, onlyIfUnchangedSince: heldAt) else {
            return XCTFail("A user's newer copy must win")
        }
        XCTAssertEqual(pasteboard.string(forType: .string), "User copy")
    }
}

/// Uses an isolated pasteboard and injected events; no hardware or AX access.
@MainActor
private final class QueuedDeliveryFixture {
    let pasteboard = NSPasteboard.withUniqueName()
    var captureActive = false
    var captureOnValidation: Int?
    var captureOnConfirmation = false
    var validationReads = 0
    var waitsDuringCapture = 0
    var clipboardWhileWaiting: String?
    var nativeWrites = 0
    var pasteWrites = 0
    var dispatchValidationRead: Double?

    init() { pasteboard.setString("Original clipboard", forType: .string) }

    func deliver(strategy: TextDeliveryStrategy) async -> InsertionOutcome {
        let environment = TextDeliveryEnvironment(
            validate: { [self] in
                validationReads += 1
                if validationReads == captureOnValidation { captureActive = true }
                return .valid
            },
            modifiersAreHeld: { [self] in captureActive },
            replaceSelection: { [self] _, willDispatch in
                XCTAssertFalse(captureActive)
                willDispatch()
                nativeWrites += 1
                return .acknowledged
            },
            postPaste: { [self] canDispatch in
                XCTAssertFalse(captureActive)
                guard canDispatch() else { return .blocked(reason: "Not ready") }
                pasteWrites += 1
                return .sent
            },
            confirmation: { [self] _ in
                if captureOnConfirmation { captureActive = true }
                return .confirmed
            },
            pause: { _ in XCTFail("Capture must defer delivery without a modifier timeout") },
            waitUntilReady: { [self] in
                if captureActive {
                    waitsDuringCapture += 1
                    clipboardWhileWaiting = pasteboard.string(forType: .string)
                    captureActive = false
                }
            },
            isCaptureActive: { [self] in captureActive },
            willDispatch: { [self] in dispatchValidationRead = Double(validationReads) }
        )
        return await TextDeliveryTransaction(pasteboard: pasteboard, environment: environment)
            .deliver("Words", copying: "Words", strategy: strategy,
                     clipboardUnchangedSince: pasteboard.changeCount)
    }
}
