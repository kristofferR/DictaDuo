/// Tracks confirmed cursor moves only for targets captured before insertion
/// dispatch. Targets include field identity and selection; a caller must
/// revalidate the resulting anchor. External cursor/focus changes never grant a rebase.
struct ConfirmedInsertionRebases<Target: Equatable> {
    private var entries: [(original: Target, confirmed: Target, capturedBefore: Double)] = []

    mutating func inserted(at original: Target, confirmed: Target, capturedBefore: Double) {
        entries = entries.map { $0.confirmed == original ? ($0.original, confirmed, $0.capturedBefore) : $0 }
        entries.append((original, confirmed, capturedBefore))
    }

    func destination(for original: Target, capturedAt: Double, isUnchanged: (Target) -> Bool) -> Target {
        guard let entry = entries.last(where: { $0.original == original && capturedAt < $0.capturedBefore }),
              isUnchanged(entry.confirmed) else { return original }
        return entry.confirmed
    }

    mutating func removeAll() { entries.removeAll() }
}
