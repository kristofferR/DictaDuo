import AppKit
import Carbon
import CoreGraphics

enum TextInsertionMethod: String, CaseIterable, Identifiable {
    case automatic
    case unicodeTyping

    var id: String { rawValue }
    var title: String { self == .automatic ? "Automatic" : "Type text" }
    var detail: String {
        self == .automatic ? "Insert using the app's text and paste commands." :
            "Type without using the clipboard. Stops when you type, click, or change focus."
    }
}

enum TextInputEvents {
    static let marker: Int64 = 0x4444_5445

    static func isOwnEvent(_ event: CGEvent) -> Bool {
        event.getIntegerValueField(.eventSourceUserData) == marker
    }

    static func mark(_ event: CGEvent) {
        event.setIntegerValueField(.eventSourceUserData, value: marker)
    }
}

/// Physical key positions depend on the Command-modified layout, including
/// layouts that temporarily switch to QWERTY while Command is held.
enum PasteShortcutKey {
    static func resolve(translate: (UInt16) -> String?) -> CGKeyCode? {
        (UInt16(0)..<128).first { translate($0)?.lowercased() == "v" }
    }

    static func current() -> CGKeyCode? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
        guard let bytes = CFDataGetBytePtr(data) else { return nil }
        let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
        return resolve { key in
            var deadKey: UInt32 = 0
            var length = 0
            var characters = [UniChar](repeating: 0, count: 4)
            let status = UCKeyTranslate(layout, key, UInt16(kUCKeyActionDown), UInt32(cmdKey >> 8),
                                        UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysMask),
                                        &deadKey, characters.count, &length, &characters)
            guard status == noErr, length > 0 else { return nil }
            return String(utf16CodeUnits: characters, count: length)
        }
    }
}

@MainActor
enum SystemPasteShortcut {
    static func post(canStart: () -> Bool, canPaste: () -> Bool) async -> PasteDispatch {
        guard let key = PasteShortcutKey.current(), let source = CGEventSource(stateID: .privateState),
              let commandDown = CGEvent(keyboardEventSource: source, virtualKey: 55, keyDown: true),
              let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false),
              let commandUp = CGEvent(keyboardEventSource: source, virtualKey: 55, keyDown: false) else { return .unavailable }
        for event in [commandDown, down, up] { event.flags = .maskCommand }
        commandUp.flags = []
        for event in [commandDown, down, up, commandUp] { TextInputEvents.mark(event) }
        let input = TextInputInterruptionMonitor()
        guard input.start() else { return .unavailable }
        defer { input.stop() }
        guard !Task.isCancelled, CGPreflightPostEventAccess(), canStart(), !input.interrupted,
              canPaste(), !input.interrupted else {
            return .blocked(reason: "Focus or input access changed before pasting.")
        }
        commandDown.post(tap: .cghidEventTap)
        defer { commandUp.post(tap: .cghidEventTap) }
        // Dispatch the complete chord without yielding while Command is down.
        down.post(tap: .cghidEventTap)
        // Once V goes down, finish the chord even if the take is cancelled.
        // A dispatched paste must never be retried through another route.
        up.post(tap: .cghidEventTap)
        return .sent
    }
}

/// Listen without swallowing or replaying the user's input. Synthetic text
/// events carry a marker so they cannot interrupt their own delivery.
@MainActor
final class TextInputInterruptionMonitor {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private(set) var interrupted = false

    func start() -> Bool {
        let mask = [CGEventType.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown]
            .reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                         eventsOfInterest: mask, callback: dictaduoTextInputCallback,
                                         userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return false }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            return false
        }
        self.tap = tap
        self.source = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    func receive(_ event: CGEvent, type: CGEventType = .keyDown) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput || !TextInputEvents.isOwnEvent(event) {
            interrupted = true
        }
    }

    func stop() {
        if let tap { CFMachPortInvalidate(tap) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
    }
}

private let dictaduoTextInputCallback: CGEventTapCallBack = { _, type, event, context in
    if let context {
        let monitor = Unmanaged<TextInputInterruptionMonitor>.fromOpaque(context).takeUnretainedValue()
        MainActor.assumeIsolated { monitor.receive(event, type: type) }
    }
    return Unmanaged.passUnretained(event)
}
