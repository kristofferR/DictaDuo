import Foundation
import DictaDuoAPI

/// Where the next page of one history list starts.
enum HistoryPosition: Equatable {
    case newest
    case before(String)
    case end

    var cursor: String? {
        if case .before(let id) = self { return id }
        return nil
    }
}

enum HistoryPagination {
    /// The server's order: newest first, ties broken by descending ID.
    static func newer(_ a: GenerationRecord, _ b: GenerationRecord) -> Bool {
        a.createdAt != b.createdAt ? a.createdAt > b.createdAt : a.id.uuidString > b.id.uuidString
    }

    /// Merges a page of legacy generations with a page of recording sessions. An
    /// entry is shown only once nothing unfetched from the other list can be newer,
    /// and each position advances only past shown entries.
    static func merge(legacy: GenerationPage, from legacyPosition: HistoryPosition,
                      sessions: GenerationPage, from sessionsPosition: HistoryPosition)
        -> (items: [GenerationRecord], legacy: HistoryPosition, sessions: HistoryPosition) {
        // Each list's oldest fetched entry bounds what may be shown before its next page.
        let bounds = [legacy, sessions].compactMap { $0.nextCursor == nil ? nil : $0.items.last }
        let items = (legacy.items + sessions.items).sorted(by: newer)
            .filter { item in bounds.allSatisfy { !newer($0, item) } }
        let shownIDs = Set(items.map(\.id))
        func next(_ page: GenerationPage, _ previous: HistoryPosition) -> HistoryPosition {
            let shown = page.items.filter { shownIDs.contains($0.id) }
            if shown.count == page.items.count, page.nextCursor == nil { return .end }
            return shown.last.map { .before($0.id.uuidString) } ?? previous
        }
        return (items, next(legacy, legacyPosition), next(sessions, sessionsPosition))
    }
}
