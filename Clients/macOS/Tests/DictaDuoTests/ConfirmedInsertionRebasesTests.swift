import XCTest
@testable import DictaDuo

final class ConfirmedInsertionRebasesTests: XCTestCase {
    private struct Target: Equatable {
        let field: String
        let cursor: Int
    }

    func testThreeQueuedTakesAdvancePastOnlyTheirOwnConfirmedInsertions() {
        let original = Target(field: "editor", cursor: 10)
        let afterFirst = Target(field: "editor", cursor: 15)
        let afterSecond = Target(field: "editor", cursor: 21)
        var rebases = ConfirmedInsertionRebases<Target>()
        rebases.inserted(at: original, confirmed: afterFirst, capturedBefore: 2)
        XCTAssertEqual(rebases.destination(for: original, capturedAt: 1) { $0 == afterFirst }, afterFirst)
        rebases.inserted(at: afterFirst, confirmed: afterSecond, capturedBefore: 4)
        XCTAssertEqual(rebases.destination(for: original, capturedAt: 1) { $0 == afterSecond }, afterSecond)
        XCTAssertEqual(rebases.destination(for: afterFirst, capturedAt: 3) { $0 == afterSecond }, afterSecond)
    }

    func testChangedCursorAndDifferentFieldsNeverAuthorizeRebasing() {
        let original = Target(field: "editor", cursor: 10)
        let afterFirst = Target(field: "editor", cursor: 15)
        let differentField = Target(field: "message", cursor: 10)
        var rebases = ConfirmedInsertionRebases<Target>()
        rebases.inserted(at: original, confirmed: afterFirst, capturedBefore: 2)
        XCTAssertEqual(rebases.destination(for: original, capturedAt: 1) { _ in false }, original)
        XCTAssertEqual(rebases.destination(for: differentField, capturedAt: 1) { _ in true }, differentField)
        rebases.removeAll()
        XCTAssertEqual(rebases.destination(for: original, capturedAt: 3) { _ in true }, original,
                       "A finished batch must not move a future take to its old insertion cursor")
    }

    func testTakeCapturedAfterAnInsertionCannotInheritItsMappingOrChainedMoves() {
        let original = Target(field: "editor", cursor: 0)
        let afterFirst = Target(field: "editor", cursor: 5)
        let afterSecond = Target(field: "editor", cursor: 10)
        var rebases = ConfirmedInsertionRebases<Target>()
        rebases.inserted(at: original, confirmed: afterFirst, capturedBefore: 2)
        XCTAssertEqual(rebases.destination(for: original, capturedAt: 3) { _ in true }, original)
        rebases.inserted(at: afterFirst, confirmed: afterSecond, capturedBefore: 4)
        XCTAssertEqual(rebases.destination(for: original, capturedAt: 3) { _ in true }, original,
                       "Chaining another insertion must preserve the original mapping's capture cutoff")
        XCTAssertEqual(rebases.destination(for: original, capturedAt: 1) { _ in true }, afterSecond)
        XCTAssertEqual(rebases.destination(for: afterFirst, capturedAt: 3) { _ in true }, afterSecond)
    }
}
