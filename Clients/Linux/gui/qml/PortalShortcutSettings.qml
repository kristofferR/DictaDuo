import QtQuick
import QtQuick.Layouts

Group {
    id: root
    title: "Shortcuts"
    Setting {
        ui: root.ui
        title: "Hold to dictate"
        detail: portalShortcuts.message
        SLabel {
            ui: root.ui
            text: portalShortcuts.trigger || "No key assigned"
            color: root.ui.c.muted
        }
        SButton {
            ui: root.ui
            text: "Choose key"
            enabled: !bridge.preview && portalShortcuts.supported
            onClicked: portalShortcuts.configure()
        }
    }
    Setting {
        ui: root.ui
        title: "Cancel, copy and undo"
        detail: "Optional keys to cancel a take, copy the last dictation, or paste a cancelled one. Assign them in the same Plasma dialog."
        SButton {
            ui: root.ui
            text: "Choose keys"
            enabled: !bridge.preview && portalShortcuts.supported
            onClicked: portalShortcuts.configure()
        }
    }
    Setting {
        ui: root.ui
        title: "At login"
        detail: "Keep SottoDuo open in the background to use the Plasma shortcut. The dictation service also runs at login."
    }
}
