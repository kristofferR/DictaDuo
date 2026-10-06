import AppKit
import ApplicationServices

/// Electron delays accessibility activation. Request it when an app is selected,
/// without restarting its debounce when activations arrive close together.
@MainActor
final class InsertionAccessibilityWarmup {
    private var requests: [pid_t: (application: NSRunningApplication, task: Task<Void, Never>, requestedAt: TimeInterval)] = [:]
    private let isTrusted: () -> Bool
    private let request: @Sendable (pid_t) -> Void
    private let now: () -> TimeInterval

    init(isTrusted: @escaping () -> Bool = AXIsProcessTrusted,
         request: @escaping @Sendable (pid_t) -> Void = { TextInserter.prepareWebAccessibility(for: $0) },
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.isTrusted = isTrusted
        self.request = request
        self.now = now
    }

    @discardableResult
    func prepare(_ application: NSRunningApplication?) -> Task<Void, Never>? {
        let time = now()
        requests = requests.filter { _, entry in
            guard entry.application.isTerminated || time - entry.requestedAt >= InsertionPreparation.readinessSeconds else { return true }
            entry.task.cancel()
            return false
        }
        guard isTrusted(), let application, !application.isTerminated else { return nil }
        let pid = application.processIdentifier
        if let entry = requests[pid] { return entry.task }
        let request = request
        let task = Task.detached(priority: .userInitiated) { request(pid) }
        requests[pid] = (application, task, time)
        return task
    }

    func stop() {
        for entry in requests.values { entry.task.cancel() }
        requests.removeAll()
    }
}
