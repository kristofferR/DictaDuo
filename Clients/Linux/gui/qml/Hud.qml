import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import DictaDuo.Native 1.0

Window {
    id: hud
    objectName: "dictationHud"
    transientParent: null
    required property var ui
    width: 420
    height: 78
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
    // A shared mic on another computer is named in the title, with its computer.
    readonly property bool sharedMic: phase === "recording" && !!ui.activity.host && !!ui.activity.source
    onPhaseChanged: {
        if (["completed", "failed", "cancelled"].includes(phase))
            linger.restart();
    }
    Timer {
        id: linger
        interval: 4500
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
                    objectName: "hudTitle"
                    text: hud.sharedMic ? "Listening · " + hud.ui.activity.source + " on " + hud.ui.activity.host : hud.ui.messageFor(hud.phase)
                    elide: Text.ElideRight
                    maximumLineCount: 1
                    font.weight: Font.DemiBold
                    font.pixelSize: 14
                    Layout.fillWidth: true
                }
                SLabel {
                    ui: hud.ui
                    objectName: "hudSubtitle"
                    // The cloud fallback takes the source's place, since the title already says what is listening.
                    text: hud.ui.undoSeconds > 0 ? "Press " + (hud.ui.dictationKey || "the dictation key") + " again to paste · " + hud.ui.undoSeconds + "s" : [hud.ui.feedback.elapsedSeconds !== undefined ? hud.ui.duration(hud.ui.feedback.elapsedSeconds) : "", hud.ui.fallbackNote || (hud.sharedMic ? "" : hud.ui.activity.source || "DictaDuo")].filter(part => part).join(" · ")
                    color: hud.ui.c.muted
                    font.pixelSize: 11
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                    maximumLineCount: 1
                }
            }
        }
    }
}
