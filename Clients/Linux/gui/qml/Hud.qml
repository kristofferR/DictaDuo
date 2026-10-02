import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import SottoDuo.Native 1.0

Window {
    id: hud
    objectName: "dictationHud"
    transientParent: null
    required property var ui
    width: 420
    height: ui.limitNotice ? 94 : 78
    // Wayland placement belongs to layer-shell; these are the X11 fallback.
    x: Qt.platform.pluginName.startsWith("wayland") ? 0 : (screen ? screen.virtualX + (screen.width - width) / 2 : 0)
    y: Qt.platform.pluginName.startsWith("wayland") ? 0 : (screen ? screen.virtualY + screen.height - height - 80 : 0)
    color: "transparent"
    flags: Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.WindowDoesNotAcceptFocus | Qt.WindowTransparentForInput
    property bool surfaceReady: false
    Component.onCompleted: {
        HudSurface.configure(hud);
        surfaceReady = true;
    }
    visible: surfaceReady && bridge.connected && !bridge.preview && (!ui.visible || !ui.active) && (ui.busy || linger.running)
    property string phase: ui.activity.phase
    onPhaseChanged: {
        if (["completed", "failed", "cancelled"].includes(phase))
            linger.restart();
    }
    Timer {
        id: linger
        interval: 4500
    }
    // Whole seconds left to undo a cancel; steps once per second, no continuous repaint.
    property int undoSeconds: 0
    readonly property string undoKey: portalShortcuts.plasma ? portalShortcuts.trigger : (ui.shortcut && ui.shortcut.key) || ""
    function updateUndo() {
        undoSeconds = ui.activity.undoUntil ? Math.max(0, Math.ceil((ui.activity.undoUntil - Date.now()) / 1000)) : 0;
    }
    Connections {
        target: hud.ui
        function onActivityChanged() { hud.updateUndo(); }
    }
    Timer {
        interval: 1000
        repeat: true
        running: hud.ui.activity.undoUntil !== undefined && hud.ui.activity.undoUntil > 0
        triggeredOnStart: true
        onTriggered: hud.updateUndo()
    }
    Rectangle {
        anchors.fill: parent
        anchors.margins: 3
        radius: 22
        color: hud.ui.c.surface
        border.color: hud.ui.c.line
        RowLayout {
            anchors.fill: parent
            anchors.margins: 16
            spacing: 14
            LevelMeter {
                ui: hud.ui
                levels: hud.ui.feedback.levels || []
                visible: hud.phase === "recording"
            }
            SLabel {
                ui: hud.ui
                visible: hud.phase !== "recording"
                text: "≋"
                color: hud.ui.c.accent
                font.pixelSize: 22
            }
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 3
                SLabel {
                    ui: hud.ui
                    text: hud.ui.messageFor(hud.phase)
                    font.weight: Font.DemiBold
                    font.pixelSize: 14
                    Layout.fillWidth: true
                }
                SLabel {
                    ui: hud.ui
                    text: hud.undoSeconds > 0 ? "Press " + (hud.undoKey || "the dictation key") + " again to paste · " + hud.undoSeconds + "s" : (hud.ui.feedback.elapsedSeconds !== undefined ? hud.ui.duration(hud.ui.feedback.elapsedSeconds) + " · " : "") + (hud.ui.activity.source || "SottoDuo")
                    color: hud.ui.c.muted
                    font.pixelSize: 11
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                    maximumLineCount: 1
                }
                SLabel {
                    ui: hud.ui
                    text: hud.ui.limitNotice
                    visible: text.length > 0
                    font.pixelSize: 11
                    Layout.fillWidth: true
                }
            }
        }
    }
}
