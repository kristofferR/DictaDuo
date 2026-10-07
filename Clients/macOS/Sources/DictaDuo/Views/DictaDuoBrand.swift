import DictaDuoCore
import AppKit
import SwiftUI

/// Inkflow uses the same generated vector geometry as the Linux and export assets.
enum DictaDuoBrand {
    static let appIconImage = makeAppIcon()
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

    /// The same layered Graphite renderer produces the Dock icon and in-app tile.
    private static func makeAppIcon() -> NSImage {
        let image = NSImage(size: NSSize(width: 1024, height: 1024), flipped: true) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            do {
                try DictaDuoArtwork.drawAppIcon(in: rect, context: context)
                return true
            } catch {
                NSLog("DictaDuo app icon could not render: %@", String(describing: error))
                assertionFailure("Invalid generated DictaDuo icon: \(error)")
                return false
            }
        }
        image.isTemplate = false
        image.accessibilityDescription = DictaDuoBuild.current.displayName
        return image
    }

    /// The original silhouette stays clear in the 18-point menu template.
    private static func makeStatusLogo() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: true) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.saveGState()
            context.setFillColor(NSColor.black.cgColor)
            context.addPath(DictaDuoArtwork.smallMarkPath(in: rect))
            context.fillPath()
            context.restoreGState()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "\(DictaDuoBuild.current.displayName)"
        return image
    }
}

struct DictaDuoInkflow: Shape {
    var small = false

    func path(in rect: CGRect) -> Path {
        Path(small ? DictaDuoArtwork.smallMarkPath(in: rect) : DictaDuoArtwork.markPath(in: rect))
    }
}

private struct DictaDuoWordmarkShape: Shape {
    func path(in rect: CGRect) -> Path { Path(DictaDuoArtwork.wordmarkPath(in: rect)) }
}

/// Outlined lettering gives both desktop clients the same name treatment.
struct DictaDuoWordmark: View {
    var height: CGFloat = 20
    var color: Color = DictaDuoPalette.logo

    var body: some View {
        DictaDuoWordmarkShape()
            .fill(color)
            .frame(width: height * DictaDuoArtwork.wordmarkAspectRatio, height: height)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("DictaDuo")
            .accessibilityAddTraits(.isImage)
    }
}

/// The shaded Graphite tile stays consistent with the Dock icon in either appearance.
struct DictaDuoAppIcon: View {
    var size: CGFloat = 40

    var body: some View {
        Image(nsImage: DictaDuoBrand.appIconImage)
            .resizable()
            .interpolation(.high)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
