import CoreGraphics
import Foundation

enum TypingDispatch: Equatable {
    case sent
    case unavailable
    case interrupted(reason: String, dispatched: Bool)
}

struct TextInsertionReceipt: Sendable {
    let original: String
    let selection: NSRange
    let text: String

    init?(original: String, selection: NSRange, text: String) {
        guard original.utf16.count <= 65536, selection.location >= 0, selection.length >= 0,
              selection.location <= original.utf16.count,
              selection.length <= original.utf16.count - selection.location else { return nil }
        self.original = original
        self.selection = selection
        self.text = text
    }

    func value(after sentUnits: Int) -> String? {
        guard sentUnits >= 0, sentUnits <= text.utf16.count else { return nil }
        if sentUnits == 0 { return original }
        let prefix = String(decoding: text.utf16.prefix(sentUnits), as: UTF16.self)
        return (original as NSString).replacingCharacters(in: selection, with: prefix)
    }

    func matches(value: String?, selection actualSelection: NSRange?, sentUnits: Int) -> Bool {
        guard let value, let expected = self.value(after: sentUnits),
              value.utf16.elementsEqual(expected.utf16) else { return false }
        let expectedSelection = sentUnits == 0 ? selection : NSRange(location: selection.location + sentUnits, length: 0)
        return actualSelection == expectedSelection
    }

    func confirmation(value: String?, selection: NSRange?) -> DeliveryConfirmation {
        if matches(value: value, selection: selection, sentUnits: text.utf16.count) { return .confirmed }
        if matches(value: value, selection: selection, sentUnits: 0) { return .pending }
        return .unavailable
    }
}

@MainActor
struct UnicodeTypingDelivery {
    var validate: (Int) async -> TargetValidation
    var canContinue: () -> Bool
    var post: ([UniChar]) -> Bool
    var pause: () async throws -> Void

    func type(_ text: String, canDispatch: () -> Bool) async -> TypingDispatch {
        let packets = Self.chunks(text)
        // A newline-only event is interpreted as Enter by web frameworks, even
        // with virtual key zero. Refuse before dispatch if it cannot be packed.
        guard !packets.contains(where: { $0.first == 10 || $0.first == 13 || $0.first == 9 }) else {
            return .interrupted(reason: "Use Automatic insertion for these line breaks or tabs. Your words are ready to copy.", dispatched: false)
        }
        var dispatchedUnits = 0
        // Validate every receipt, including the final packet. Caret movement
        // alone cannot establish that an editor preserved the dictated text.
        for packetIndex in 0...packets.count {
            guard !Task.isCancelled, canContinue() else {
                return .interrupted(reason: "Typing stopped because you changed input or dictation was cancelled.",
                                    dispatched: dispatchedUnits > 0)
            }
            let validation = await validate(dispatchedUnits)
            guard validation == .valid else {
                let reason: String
                switch validation {
                case .valid: reason = "Typing stopped."
                case .changed(let value), .blocked(let value): reason = value
                }
                return .interrupted(reason: "Typing stopped. " + reason, dispatched: dispatchedUnits > 0)
            }
            if packetIndex == packets.count {
                guard !Task.isCancelled, canContinue() else {
                    return .interrupted(reason: "Typing stopped because input changed.", dispatched: dispatchedUnits > 0)
                }
                return .sent
            }
            let chunk = packets[packetIndex]
            guard !Task.isCancelled, canContinue(), canDispatch() else {
                return .interrupted(reason: "Typing stopped because input changed.", dispatched: dispatchedUnits > 0)
            }
            guard post(chunk) else {
                return dispatchedUnits == 0 ? .unavailable :
                    .interrupted(reason: "Typing stopped before all text could be sent.", dispatched: true)
            }
            dispatchedUnits += chunk.count
            do { try await pause() }
            catch { return .interrupted(reason: "Typing was cancelled.", dispatched: true) }
        }
        return .sent
    }

    /// Ordinary graphemes stay together; unusually long combining sequences
    /// split only at scalar boundaries, never halfway through a surrogate pair.
    nonisolated static func chunks(_ text: String) -> [[UniChar]] {
        let graphemes = text.flatMap { character -> [[UniChar]] in
            let units = Array(character.utf16)
            if units.count <= 16 { return [units] }
            var chunks: [[UniChar]] = []
            var chunk: [UniChar] = []
            for scalar in character.unicodeScalars {
                let next = Array(scalar.utf16)
                if chunk.count + next.count > 16 { chunks.append(chunk); chunk = [] }
                chunk.append(contentsOf: next)
            }
            if !chunk.isEmpty { chunks.append(chunk) }
            return chunks
        }
        var packets: [[UniChar]] = []
        var packet: [UniChar] = []
        var lastGrapheme: [UniChar] = []
        for grapheme in graphemes {
            if packet.count + grapheme.count > 16 {
                if let first = grapheme.first, [9, 10, 13].contains(first),
                   lastGrapheme.count + grapheme.count <= 16 {
                    // Keep a boundary newline behind ordinary text in the same
                    // event. Leading controls may be dropped or act as keys.
                    packet.removeLast(lastGrapheme.count)
                    if !packet.isEmpty { packets.append(packet) }
                    packet = lastGrapheme
                } else { packets.append(packet); packet = [] }
            }
            packet.append(contentsOf: grapheme)
            lastGrapheme = grapheme
        }
        if !packet.isEmpty { packets.append(packet) }
        return packets.filter { !$0.isEmpty }
    }
}
