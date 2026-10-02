import SottoDuoCore
import SwiftUI

struct SottoDuoMenuView: View {
    static let width: CGFloat = 310
    @ObservedObject var controller: SottoDuoController
    var openWindow: () -> Void
    var quit: () -> Void

    private var idleDictationHint: String {
        let key = controller.shortcut == .fn ? "fn" : controller.shortcut.title
        return controller.activationMode == .doubleTapToggle ? "Double tap \(key) to dictate" : "Hold \(key) for a quick take"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                SottoDuoMark(size: 20)
                Text("SottoDuo").font(.headline)
                DevBadge()
                Spacer(minLength: 8)
                HStack(spacing: 6) {
                    StatusDot(color: controller.isServerReady ? SottoDuoPalette.success : SottoDuoPalette.warning)
                    Text(controller.serverStatusMessage)
                        .font(.caption)
                        .foregroundStyle(SottoDuoPalette.muted)
                        .lineLimit(1)
                }
                .frame(width: 112, alignment: .trailing)
                .help(controller.serverStatusMessage)
                .accessibilityIdentifier("server.status")
            }
            .frame(height: 28)

            SottoDuoDictationButton(controller: controller, identifier: "menu.dictate")
            Text(idleDictationHint)
                .font(.caption)
                .foregroundStyle(SottoDuoPalette.muted)
                .frame(height: 18)
            Text(controller.recoveryMessage ?? "")
                .font(.caption)
                .foregroundStyle(SottoDuoPalette.muted)
                .lineLimit(2)
                .frame(height: 30, alignment: .topLeading)
            Button { controller.copyLastTranscript() } label: {
                Label("Copy last message", systemImage: "doc.on.doc")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: 26)
            }
            .disabled(controller.lastTranscript.isEmpty || controller.isBusy)
            .accessibilityIdentifier("menu.copy-last")

            Button("Open \(SottoDuoBuild.current.displayName)…", action: openWindow)
                .keyboardShortcut(",", modifiers: .command)
            Divider()
            Button("Quit \(SottoDuoBuild.current.displayName)", action: quit)
                .keyboardShortcut("q", modifiers: .command)
        }
        .buttonStyle(.borderless)
        .padding(18)
        .frame(width: Self.width)
        .fixedSize(horizontal: false, vertical: true)
        .tint(SottoDuoPalette.accentInk)
        .background { SottoDuoMenuSurface() }
    }
}

@MainActor
final class DictationHUDPresentation: ObservableObject {
    // A fresh identity restarts the entrance even when a new take interrupts
    // the previous result. Hiding cancels any pending entrance task.
    @Published var id: UUID?
}

extension DictationDeliveryStatus {
    var hudSymbol: String {
        switch self {
        case .none: "mic.slash"
        case .saved: "tray.and.arrow.down"
        case .inserted: "checkmark"
        case .copied: "doc.on.clipboard"
        case .tested: "waveform"
        case .listUpdated: "list.number"
        case .unconfirmed: "questionmark"
        case .failed: "exclamationmark"
        case .kept: "tray.and.arrow.down"
        }
    }

    var hudLabel: String {
        switch self {
        case .none: "No speech detected"
        case .saved: "Recording saved"
        case .inserted: "Pasted at your cursor"
        case .copied: "Copied to clipboard"
        case .tested: "Microphone test complete"
        case .listUpdated: "List updated"
        case .unconfirmed: "Check insertion"
        case .failed: "Dictation failed"
        case .kept: "Saved to history"
        }
    }

    var needsAttention: Bool { self == .failed || self == .unconfirmed }
}

struct DictationHUD: View {
    static let width: CGFloat = SottoDuoBuild.current.isDevelopment ? 220 : 180
    static let height: CGFloat = 44
    static let noticeHeight: CGFloat = 30
    static let morphDuration = 0.18
    @ObservedObject var controller: SottoDuoController
    @ObservedObject var presentation: DictationHUDPresentation
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var entered = false
    @State private var expanded = false

    var body: some View {
        VStack(spacing: 0) {
            capsule
                .frame(width: Self.width, height: Self.height)
            RecordingTransferNote(feedback: controller.recordingFeedback)
                .frame(width: Self.width, height: Self.noticeHeight)
        }
        .task(id: presentation.id) { await enter() }
        .onChange(of: controller.hudExpanded) { _, value in
            guard presentation.id != nil, entered else { return }
            withAnimation(morphAnimation) { expanded = value }
        }
    }

    private var morphAnimation: Animation? {
        reduceMotion ? nil : .spring(duration: Self.morphDuration, bounce: 0.08)
    }

    private func enter() async {
        var reset = Transaction(animation: nil)
        reset.disablesAnimations = true
        withTransaction(reset) {
            entered = false
            expanded = false
        }
        guard presentation.id != nil else { return }
        if reduceMotion {
            entered = true
            expanded = controller.hudExpanded
            return
        }
        await Task.yield()
        guard !Task.isCancelled, presentation.id != nil else { return }
        withAnimation(.easeOut(duration: 0.06)) { entered = true }
        // This only stages the visual; microphone startup never waits for it.
        do { try await Task.sleep(for: .milliseconds(60)) } catch { return }
        guard !Task.isCancelled, presentation.id != nil else { return }
        withAnimation(morphAnimation) { expanded = controller.hudExpanded }
    }

    private var capsule: some View {
        ZStack {
            expandedContent
                .frame(width: Self.width, height: Self.height)
                .opacity(expanded ? 1 : 0)
                .allowsHitTesting(expanded)
                .accessibilityHidden(!expanded)
            Button(action: activateCircle) {
                compactIcon
                    .frame(width: Self.height, height: Self.height)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .opacity(expanded ? 0 : 1)
            .allowsHitTesting(!expanded)
            .accessibilityHidden(expanded)
            .accessibilityLabel(controller.isBusy ? "Cancel dictation" : hudLabel)
            .accessibilityHint(controller.isBusy ? "Cancel this dictation" : result.needsAttention ? "Open SottoDuo for details" : "Dismiss status")
            .accessibilityIdentifier("hud.circle")
        }
        .frame(width: expanded ? Self.width : Self.height, height: Self.height)
        .clipped()
        .modifier(SottoDuoFloatingSurface(cornerRadius: Self.height / 2))
        .overlay(alignment: .topTrailing) {
            if !expanded && SottoDuoBuild.current.isDevelopment {
                DevBadge().offset(x: 10, y: -6).allowsHitTesting(false)
            }
        }
        .scaleEffect(entered ? 1 : 0.25)
        .opacity(entered ? 1 : 0)
        .onExitCommand {
            if controller.canCancelWithEscape { controller.cancelDictation() }
            else if !controller.isBusy { controller.dismissFeedback() }
        }
        .help(controller.errorMessage ?? hudLabel)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(SottoDuoBuild.current.displayName) dictation")
        .accessibilityValue(controller.errorMessage ?? hudLabel)
        .accessibilityIdentifier("hud.status")
    }

    @ViewBuilder private var expandedContent: some View {
        if let deadline = controller.undoDeadline { undoContent(until: deadline) }
        else { captureContent }
    }

    /// A cancelled take is still saved; this offers a few seconds to paste it.
    private func undoContent(until deadline: Date) -> some View {
        HStack(spacing: 8) {
            Button { controller.undoCancellation() } label: {
                HStack(spacing: 7) {
                    UndoCountdown(deadline: deadline, duration: SottoDuoController.undoWindow)
                    Text("Undo").font(.system(size: 12, weight: .semibold))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(SottoDuoPalette.accentInk)
                .frame(height: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Paste this dictation after all")
            .accessibilityLabel("Undo cancel")
            .accessibilityHint("Paste this dictation. Otherwise it is only saved to history.")
            .accessibilityIdentifier("hud.undo")
            Button { controller.keepCancelledTake() } label: {
                Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
                    .frame(width: 22, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(SottoDuoPalette.muted)
            .help("Save to history without pasting")
            .accessibilityLabel("Keep cancelled")
            .accessibilityIdentifier("hud.undo-dismiss")
        }
        .padding(.horizontal, 12)
    }

    private var captureContent: some View {
        HStack(spacing: 10) {
            DevBadge()
            HStack(spacing: 8) {
                if controller.isRecording {
                    RecordingWaveform(feedback: controller.recordingFeedback, height: 23)
                    RecordingElapsedTime(feedback: controller.recordingFeedback)
                } else {
                    SottoDuoMark(size: 18)
                    Text("Starting").lineLimit(1)
                }
            }
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(SottoDuoPalette.muted)
            Button { controller.stopDictation() } label: {
                Image(systemName: "stop.fill").font(.system(size: 10, weight: .semibold))
                    .frame(width: 22, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Finish dictation")
            .accessibilityLabel("Finish dictation")
            .accessibilityIdentifier("hud.finish")
        }
        .padding(.horizontal, 12)
    }

    @ViewBuilder private var compactIcon: some View {
        switch controller.activity {
        case .idle, .starting, .recording:
            SottoDuoMark(size: 21)
        case .transcribing, .delivering:
            ProgressView().controlSize(.small)
        case .success, .failed:
            Image(systemName: result.hudSymbol)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(result.needsAttention ? SottoDuoPalette.warning : SottoDuoPalette.accentInk)
                .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
        }
    }

    private var result: DictationDeliveryStatus {
        controller.activity == .failed ? .failed : controller.lastDeliveryStatus
    }

    private var hudLabel: String {
        switch controller.activity {
        case .idle: "Ready"
        case .starting: "Starting microphone"
        case .recording: "Listening"
        case .transcribing: controller.isUndoPending ? "Cancelled. Undo to paste" : "Processing"
        case .delivering: "Inserting"
        case .success, .failed: result.hudLabel
        }
    }

    private func activateCircle() {
        if controller.isBusy { controller.cancelDictation() }
        else {
            if result.needsAttention { controller.onShowWindow?() }
            controller.dismissFeedback()
        }
    }
}

/// Seconds left to undo, drawn as a draining ring around the count.
struct UndoCountdown: View {
    let deadline: Date
    let duration: TimeInterval

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.1)) { context in
            let remaining = max(0, deadline.timeIntervalSince(context.date))
            ZStack {
                Circle().stroke(SottoDuoPalette.muted.opacity(0.25), lineWidth: 2)
                Circle()
                    .trim(from: 0, to: remaining / duration)
                    .stroke(SottoDuoPalette.accentInk, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(Int(remaining.rounded(.up)))")
                    .font(.system(size: 10, weight: .semibold))
                    .monospacedDigit()
            }
            .frame(width: 20, height: 20)
        }
        .accessibilityHidden(true)
    }
}

/// Observe only the notice's whole-second changes, independently of the meter.
struct RecordingTransferNote: View {
    let feedback: RecordingFeedback
    @State private var notice: RecordingTransferNotice?

    var body: some View {
        Text(notice?.text ?? "Saved locally")
            .font(.system(size: 11, weight: .medium))
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .foregroundStyle(SottoDuoPalette.ink)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(.regularMaterial, in: Capsule())
            .opacity(notice == nil ? 0 : 1)
            .accessibilityHidden(notice == nil)
            .accessibilityLabel(notice?.accessibilityLabel ?? "")
            .accessibilityIdentifier("hud.transfer-status")
            .onReceive(feedback.$transferNotice.removeDuplicates()) { notice = $0 }
    }
}
