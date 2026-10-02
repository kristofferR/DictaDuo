import Foundation
import SottoDuoAPI
import XCTest
@testable import SottoDuo

final class HistoryPaginationTests: XCTestCase {
    private func entry(_ seconds: TimeInterval) -> GenerationRecord {
        GenerationRecord(requestID: UUID(), device: .init(id: "test", name: "Test Mac"),
                         createdAt: Date(timeIntervalSince1970: seconds), settings: .init())
    }

    func testOlderSessionsWaitUntilNewerLegacyPagesAreLoaded() {
        let recent = [entry(10), entry(9)], older = entry(8)
        let sessions = GenerationPage(items: [entry(2), entry(1)])
        let first = HistoryPagination.merge(
            legacy: .init(items: recent, nextCursor: recent[1].id.uuidString), from: .newest,
            sessions: sessions, from: .newest)
        XCTAssertEqual(first.items.map(\.id), recent.map(\.id))
        XCTAssertEqual(first.legacy, .before(recent[1].id.uuidString))
        XCTAssertEqual(first.sessions, .newest)

        let second = HistoryPagination.merge(legacy: .init(items: [older]), from: first.legacy,
                                             sessions: sessions, from: first.sessions)
        XCTAssertEqual(second.items.map(\.id), ([older] + sessions.items).map(\.id))
        XCTAssertEqual(second.legacy, .end)
        XCTAssertEqual(second.sessions, .end)
    }
}
