import AppKit
import XCTest
@testable import DictaDuo

final class UnicodeTypingDeliveryTests: XCTestCase {
    func testUnicodeChunksPreserveEmojiCombiningTextAndScalarBoundaries() {
        let text = "æøå 👨‍👩‍👧‍👦 e\u{301}\n" + "a" + String(repeating: "\u{301}", count: 40) + "😀"
        let chunks = UnicodeTypingDelivery.chunks(text)
        XCTAssertTrue(chunks.allSatisfy { !$0.isEmpty && $0.count <= 16 })
        XCTAssertEqual(chunks.flatMap { $0 }, Array(text.utf16))
        for chunk in chunks {
            XCTAssertFalse((0xDC00...0xDFFF).contains(chunk.first!))
            XCTAssertFalse((0xD800...0xDBFF).contains(chunk.last!))
        }
    }

    @MainActor
    func testTypingStopsAfterPhysicalInputWithoutSendingTheRemainder() async {
        var sent: [[UniChar]] = []
        var interrupted = false
        let typing = UnicodeTypingDelivery(validate: { _ in .valid }, canContinue: { !interrupted },
                                           post: { sent.append($0); return true }, pause: { interrupted = true })
        let result = await typing.type(String(repeating: "A", count: 20) + "😀B", canDispatch: { true })
        XCTAssertEqual(sent, [Array(String(repeating: "A", count: 16).utf16)])
        guard case .interrupted(_, dispatched: true) = result else { return XCTFail("Must report partial typing") }
    }

    @MainActor
    func testTypingRevalidatesUTF16ProgressAndStopsOnCaretChange() async {
        var offsets: [Int] = []
        var sent: [[UniChar]] = []
        let typing = UnicodeTypingDelivery(validate: { offset in
            offsets.append(offset)
            return offset < 32 ? .valid : .changed(reason: "Cursor moved")
        }, canContinue: { true }, post: { sent.append($0); return true }, pause: {})
        let text = String(repeating: "😀", count: 20)
        let result = await typing.type(text, canDispatch: { true })
        XCTAssertEqual(offsets, [0, 16, 32])
        XCTAssertEqual(sent.flatMap { $0 }, Array(String(repeating: "😀", count: 16).utf16))
        guard case .interrupted(_, dispatched: true) = result else { return XCTFail("Must stop after caret movement") }
    }

    @MainActor
    func testTypingRejectsTextChangedDuringRecordingWithTheSameCaret() async throws {
        let receipt = try XCTUnwrap(TextInsertionReceipt(original: "first document",
                                                        selection: NSRange(location: 6, length: 0), text: "words"))
        let typing = UnicodeTypingDelivery(validate: { offset in
            receipt.matches(value: "other document", selection: receipt.selection, sentUnits: offset) ? .valid : .changed(reason: "Text changed during recording")
        }, canContinue: { true }, post: { _ in XCTFail("Must not type into the changed document"); return false }, pause: {})
        let result = await typing.type(receipt.text, canDispatch: { true })
        guard case .interrupted(_, dispatched: false) = result else { return XCTFail("Must reject before any input is sent") }
    }

    @MainActor
    func testTransformedTextStopsTypingEvenWhenTheCaretMatches() async throws {
        for text in ["words", String(repeating: "words ", count: 5)] {
            let receipt = try XCTUnwrap(TextInsertionReceipt(original: "prefix suffix",
                                                            selection: NSRange(location: 7, length: 6), text: text))
            var actual = receipt.original
            var selection = receipt.selection
            var sent = 0
            let typing = UnicodeTypingDelivery(validate: { offset in
                receipt.matches(value: actual, selection: selection, sentUnits: offset) ? .valid : .changed(reason: "Text was transformed")
            }, canContinue: { true }, post: { units in
                sent += units.count
                actual = (receipt.value(after: sent) ?? "").uppercased()
                selection = NSRange(location: receipt.selection.location + sent, length: 0)
                return true
            }, pause: {})
            let result = await typing.type(text, canDispatch: { true })
            guard case .interrupted(_, dispatched: true) = result else { return XCTFail("Must reject transformed text, including the final packet") }
            XCTAssertEqual(sent, min(text.utf16.count, 16))
        }
    }

    func testTypingReceiptPreservesSelectionAndExactUnicode() throws {
        let receipt = try XCTUnwrap(TextInsertionReceipt(original: "before OLD after",
                                                        selection: NSRange(location: 7, length: 3), text: "æ 👋🏽 e\u{301}"))
        XCTAssertTrue(receipt.matches(value: receipt.original, selection: receipt.selection, sentUnits: 0))
        let count = receipt.text.utf16.count
        let caret = NSRange(location: 7 + count, length: 0)
        XCTAssertTrue(receipt.matches(value: "before æ 👋🏽 e\u{301} after", selection: caret, sentUnits: count))
        XCTAssertFalse(receipt.matches(value: "before æ 👋🏽 é after", selection: caret, sentUnits: count))
        XCTAssertFalse(receipt.matches(value: "changed æ 👋🏽 e\u{301} after", selection: caret, sentUnits: count))
        XCTAssertNil(TextInsertionReceipt(original: "abc", selection: NSRange(location: 2, length: 2), text: "new"))
        XCTAssertNil(TextInsertionReceipt(original: String(repeating: "a", count: 65537), selection: NSRange(location: 0, length: 0), text: "new"))
    }

    @MainActor
    func testNewlinesArePackedAsTextAndUnpackableRunsAreRefusedBeforeTyping() async {
        for text in [String(repeating: "x", count: 16) + "\n", String(repeating: "x", count: 16) + "\nA", "abcde👨‍👩‍👧‍👦\nA", "A\r\nB"] {
            let packets = UnicodeTypingDelivery.chunks(text)
            XCTAssertEqual(packets.flatMap { $0 }, Array(text.utf16))
            XCTAssertFalse(packets.contains { $0.allSatisfy { $0 == 10 || $0 == 13 } })
            XCTAssertTrue(packets.allSatisfy { $0.count <= 16 })
        }
        XCTAssertTrue(UnicodeTypingDelivery.chunks("abcde👨‍👩‍👧‍👦\nA")
            .contains { String(decoding: $0, as: UTF16.self).contains("👨‍👩‍👧‍👦") })
        let typing = UnicodeTypingDelivery(validate: { _ in XCTFail("Must refuse before validation"); return .valid },
                                           canContinue: { true }, post: { _ in XCTFail("Must not send Enter"); return true }, pause: {})
        for text in ["\nA", "\tA", "A" + String(repeating: "\n", count: 40) + "B"] {
            let result = await typing.type(text, canDispatch: { true })
            guard case .interrupted(_, dispatched: false) = result else { return XCTFail("Must refuse before any insertion") }
        }
    }

    @MainActor
    func testUnicodeTransactionNeverUsesPasteNativeWriteOrClipboardBackup() async {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.setString("Existing clipboard", forType: .string)
        let baseline = board.changeCount
        for result in [TypingDispatch.sent, .unavailable, .interrupted(reason: "User typed", dispatched: true)] {
            let environment = TextDeliveryEnvironment(
                validate: { .valid }, modifiersAreHeld: { false },
                replaceSelection: { _, _ in XCTFail("Typing must not invoke a native write"); return .unsupported },
                postPaste: { _ in XCTFail("Typing must not fall back to paste"); return .unavailable },
                confirmation: { _ in .unavailable }, pause: { _ in },
                typeText: { _, canDispatch in XCTAssertTrue(canDispatch()); return result }
            )
            let outcome = await TextDeliveryTransaction(pasteboard: board, environment: environment)
                .deliver("Words", copying: "Words", strategy: .unicodeTyping, clipboardUnchangedSince: baseline)
            XCTAssertNotEqual(outcome, .inserted)
            XCTAssertEqual(board.changeCount, baseline)
            XCTAssertEqual(board.string(forType: .string), "Existing clipboard")
        }
    }

    @MainActor
    func testOwnUnicodeEventsDoNotInterruptAndUserEventsDo() throws {
        let monitor = TextInputInterruptionMonitor()
        let event = try XCTUnwrap(CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true))
        TextInputEvents.mark(event)
        monitor.receive(event)
        XCTAssertFalse(monitor.interrupted)
        let userEvent = try XCTUnwrap(CGEvent(keyboardEventSource: nil, virtualKey: 1, keyDown: true))
        monitor.receive(userEvent)
        XCTAssertTrue(monitor.interrupted)
        let disabledMonitor = TextInputInterruptionMonitor()
        disabledMonitor.receive(event, type: .tapDisabledByTimeout)
        XCTAssertTrue(disabledMonitor.interrupted)
    }

    func testPasteKeyUsesLayoutTranslationAndRefusesUnknownLayout() {
        XCTAssertEqual(PasteShortcutKey.resolve { $0 == 47 ? "v" : "x" }, 47)
        XCTAssertEqual(PasteShortcutKey.resolve { $0 == 9 ? "V" : nil }, 9)
        XCTAssertNil(PasteShortcutKey.resolve { _ in nil })
    }

    @MainActor
    func testInsertionPreferenceDefaultsMigratesAndPersists() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dictaduo-insertion-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data(#"{"endpoint":"http://localhost:8391","deviceID":"test","deviceName":"Test"}"#.utf8)
            .write(to: root.appendingPathComponent("client.json"))
        let store = ClientPreferencesStore(root: root, environment: [:], readCredential: { _ in "" })
        XCTAssertEqual(store.textInsertionMethod, .automatic)
        store.textInsertionMethod = .unicodeTyping
        let restored = ClientPreferencesStore(root: root, environment: [:], readCredential: { _ in "" })
        XCTAssertEqual(restored.textInsertionMethod, .unicodeTyping)
        XCTAssertEqual(restored.deviceID, "test")
    }
}
