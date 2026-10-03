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
    readonly property var processing: record ? record.textProcessing : null
    readonly property var status: history.status(record)
    readonly property bool terminal: !!record && ["completed", "failed", "cancelled"].includes(record.status)
    readonly property bool interrupted: !!record && !!record.paused
    // Failed and interrupted takes need a decision; a banner holds the explanation and actions.
    readonly property bool problem: interrupted || (!!record && record.status === "failed")
    // A listed session holds only the transcript's tail until its full record loads.
    readonly property bool partial: !!record && !!record.summaryOnly
    readonly property bool retrying: !!record && history.retryingID === record.id
    readonly property bool canRetry: history.canRetry(record) && history.available && history.retrySupported && !history.acting && !history.retryingID && !bridge.preview
    property string copiedID: ""
    onRecordChanged: copiedID = ""

    function cleanupLabel(processing) {
        const status = processing.status || (processing.enabled ? "applied" : "disabled");
        return ({
            unavailable: "Cleanup unavailable",
            applied: "Text cleanup applied",
            unchanged: "Text cleanup made no changes",
            rejected: "Cleanup not used (kept recognized text)",
            failed: "Cleanup failed",
            skipped: "Cleanup skipped"
        })[status] || "";
    }

    // A zero budget means the engine has no vocabulary prompting at all.
    function hintText(title, hints) {
        if (!hints || !hints.omittedTerms.length)
            return "";
        if (hints.tokenBudget === 0)
            return "Vocabulary not used by this engine";
        return title + ": " + hints.omittedTerms.length + (hints.omittedTerms.length === 1 ? " term" : " terms") + " did not fit (" + hints.omittedTerms.join(", ") + ")";
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

    function interruptedText() {
        const saved = history.duration(record);
        const own = !!bridge.snapshot.device && bridge.snapshot.device.id === record.device.id;
        return "The recording stopped before it finished. " + (saved ? saved + " of audio is saved." : "Its audio is saved.") + (own ? "" : " Finish it on " + record.device.name + ".");
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
            // Interrupted takes are discarded from their banner.
            visible: !root.interrupted
            enabled: root.terminal && root.history.available && !root.history.acting && !root.history.loading && !bridge.preview
            onClicked: root.history.confirmDelete()
        }

    }

    SLabel {
        ui: root.ui
        objectName: "historyDetailDevice"
        Layout.fillWidth: true
        visible: !!root.record
        color: root.ui.c.muted
        font.pixelSize: 12
        text: root.record ? [root.record.device.name, root.record.importedSource ? "Wispr Flow" : "", root.problem ? root.history.duration(root.record) : ""].filter(part => !!part).join(" · ") : ""
    }

    Rectangle {
        id: bannerBox

        objectName: "historyBanner"
        readonly property color ink: root.interrupted ? root.ui.c.warning : root.ui.c.error

        visible: !!root.record && root.problem
        Layout.fillWidth: true
        implicitHeight: banner.implicitHeight + 24
        radius: 10
        color: root.interrupted ? root.ui.c.warningTint : root.ui.c.errorTint

        ColumnLayout {
            id: banner

            anchors.fill: parent
            anchors.margins: 12
            spacing: 8

            SLabel {
                ui: root.ui
                Layout.fillWidth: true
                text: root.status ? root.status.label : ""
                color: bannerBox.ink
                font.weight: Font.DemiBold
            }

            SLabel {
                ui: root.ui
                objectName: "historyBannerText"
                Layout.fillWidth: true
                color: bannerBox.ink
                text: !root.record ? "" : root.interrupted ? root.interruptedText() : root.record.error || "No transcript was produced."
            }

            Flow {
                Layout.fillWidth: true
                spacing: 8

                SButton {
                    ui: root.ui
                    objectName: "bannerRetryHistory"
                    primary: true
                    text: root.retrying ? "Transcribing…" : "Transcribe again"
                    visible: !root.interrupted && root.history.canRetry(root.record)
                    enabled: root.canRetry
                    ToolTip.visible: hovered && !root.history.retrySupported
                    ToolTip.text: "Update DictaDuo on the server to transcribe recordings again."
                    onClicked: root.history.transcribeAgain()
                }

                SButton {
                    ui: root.ui
                    objectName: "discardHistory"
                    text: root.history.deleting ? "Discarding…" : "Discard"
                    visible: root.interrupted
                    enabled: root.history.available && !root.history.acting && !root.history.loading && !bridge.preview
                    onClicked: root.history.confirmDelete()
                }

            }

        }

    }

    RowLayout {
        visible: !!root.record && !root.problem && !!root.status
        Layout.fillWidth: true
        spacing: 8

        HistoryChip {
            objectName: "historyDetailChip"
            ui: root.ui
            status: root.problem ? null : root.status
        }

        SLabel {
            ui: root.ui
            Layout.fillWidth: true
            color: root.ui.c.muted
            font.pixelSize: 12
            visible: !!text
            text: root.status ? root.status.detail : ""
        }

    }

    SLabel {
        ui: root.ui
        objectName: "historyRecognition"
        Layout.fillWidth: true
        visible: !!root.record && !root.problem && !!text
        color: root.ui.c.muted
        font.pixelSize: 12
        text: root.record ? root.history.recognitionLine(root.record) : ""
        HoverHandler {
            id: recognitionHover
        }
        ToolTip.visible: recognitionHover.hovered && !!ToolTip.text
        ToolTip.text: root.record ? [root.record.speech, root.record.proofreading].filter(model => !!model).map(model => model.modelID + " · " + model.backend).join("\n") : ""
    }

    // A failed retry of a finished take keeps the transcript and says why.
    Rectangle {
        objectName: "historyErrorBanner"
        visible: !!errorText.text
        Layout.fillWidth: true
        implicitHeight: errorText.implicitHeight + 24
        radius: 10
        color: root.ui.c.warningTint

        SLabel {
            id: errorText

            ui: root.ui
            anchors.fill: parent
            anchors.margins: 12
            color: root.ui.c.warning
            text: root.record && !root.problem ? root.record.error || "" : ""
        }

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
                visible: !!text
                // A problem banner already says why there is no transcript.
                text: !root.record ? "Select a dictation to read its transcript." : root.transcript || (root.problem ? "" : root.terminal ? "No transcript was produced." : "No transcript yet.")
            }

            CheckBox {
                id: original

                objectName: "showRawHistory"
                text: root.record && root.record.importedSource ? "Show Wispr Flow's transcript" : "Show original transcript"
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
                text: root.record && root.record.formattingRejectionReason ? "List formatting skipped: " + root.record.formattingRejectionReason : ""
            }

            SLabel {
                ui: root.ui
                objectName: "historyCleanup"
                Layout.fillWidth: true
                visible: !!text
                color: root.ui.c.muted
                font.pixelSize: 12
                text: root.processing && root.cleanupLabel(root.processing) ? root.cleanupLabel(root.processing) + (root.processing.reason ? ": " + root.processing.reason : "") : ""
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
                text: root.record ? root.hintText("Recognition vocabulary", root.record.recognitionHints) : ""
            }

            SLabel {
                ui: root.ui
                Layout.fillWidth: true
                color: root.ui.c.muted
                font.pixelSize: 12
                visible: !!text
                text: root.record ? root.hintText("Text cleanup vocabulary", root.record.proofreadingHints) : ""
            }


        }

    }

    Flow {
        visible: !!root.record
        Layout.fillWidth: true
        spacing: 8

        // Failed takes offer this in their banner. A finished take asks first.
        SButton {
            ui: root.ui
            objectName: "retryHistory"
            text: root.retrying ? "Transcribing…" : root.record && root.record.status === "completed" ? "Transcribe again…" : "Transcribe again"
            visible: !root.problem && root.history.canRetry(root.record)
            enabled: root.canRetry
            ToolTip.visible: hovered
            ToolTip.text: root.history.retrySupported ? "Transcribe the saved audio again. Nothing is pasted." : "Update DictaDuo on the server to transcribe recordings again."
            onClicked: root.history.transcribeAgain()
        }

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
