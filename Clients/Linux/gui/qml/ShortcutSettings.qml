import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Group {
    id: root
    objectName: "shortcutSettings"
    title: "Shortcuts"
    property bool enabledForDesktop: true
    readonly property var config: ui.snapshot.shortcut || ({})
    readonly property var check: config.check || ({})
    readonly property var choices: config.choices || []
    property string selectedKey: ""
    property string error: ""
    property string saved: ""
    property bool pending: false
    property bool showDiagnostics: false
    readonly property bool blocked: !!config.changing || !!check.blocked
    readonly property var selected: choices.find(choice => choice.key === (selectedKey || config.key)) || ({})
    Component.onCompleted: if (enabledForDesktop) bridge.request("shortcuts")
    Component.onDestruction: if (enabledForDesktop) root.ui.finishShortcutCheck()
    Connections {
        target: root.ui
        function onVisibleChanged() {
            if (!root.ui.visible)
                root.ui.finishShortcutCheck();
        }
    }
    Connections {
        target: bridge
        function onReply(action, data) {
            if (["saveShortcut", "checkShortcut", "endShortcutCheck"].includes(action)) {
                root.pending = false;
                if (action === "saveShortcut") {
                    root.selectedKey = data.key || "";
                    root.saved = "Shortcut saved and active.";
                }
                bridge.request("snapshot");
            }
        }
        function onFailed(action, message) {
            if (["shortcuts", "saveShortcut", "checkShortcut", "endShortcutCheck"].includes(action)) {
                root.error = message;
                root.pending = false;
            }
        }
        function onSnapshotChanged() {
            if (!bridge.connected)
                root.pending = false;
        }
    }
    Setting {
        ui: root.ui
        title: "Dictation key"
        detail: root.config.message || "Connect to background dictation to check shortcuts."
        ComboBox {
            objectName: "dictationKeyPicker"
            implicitWidth: 115
            model: root.choices.map(choice => choice.key)
            currentIndex: Math.max(0, model.indexOf(root.selectedKey || root.config.key))
            enabled: bridge.connected && !!root.config.supported && !root.ui.busy && !root.blocked && !root.pending && !bridge.preview
            onActivated: {
                root.selectedKey = model[currentIndex];
                root.error = "";
                root.saved = "";
            }
        }
        SButton {
            objectName: "saveShortcutButton"
            ui: root.ui
            text: root.config.changing ? "Saving…" : "Apply"
            enabled: bridge.connected && !!root.config.supported && !!root.selected.available && !!root.selectedKey && root.selectedKey !== root.config.key && !root.ui.busy && !root.blocked && !root.pending && !bridge.preview
            onClicked: {
                root.pending = true;
                root.error = "";
                root.saved = "";
                bridge.request("saveShortcut", {
                    key: root.selectedKey,
                    revision: root.config.revision
                });
            }
        }
    }
    SLabel {
        ui: root.ui
        Layout.fillWidth: true
        Layout.margins: 12
        visible: !!root.selectedKey && root.selected.available === false
        text: root.selected.reason || ""
        color: root.ui.c.muted
    }
    Setting {
        ui: root.ui
        title: "Cancel / copy last result"
        detail: root.config.key ? "Super + " + root.config.key + " cancels. Super + Shift + " + root.config.key + " copies the last completed result." : "Shown after the desktop bindings are verified."
    }
    Setting {
        ui: root.ui
        title: "Check shortcut"
        detail: root.check.active ? root.check.message + " · " + root.check.remainingSeconds + " seconds left" : root.check.held ? "Release the key to resume dictation. If a release was missed, press and release it once." : "Detect presses and releases for 30 seconds. DictaDuo recording and clipboard actions are paused during the check."
        SButton {
            objectName: "checkShortcutButton"
            ui: root.ui
            text: root.check.active ? "Finish check" : "Check shortcut"
            enabled: bridge.connected && !root.ui.busy && !root.config.changing && !root.pending && (!!root.check.active || (!!root.config.supported && !root.check.held)) && !bridge.preview
            onClicked: {
                root.pending = true;
                root.error = "";
                if (root.check.active)
                    bridge.request("endShortcutCheck");
                else {
                    root.showDiagnostics = true;
                    root.ui.startShortcutCheck();
                }
            }
        }
    }
    SLabel {
        ui: root.ui
        objectName: "shortcutCheckResult"
        Layout.fillWidth: true
        Layout.margins: 12
        visible: !!root.check.presses || !!root.check.releases
        text: "Presses: " + (root.check.presses || 0) + " · Releases: " + (root.check.releases || 0) + (root.check.releases > 0 ? " · Press and release detected" : "")
        color: root.ui.c.muted
    }
    Setting {
        ui: root.ui
        title: "Shortcut diagnostics"
        detail: "Shows only DictaDuo shortcut commands received during the last check."
        SButton {
            ui: root.ui
            objectName: "shortcutDiagnosticsToggle"
            text: root.showDiagnostics ? "Hide details" : "Show details"
            onClicked: root.showDiagnostics = !root.showDiagnostics
        }
    }
    SLabel {
        ui: root.ui
        objectName: "shortcutDiagnosticsEvents"
        Layout.fillWidth: true
        Layout.margins: 12
        visible: root.showDiagnostics
        text: root.check.events && root.check.events.length ? root.check.events.join("\n") : "Run a shortcut check to see events."
        font.family: "monospace"
        font.pixelSize: 12
        color: root.ui.c.muted
    }
    SLabel {
        ui: root.ui
        Layout.fillWidth: true
        Layout.margins: 12
        visible: text.length > 0
        text: root.error || root.saved
    }
}
