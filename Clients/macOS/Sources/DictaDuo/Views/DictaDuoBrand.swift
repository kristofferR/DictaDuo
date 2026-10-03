import DictaDuoCore
import AppKit
import SwiftUI

/// The two ribbon turns used by the approved DictaDuo SVG assets.
enum DictaDuoBrand {
    static func ribbonPaths(in rect: CGRect) -> (upper: CGPath, lower: CGPath) {
        let upper = CGMutablePath()
        upper.move(to: CGPoint(x: 102, y: 18))
        upper.addLine(to: CGPoint(x: 62, y: 18))
        upper.addCurve(to: CGPoint(x: 22, y: 50), control1: CGPoint(x: 38, y: 18), control2: CGPoint(x: 22, y: 31))
        upper.addCurve(to: CGPoint(x: 49, y: 81), control1: CGPoint(x: 22, y: 67), control2: CGPoint(x: 33, y: 76))
        upper.addLine(to: CGPoint(x: 60, y: 59))
        upper.addCurve(to: CGPoint(x: 47, y: 48), control1: CGPoint(x: 50, y: 56), control2: CGPoint(x: 47, y: 53))
        upper.addCurve(to: CGPoint(x: 63, y: 40), control1: CGPoint(x: 47, y: 43), control2: CGPoint(x: 53, y: 40))
        upper.addLine(to: CGPoint(x: 102, y: 40))
        upper.closeSubpath()

        let lower = CGMutablePath()
        lower.move(to: CGPoint(x: 26, y: 110))
        lower.addLine(to: CGPoint(x: 66, y: 110))
        lower.addCurve(to: CGPoint(x: 106, y: 78), control1: CGPoint(x: 90, y: 110), control2: CGPoint(x: 106, y: 97))
        lower.addCurve(to: CGPoint(x: 79, y: 47), control1: CGPoint(x: 106, y: 61), control2: CGPoint(x: 95, y: 52))
        lower.addLine(to: CGPoint(x: 68, y: 69))
        lower.addCurve(to: CGPoint(x: 81, y: 80), control1: CGPoint(x: 78, y: 72), control2: CGPoint(x: 81, y: 75))
        lower.addCurve(to: CGPoint(x: 65, y: 88), control1: CGPoint(x: 81, y: 85), control2: CGPoint(x: 75, y: 88))
        lower.addLine(to: CGPoint(x: 26, y: 88))
        lower.closeSubpath()
        var transform = CGAffineTransform(a: rect.width / 128, b: 0, c: 0, d: rect.height / 128,
                                         tx: rect.minX, ty: rect.minY)
        return (upper.copy(using: &transform) ?? upper, lower.copy(using: &transform) ?? lower)
    }

    static func ribbonPath(in rect: CGRect) -> CGPath {
        let paths = ribbonPaths(in: rect)
        let path = CGMutablePath()
        path.addPath(paths.upper)
        path.addPath(paths.lower)
        return path
    }

    private static let restingStatusImage = makeStatusLogo()
    private static let recordingStatusImage = makeStatusSymbol("waveform", description: "\(DictaDuoBuild.current.displayName) — listening")
    private static let processingStatusImage = makeStatusSymbol("ellipsis", description: "\(DictaDuoBuild.current.displayName) — processing")

    static func statusImage(for activity: DictationActivity = .idle) -> NSImage {
        switch activity {
        case .starting, .recording: recordingStatusImage
        case .transcribing, .delivering: processingStatusImage
        case .idle, .success, .failed: restingStatusImage
        }
    }

    /// Status-bar templates must let AppKit choose their foreground. In
    /// particular, do not bridge the SwiftUI brand tint onto NSStatusBarButton.
    static func updateStatusButton(_ button: NSButton, activity: DictationActivity, shortcut: HoldKey,
                                   activationMode: HotkeyActivationMode = .hold) {
        button.contentTintColor = nil
        button.imagePosition = .imageLeading
        button.title = DictaDuoBuild.current.isDevelopment ? " Dev" : ""
        button.font = .systemFont(ofSize: 10, weight: .medium)
        button.imageScaling = .scaleProportionallyDown
        button.image = statusImage(for: activity)
        let description: String
        switch activity {
        case .starting: description = "\(DictaDuoBuild.current.displayName) — starting microphone"
        case .recording: description = "\(DictaDuoBuild.current.displayName) — listening"
        case .transcribing: description = "\(DictaDuoBuild.current.displayName) — transcribing"
        case .delivering: description = "\(DictaDuoBuild.current.displayName) — delivering your words"
        case .failed: description = "\(DictaDuoBuild.current.displayName) — dictation needs attention"
        case .idle, .success:
            let verb = activationMode == .doubleTapToggle ? "double tap" : "hold"
            description = "\(DictaDuoBuild.current.displayName) — \(verb) \(shortcut.title) to dictate"
        }
        button.toolTip = description
        button.setAccessibilityLabel(description)
    }

    private static func makeStatusSymbol(_ name: String, description: String) -> NSImage {
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: description)?
            .withSymbolConfiguration(.init(pointSize: 15, weight: .medium)) else {
            return restingStatusImage
        }
        image.size = NSSize(width: 18, height: 18)
        image.isTemplate = true
        return image
    }

    /// The optical 24-point variant keeps the ribbon openings clear in the menu bar.
    private static func makeStatusLogo() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: true) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            let path = CGMutablePath()
            path.move(to: CGPoint(x: 19.5, y: 3.5))
            path.addLine(to: CGPoint(x: 11.7, y: 3.5))
            path.addCurve(to: CGPoint(x: 4.2, y: 9.6), control1: CGPoint(x: 7.2, y: 3.5), control2: CGPoint(x: 4.2, y: 6))
            path.addCurve(to: CGPoint(x: 9.3, y: 15.5), control1: CGPoint(x: 4.2, y: 12.8), control2: CGPoint(x: 6.3, y: 14.5))
            path.addLine(to: CGPoint(x: 11.4, y: 11.3))
            path.addCurve(to: CGPoint(x: 8.9, y: 9.2), control1: CGPoint(x: 9.5, y: 10.7), control2: CGPoint(x: 8.9, y: 10.2))
            path.addCurve(to: CGPoint(x: 11.9, y: 7.7), control1: CGPoint(x: 8.9, y: 8.2), control2: CGPoint(x: 10.1, y: 7.7))
            path.addLine(to: CGPoint(x: 19.5, y: 7.7))
            path.closeSubpath()
            path.move(to: CGPoint(x: 4.5, y: 20.5))
            path.addLine(to: CGPoint(x: 12.3, y: 20.5))
            path.addCurve(to: CGPoint(x: 19.8, y: 14.4), control1: CGPoint(x: 16.8, y: 20.5), control2: CGPoint(x: 19.8, y: 18))
            path.addCurve(to: CGPoint(x: 14.7, y: 8.5), control1: CGPoint(x: 19.8, y: 11.2), control2: CGPoint(x: 17.7, y: 9.5))
            path.addLine(to: CGPoint(x: 12.6, y: 12.7))
            path.addCurve(to: CGPoint(x: 15.1, y: 14.8), control1: CGPoint(x: 14.5, y: 13.3), control2: CGPoint(x: 15.1, y: 13.8))
            path.addCurve(to: CGPoint(x: 12.1, y: 16.3), control1: CGPoint(x: 15.1, y: 15.8), control2: CGPoint(x: 13.9, y: 16.3))
            path.addLine(to: CGPoint(x: 4.5, y: 16.3))
            path.closeSubpath()
            context.saveGState()
            context.translateBy(x: rect.minX, y: rect.minY)
            context.scaleBy(x: rect.width / 24, y: rect.height / 24)
            context.setFillColor(NSColor.black.cgColor)
            context.addPath(path)
            context.fillPath()
            context.restoreGState()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "\(DictaDuoBuild.current.displayName)"
        return image
    }
}

struct DictaDuoRibbon: Shape {
    func path(in rect: CGRect) -> Path { Path(DictaDuoBrand.ribbonPath(in: rect)) }
}

struct DictaDuoRibbonTurn: Shape {
    enum Turn { case upper, lower }
    let turn: Turn

    func path(in rect: CGRect) -> Path {
        let paths = DictaDuoBrand.ribbonPaths(in: rect)
        return Path(turn == .upper ? paths.upper : paths.lower)
    }
}

/// The warm app tile stays consistent with the Dock icon in either appearance.
struct DictaDuoAppIcon: View {
    var size: CGFloat = 40

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.21875, style: .continuous)
                .fill(LinearGradient(colors: [Color(red: 252 / 255, green: 249 / 255, blue: 242 / 255),
                                              Color(red: 232 / 255, green: 217 / 255, blue: 212 / 255)],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
                .overlay {
                    RoundedRectangle(cornerRadius: size * 0.21875, style: .continuous)
                        .strokeBorder(.white.opacity(0.55), lineWidth: 0.5)
                }
                .padding(size * 12 / 512)
            DictaDuoRibbonTurn(turn: .upper)
                .fill(Color(red: 53 / 255, green: 45 / 255, blue: 58 / 255))
                .frame(width: size * 0.675, height: size * 0.675)
            DictaDuoRibbonTurn(turn: .lower)
                .fill(Color(red: 170 / 255, green: 102 / 255, blue: 92 / 255))
                .frame(width: size * 0.675, height: size * 0.675)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
