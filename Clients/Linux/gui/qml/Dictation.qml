import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: root
    required property var ui
    spacing: height < 620 ? 16 : 22
    SLabel {
        ui: root.ui
        text: "SottoDuo · Dictation"
        font.pixelSize: 18
        font.weight: Font.DemiBold
    }
    RowLayout {
        Layout.fillWidth: true
        Layout.topMargin: 24
        spacing: 20
        Rectangle {
            objectName: "shortcutKeycap"
            Layout.preferredWidth: 72
            Layout.preferredHeight: 76
            radius: 16
            color: root.ui.c.line
            Accessible.role: Accessible.Graphic
            Accessible.name: portalShortcuts.plasma ? root.ui.triggerVerb + " " + (portalShortcuts.trigger || "your Plasma shortcut") + " to dictate" : root.ui.shortcut.key ? root.ui.triggerVerb + " " + root.ui.shortcut.key + " to dictate" : "Dictation keyboard shortcut"
            Rectangle {
                width: parent.width
                height: parent.height - 6
                radius: 16
                color: root.ui.c.surface
                border.color: root.ui.c.line
                Image {
                    visible: !(portalShortcuts.plasma ? portalShortcuts.trigger : root.ui.shortcut.key)
                    anchors.centerIn: parent
                    width: 36
                    height: 36
                    sourceSize: Qt.size(width * Screen.devicePixelRatio, height * Screen.devicePixelRatio)
                    Accessible.ignored: true
                    source: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + root.ui.c.accent + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10"/></svg>')
                }
                SLabel {
                    objectName: "configuredShortcutKey"
                    ui: root.ui
                    anchors.centerIn: parent
                    text: (portalShortcuts.plasma ? portalShortcuts.trigger : root.ui.shortcut.key) || ""
                    visible: text.length > 0
                    font.pixelSize: 18
                    font.weight: Font.DemiBold
                }
            }
        }
        SLabel {
            ui: root.ui
            text: root.ui.shortcut.changing ? "Saving shortcut…" : !root.ui.busy && root.ui.shortcutBlocked ? "Checking shortcut…" : root.ui.activity.phase === "completed" ? root.ui.triggerVerb + " to dictate." : root.ui.messageFor(root.ui.activity.phase)
            font.pixelSize: 34
            font.weight: Font.DemiBold
            Layout.fillWidth: true
        }
    }
    RowLayout {
        Layout.fillWidth: true
        visible: root.ui.busy
        SLabel {
            ui: root.ui
            text: "Microphone"
            color: root.ui.c.muted
        }
        SLabel {
            ui: root.ui
            text: root.ui.activity.source || root.ui.sources.next?.name || "Checking input…"
            Layout.fillWidth: true
        }
        SLabel {
            ui: root.ui
            text: root.ui.activity.trigger === "test" ? "Test in SottoDuo" : root.ui.snapshot.device?.name || "This computer"
            color: root.ui.c.muted
        }
    }
    Rectangle {
        Layout.fillWidth: true
        implicitHeight: route.implicitHeight + 28
        radius: 12
        color: root.ui.c.surface
        border.color: root.ui.c.line
        visible: !root.ui.busy
        RowLayout {
            id: route
            anchors.fill: parent
            anchors.margins: 14
            spacing: 16
            SLabel {
                ui: root.ui
            text: root.ui.sources.next ? root.ui.sources.next.name : !root.ui.sourcesChecked ? "Checking microphone…" : "No available microphone"
                Layout.fillWidth: true
            }
            SLabel {
                ui: root.ui
                text: "→"
                color: root.ui.c.muted
            }
            SLabel {
                ui: root.ui
                text: root.ui.snapshot.device ? root.ui.snapshot.device.name : "This computer"
            }
        }
    }
    RowLayout {
        Layout.fillWidth: true
        spacing: 9
        StatusDot {
            objectName: "dictationConnectionDot"
            ready: root.ui.serverReady
        }
        SLabel {
            ui: root.ui
            text: root.ui.connection
            Layout.fillWidth: true
        }
        SLabel {
            ui: root.ui
            objectName: "dictationServerAddress"
            text: root.ui.snapshot.server || ""
            visible: text.length > 0
            color: root.ui.c.muted
            font.pixelSize: 13
            wrapMode: Text.NoWrap
            elide: Text.ElideMiddle
            Layout.preferredWidth: Math.min(200, root.width * 0.28)
        }
        SButton {
            ui: root.ui
            text: "Check connection"
            onClicked: root.ui.refresh()
        }
    }
    RowLayout {
        Layout.fillWidth: true
        visible: root.ui.busy || !!root.ui.feedback.limitReached
        LevelMeter {
            ui: root.ui
            levels: root.ui.feedback.levels || []
            visible: root.ui.activity.phase === "recording"
        }
        SLabel {
            ui: root.ui
            objectName: "recordingClock"
            text: root.ui.duration(root.ui.feedback.elapsedSeconds)
            font.pixelSize: 18
        }
        SLabel {
            ui: root.ui
            Layout.fillWidth: true
            objectName: "recordingLimitNotice"
            text: root.ui.limitNotice || (root.ui.activity.phase === "recording" && !(root.ui.feedback.levels || []).length ? "Waiting for microphone levels" : "")
            color: root.ui.c.muted
            font.pixelSize: 13
        }
    }
    RowLayout {
        SLabel {
            ui: root.ui
            text: root.ui.busy ? "Live dictation" : "Last dictation"
            font.weight: Font.DemiBold
            Layout.fillWidth: true
        }
        SButton {
            ui: root.ui
            text: "Copy"
            symbolName: "copy"
            enabled: !!root.ui.result && !root.ui.busy
            onClicked: {
                bridge.copy(root.ui.result.text);
                root.ui.notice = "Copied. Paste into your chosen field.";
            }
        }
    }
    Rectangle {
        Layout.fillWidth: true
        implicitHeight: 1
        color: root.ui.c.line
    }
    ScrollView {
        Layout.fillWidth: true
        Layout.fillHeight: true
        clip: true
        TextArea {
            objectName: "dictationTranscript"
            text: root.ui.result ? root.ui.result.text : root.ui.busy && root.ui.feedback.partialText ? root.ui.feedback.partialText : root.ui.activity.phase === "recording" ? "Listening. Live text appears when the recognition service provides it." : root.ui.busy ? "Waiting for transcription…" : "Your next thought will appear here."
            readOnly: true
            selectByMouse: true
            wrapMode: TextEdit.Wrap
            textFormat: TextEdit.PlainText
            color: root.ui.result || root.ui.feedback.partialText ? root.ui.c.ink : root.ui.c.muted
            font.pixelSize: 22
            background: null
            padding: 0
        }
    }
    SLabel {
        ui: root.ui
        Layout.fillWidth: true
        color: root.ui.c.muted
        font.pixelSize: 13
        text: root.ui.activity.phase === "failed" ? root.ui.snapshot.message : root.ui.result ? root.ui.result.delivery === "uncertain" ? "Insertion could not be confirmed. Check your field before copying to avoid a duplicate." : root.ui.result.delivery === "inserted" ? "Inserted at your cursor." : "Nothing was inserted. Your transcript is ready to copy." : root.ui.busy ? root.ui.feedback.partialText ? "Live text may change. Only the finished dictation is delivered." : root.ui.feedback.streamAvailable === false ? "Live feedback is unavailable. Dictation is still controlled by its recording session." : "You can cancel this take below." : ""
        visible: text.length > 0
    }
    Rectangle {
        Layout.fillWidth: true
        implicitHeight: 1
        color: root.ui.c.line
    }
    RowLayout {
        Layout.fillWidth: true
        MicrophoneTestButton {
            objectName: "microphoneTestButton"
            ui: root.ui
            Layout.fillWidth: true
        }
        SButton {
            objectName: "cancelDictationButton"
            ui: root.ui
            text: "Cancel"
            visible: root.ui.busy && ["preparing", "recording", "processing"].includes(root.ui.activity.phase)
            onClicked: bridge.request("cancel")
        }
        SButton {
            ui: root.ui
            text: "History"
            onClicked: root.ui.page = 1
        }
        SButton {
            ui: root.ui
            text: "⚙"
            Accessible.name: "This computer preferences"
            onClicked: root.ui.page = 4
        }
    }
}
