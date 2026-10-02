import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQml.Models

ColumnLayout {
    id: root

    required property var ui
    required property var history
    readonly property var record: history.selected
    readonly property string transcript: record ? record.finalText || record.insertionText || record.previewText || "" : ""
    readonly property var audio: record ? record.inferenceAudio || record.originalAudio : null
    readonly property var processing: record ? record.textProcessing : null
    readonly property bool terminal: !!record && ["completed", "failed", "cancelled"].includes(record.status)
    // A listed session holds only the transcript's tail until its full record loads.
    readonly property bool partial: !!record && !!record.summaryOnly
    property string copiedID: ""
    onRecordChanged: copiedID = ""

    function model(value) {
        return value ? value.modelID + " · " + value.backend : "";
    }

    function sourceLabel(filename) {
        return ({
            "source.json": "Full source data",
            "source.wav": "Wispr Flow audio",
            "opus.json": "Opus packets",
            "screenshot.png": "Screenshot",
            "built-in-audio.bin": "Built-in audio"
        })[filename] || filename;
    }

    function duration() {
        const value = audio && audio.sampleRate ? audio.frameCount / audio.sampleRate : record && record.importedSource ? record.importedSource.durationSeconds : undefined;
        if (value === undefined || value <= 0)
            return "";

        const seconds = Math.round(value);
        return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
    }

    spacing: 12

    RowLayout {
        visible: !!root.record
        SLabel {
            ui: root.ui
            objectName: "historyDetailDate"
            text: root.record ? new Date(root.record.createdAt).toLocaleString(undefined, { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""
            Layout.fillWidth: true
            font.weight: Font.DemiBold
        }

        SButton {
            ui: root.ui
            objectName: "copyHistory"
            symbolName: root.record && root.copiedID === root.record.id ? "check" : "copy"
            accessibleLabel: root.record && root.copiedID === root.record.id ? "Copied transcript" : "Copy transcript"
            ToolTip.visible: hovered
            ToolTip.text: accessibleLabel
            enabled: !root.partial && root.transcript.length > 0
            onClicked: {
                bridge.copy(root.transcript);
                root.copiedID = root.record.id;
                root.history.message = "Copied.";
            }
        }

        SButton {
            ui: root.ui
            objectName: "deleteHistory"
            text: root.history.deleting ? "Deleting…" : "Delete"
            enabled: root.terminal && root.history.available && !root.history.acting && !root.history.loading && !bridge.preview
            onClicked: root.history.confirmDelete()
        }

    }

    SLabel {
        ui: root.ui
        Layout.fillWidth: true
        visible: !!root.record
        color: root.ui.c.muted
        font.pixelSize: 12
        text: root.record ? root.record.device.name + " · " + (root.record.importedSource ? "Wispr Flow · " : "SottoDuo · ") + root.record.status + (root.duration() ? " · " + root.duration() : "") + " · Delivery: " + (root.record.delivery ? root.record.delivery.status : "not reported") : ""
    }

    ScrollView {
        id: scroll
        visible: !!root.record

        Layout.fillWidth: true
        Layout.fillHeight: true
        contentWidth: availableWidth
        clip: true

        ColumnLayout {
            width: scroll.availableWidth
            spacing: 16

            SLabel {
                ui: root.ui
                Layout.fillWidth: true
                visible: !!text
                text: root.record ? root.record.error || "" : ""
            }

            SLabel {
                ui: root.ui
                objectName: "historyPartial"
                Layout.fillWidth: true
                visible: root.partial
                color: root.ui.c.muted
                font.pixelSize: 12
                text: root.history.entryID === (root.record ? root.record.id : "") ? "Loading the full transcript…" : "Showing only the end of this transcript. Select it again to load all of it."
            }

            TextArea {
                objectName: "historyTranscript"
                Layout.fillWidth: true
                readOnly: true
                selectByMouse: true
                wrapMode: TextEdit.Wrap
                textFormat: TextEdit.PlainText
                padding: 0
                background: null
                color: root.ui.c.ink
                font.pixelSize: 19
                text: root.record ? root.transcript || "No transcript was produced." : "Select a dictation to read its transcript."
            }

            CheckBox {
                id: original

                objectName: "showRawHistory"
                text: root.record && root.record.importedSource ? "Show original recognition (Wispr Flow)" : "Show original recognition"
                visible: !!root.record && !!root.record.rawText && root.record.rawText !== root.transcript
                onVisibleChanged: checked = false
            }

            TextArea {
                objectName: "historyRawText"
                Layout.fillWidth: true
                visible: original.visible && original.checked
                readOnly: true
                selectByMouse: true
                wrapMode: TextEdit.Wrap
                textFormat: TextEdit.PlainText
                padding: 0
                background: null
                color: root.ui.c.muted
                text: root.record ? root.record.rawText || "" : ""
            }

            SLabel {
                ui: root.ui
                Layout.fillWidth: true
                visible: !!text
                text: root.record ? root.record.formattingRejectionReason || "" : ""
            }

            SLabel {
                ui: root.ui
                Layout.fillWidth: true
                visible: !!text
                text: root.processing ? "Text cleanup: " + (root.processing.status || (root.processing.enabled ? "enabled" : "disabled")) + (root.processing.reason ? "\n" + root.processing.reason : "") : ""
            }

            CheckBox {
                id: rejected

                text: "Show rejected cleanup"
                visible: !!root.processing && root.processing.status === "rejected" && !!root.processing.proposedText
                onVisibleChanged: checked = false
            }

            TextArea {
                Layout.fillWidth: true
                visible: rejected.visible && rejected.checked
                readOnly: true
                selectByMouse: true
                wrapMode: TextEdit.Wrap
                textFormat: TextEdit.PlainText
                padding: 0
                background: null
                color: root.ui.c.muted
                text: root.processing ? root.processing.proposedText || "" : ""
            }

            SLabel {
                ui: root.ui
                Layout.fillWidth: true
                color: root.ui.c.muted
                font.pixelSize: 12
                visible: !!text
                text: root.record && root.record.recognitionHints && root.record.recognitionHints.omittedTerms.length ? "Voice vocabulary omitted: " + root.record.recognitionHints.omittedTerms.join(", ") : ""
            }

            SLabel {
                ui: root.ui
                Layout.fillWidth: true
                color: root.ui.c.muted
                font.pixelSize: 12
                visible: !!text
                text: root.record && root.record.proofreadingHints && root.record.proofreadingHints.omittedTerms.length ? "Cleanup vocabulary omitted: " + root.record.proofreadingHints.omittedTerms.join(", ") : ""
            }

            SLabel {
                ui: root.ui
                Layout.fillWidth: true
                color: root.ui.c.muted
                font.pixelSize: 12
                visible: !!text
                text: root.record && root.record.speech ? "Speech: " + root.model(root.record.speech) : ""
            }

            SLabel {
                ui: root.ui
                Layout.fillWidth: true
                color: root.ui.c.muted
                font.pixelSize: 12
                visible: !!text
                text: root.record && root.record.proofreading ? "Text cleanup: " + root.model(root.record.proofreading) : ""
            }

        }

    }

    Flow {
        visible: !!root.record
        Layout.fillWidth: true
        spacing: 8

        SButton {
            ui: root.ui
            objectName: "openHistoryAudio"
            text: "Open audio"
            visible: !!root.record && !!root.record.inferenceAudio
            enabled: root.history.available && !root.history.acting && !bridge.preview
            onClicked: root.history.openAudio("inference")
        }

        SButton {
            ui: root.ui
            text: "Open original recording"
            visible: !!root.record && !!root.record.originalAudio
            enabled: root.history.available && !root.history.acting && !bridge.preview
            onClicked: root.history.openAudio("original")
        }

        // Runs recorded in different formats are saved, and opened, separately.
        Repeater {
            model: root.record ? root.record.originalRuns || [] : []
            delegate: SButton {
                required property var modelData
                required property int index
                ui: root.ui
                text: "Open original recording, part " + (index + 1)
                enabled: root.history.available && !root.history.acting && !bridge.preview
                onClicked: root.history.openAudio("original", modelData.runID)
            }
        }

        SButton {
            ui: root.ui
            text: "Open Wispr Flow audio"
            visible: !!root.record && !!root.record.importedSource && (root.record.importedSource.artifactNames || []).includes("source.wav")
            enabled: root.history.available && !root.history.acting && !bridge.preview
            onClicked: root.history.openAudio("imported")
        }

        SButton {
            id: sourceFilesButton
            ui: root.ui
            text: "Source files"
            visible: !!root.record && (root.record.importedSource?.artifactNames || []).length > 0
            enabled: root.history.available && !root.history.acting && !bridge.preview
            onClicked: sourceFilesMenu.popup()
            Menu {
                id: sourceFilesMenu
                Instantiator {
                    model: root.record?.importedSource?.artifactNames || []
                    delegate: MenuItem {
                        required property string modelData
                        text: root.sourceLabel(modelData)
                        onTriggered: root.history.openArtifact(modelData)
                    }
                    onObjectAdded: (index, object) => sourceFilesMenu.insertItem(index, object)
                    onObjectRemoved: (index, object) => sourceFilesMenu.removeItem(object)
                }
            }
        }

    }

    Item {
        visible: !root.record
        Layout.fillWidth: true
        Layout.fillHeight: true
        ColumnLayout {
            anchors.centerIn: parent
            spacing: 12
            SLabel {
                ui: root.ui
                text: "☰"
                font.pixelSize: 45
                color: root.ui.c.muted
                Layout.alignment: Qt.AlignHCenter
            }
            SLabel {
                ui: root.ui
                text: "Select a dictation"
                font.pixelSize: 22
                font.weight: Font.DemiBold
                color: root.ui.c.muted
                Layout.alignment: Qt.AlignHCenter
            }
        }
    }

}
