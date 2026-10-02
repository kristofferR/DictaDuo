import Foundation

enum DictationActivity: Equatable {
    case idle, starting, recording, transcribing, delivering, success, failed

    var isCapturing: Bool { self == .starting || self == .recording }
    var isBusy: Bool { isCapturing || self == .transcribing || self == .delivering }
}

enum DictationDeliveryStatus: String, Equatable {
    /// `kept` is a cancelled take saved to history without pasting.
    case none, inserted, copied, tested, listUpdated, unconfirmed, failed, kept
}

/// Decides whether a finished take is pasted. A cancelled take waits here
/// until the user undoes the cancellation or its undo window closes.
@MainActor
final class TakeDeliveryGate {
    enum State { case deliver, pending, discard }
    private(set) var state: State
    private var consumed = false
    private var waiter: CheckedContinuation<Bool, Never>?

    init(pending: Bool) { state = pending ? .pending : .deliver }

    /// Re-open the decision for a take that is still processing. Returns
    /// false once delivery has begun, when a cancel can no longer be undone.
    func hold() -> Bool {
        guard !consumed, state == .deliver else { return false }
        state = .pending
        return true
    }

    func decide(_ deliver: Bool) {
        guard state == .pending else { return }
        state = deliver ? .deliver : .discard
        waiter?.resume(returning: deliver)
        waiter = nil
    }

    /// Waits for a pending decision. Called once, just before pasting.
    func consume() async -> Bool {
        consumed = true
        guard state == .pending else { return state == .deliver }
        return await withCheckedContinuation { waiter = $0 }
    }
}

enum DictationTrigger: Equatable {
    case keyboard, dji(UInt64), remoteButton(UUID), test

    var buttonTicket: UUID? {
        if case .remoteButton(let ticket) = self { return ticket }
        return nil
    }

    enum ButtonAction { case start, finish, ignore }

    static func djiButtonAction(deviceID: UInt64, activity: DictationActivity, current: Self?, hasPendingWork: Bool) -> ButtonAction {
        if activity.isCapturing { return current == .dji(deviceID) ? .finish : .ignore }
        return activity.isBusy || hasPendingWork ? .ignore : .start
    }
}

enum ModelStatus: Equatable {
    case missing, downloading, verifying, installed, failed
}

enum EngineStatus: Equatable {
    case unloaded, loading, ready, transcribing, failed
}
