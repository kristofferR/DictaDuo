import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: root

    required property var ui
    property var records: []
    property string selectedID: ""
    property string deviceID: ""
    property string deviceName: ""
    property string source: ""
    property string server: ""
    property string cursor: ""
    property bool loading: false
    property bool retriedRead: false
    property bool append: false
    property bool deleting: false
    // A retry request is in flight; `retryingID` is then followed until it settles.
    property bool retryStarting: false
    property string retryingID: ""
    // The server `retryingID` belongs to; a reconnect to the same server keeps following it.
    property string retryServer: ""
    // Starting a retry ignores detail loads sent before it, which carry the old transcript.
    property int entryEpoch: 0
    // Status reads that failed in a row while following a retry.
    property int retryFailures: 0
    property string audioID: ""
    property string entryID: ""
    property string audioKind: ""
    property string message: ""
    property string queryID: ""
    property int sequence: 0
    property string instanceID: Date.now() + "-" + Math.random().toString(36).slice(2)
    readonly property var devices: {
        const seen = new Set();
        const values = [{
            "id": "",
            "name": "All devices"
        }].concat(records.map((r) => {
            return r.device;
        }).filter((d) => {
            if (seen.has(d.id))
                return false;

            seen.add(d.id);
            return true;
        }));
        if (deviceID && !seen.has(deviceID))
            values.push({
            "id": deviceID,
            "name": deviceName || "Selected device (not loaded)"
        });

        return values;
    }
    readonly property var filtered: records.filter((r) => {
        return (!deviceID || r.device.id === deviceID) && (!source || (source === "sottoduo" ? !r.importedSource : r.importedSource?.provider === "wispr-flow"));
    })
    readonly property var selected: filtered.find((r) => {
        return r.id === selectedID;
    }) || null
    readonly property bool acting: deleting || retryStarting || audioID.length > 0
    readonly property bool available: bridge.connected && !bridge.snapshot.setupRequired && server === bridge.snapshot.server
    readonly property bool retrySupported: !!ui.health && ui.health.generationRetry === true

    // Shared label tables: the Mac client uses the same words and tones.
    function deliveryStatus(status) {
        return ({
            inserted: { label: "Pasted", tone: "ok", detail: "Pasted at your cursor." },
            listUpdated: { label: "List updated", tone: "ok", detail: "The list was updated. Nothing was pasted." },
            copied: { label: "Copied", tone: "neutral", detail: "Copied to the clipboard." },
            unconfirmed: { label: "Check the field", tone: "warning", detail: "The paste could not be confirmed." },
            cancelled: { label: "Not pasted", tone: "neutral", detail: "You cancelled this take." },
            none: { label: "Not pasted", tone: "neutral", detail: "Nothing was pasted." },
            failed: { label: "Couldn't paste", tone: "error", detail: "The text is saved here to copy." },
            tested: { label: "Test (no paste)", tone: "accent", detail: "Microphone test. Nothing is pasted." }
        })[status] || null;
    }

    // Problems and progress come first, then how the text was delivered.
    function status(record) {
        if (!record)
            return null;
        if (record.paused)
            return { label: "Interrupted", tone: "warning", detail: "" };
        const progress = ({
            receiving: "Recording",
            queued: "Waiting to transcribe",
            transcribing: "Transcribing",
            proofreading: "Cleaning up text"
        })[record.status];
        if (progress)
            return { label: progress, tone: "neutral", detail: "" };
        if (record.status === "failed")
            return { label: "Couldn't transcribe", tone: "error", detail: "" };
        if (record.status === "cancelled")
            return deliveryStatus("cancelled");
        // List summaries of recording sessions carry no delivery receipt.
        return deliveryStatus(record.delivery ? record.delivery.status : "") || (record.mode === "test" ? deliveryStatus("tested") : { label: "Done", tone: "neutral", detail: "" });
    }

    function languageName(code) {
        if (!code)
            return "";
        return ({
            ar: "Arabic", cs: "Czech", da: "Danish", de: "German", el: "Greek", en: "English",
            es: "Spanish", fi: "Finnish", fr: "French", hi: "Hindi", hu: "Hungarian", is: "Icelandic",
            it: "Italian", ja: "Japanese", ko: "Korean", nb: "Norwegian Bokmål", nl: "Dutch",
            nn: "Norwegian Nynorsk", no: "Norwegian", pl: "Polish", pt: "Portuguese", ro: "Romanian",
            ru: "Russian", sv: "Swedish", tr: "Turkish", uk: "Ukrainian", zh: "Chinese"
        })[code.toLowerCase().split(/[-_]/)[0]] || code;
    }

    function duration(record) {
        const audio = record ? record.inferenceAudio || record.originalAudio : null;
        const value = audio && audio.sampleRate ? audio.frameCount / audio.sampleRate : record && record.importedSource ? record.importedSource.durationSeconds : undefined;
        if (value === undefined || value <= 0)
            return "";
        const seconds = Math.round(value);
        return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
    }

    // How the speech was recognized, its language and length.
    function recognitionLine(record) {
        const recognition = record.recognition;
        const backend = record.speech ? record.speech.backend : "";
        const how = recognition ? (recognition.provider === "soniox" ? "Recognized with cloud" : recognition.fallbackReason ? "Recognized locally (cloud unavailable)" : "Recognized locally") : backend ? (backend.startsWith("soniox") ? "Recognized with cloud" : "Recognized locally") : "";
        return [how, languageName(record.detectedLanguage), duration(record)].filter(part => !!part).join(" · ");
    }

    // The server keeps saved audio for finished, failed and cancelled takes; interrupted ones must be finished first.
    function canRetry(record) {
        // Finished takes need a server that lists the addition.
        const completedRetry = !!ui.health && (ui.health.features || []).includes("retry-completed");
        return !!record && !record.importedSource && !!record.inferenceAudio && !record.paused && !record.capturing && (["failed", "cancelled"].includes(record.status) || record.status === "completed" && completedRetry);
    }

    // A retry runs on the take's own engine and language, or Whisper if that engine is gone.
    function engineSummary(record) {
        const preferences = record && record.settings ? record.settings.preferences : null;
        if (!preferences)
            return "";
        const installed = (ui.health && ui.health.recognitionEngines) || ["whisper"];
        const parakeet = preferences.recognitionEngine === "parakeet" && installed.includes("parakeet");
        const language = parakeet || preferences.language === "auto" ? "Detect automatically" : languageName(preferences.language);
        return "Current engine: " + (parakeet ? "Parakeet" : "Whisper") + ", language " + language + ".";
    }

    // A finished take asks first because the new transcript replaces it.
    function transcribeAgain() {
        if (!canRetry(selected) || !available || acting || retryingID || !retrySupported || bridge.preview)
            return;
        if (selected.status === "completed") {
            retryDialog.recordID = selected.id;
            retryDialog.recordServer = server;
            retryDialog.engine = engineSummary(selected);
            retryDialog.open();
            return;
        }
        startRetry(selected.id, server);
    }

    function startRetry(id, recordServer) {
        retryStarting = true;
        retryingID = id;
        retryServer = recordServer;
        entryEpoch++;
        entryID = "";
        retryFailures = 0;
        message = "Starting to transcribe again…";
        bridge.request("retryHistory", {
            "id": id,
            "server": recordServer
        });
    }

    function reconcile() {
        if (selectedID && !filtered.some((r) => {
            return r.id === selectedID;
        }))
            selectedID = filtered.length ? filtered[0].id : "";

    }

    // A completed session is listed as a summary; load its full record when selected.
    function loadEntry() {
        if (!selected || !selected.summaryOnly || entryID === selected.id || !available || bridge.preview)
            return;
        entryID = selected.id;
        bridge.request("historyEntry", {
            "id": entryID,
            "server": server
        }, "entry-" + entryEpoch);
    }

    function load(older, retry) {
        if (loading || deleting || !available)
            return ;

        append = older;
        if (!retry) retriedRead = false;
        loading = true;
        message = "";
        queryID = instanceID + "-" + (++sequence);
        const args = {
            "queryID": queryID
        };
        if (older)
            args.before = cursor;

        if (source)
            args.source = source;

        bridge.request("history", args);
    }

    function maybeLoadOlder() {
        if (!visible || !cursor || loading || acting || !available)
            return;

        if (historyList.contentY + historyList.height >= historyList.contentHeight - 48)
            load(true);
    }

    function filterSource(value) {
        if (loading || acting)
            return ;

        source = value;
        deviceID = "";
        records = [];
        selectedID = "";
        cursor = "";
        load(false);
    }

    function openAudio(kind, runID) {
        if (!selected || acting || !available || bridge.preview)
            return ;

        audioID = selected.id;
        audioKind = kind;
        message = "Downloading saved audio…";
        const request = {
            "id": audioID,
            "kind": kind,
            "server": server
        };
        if (runID)
            request.runID = runID;
        bridge.request("historyAudio", request);
    }

    function openArtifact(filename) {
        if (!selected || acting || !available || bridge.preview || !(selected.importedSource?.artifactNames || []).includes(filename))
            return;
        audioID = selected.id;
        audioKind = filename;
        message = "Downloading saved source file…";
        bridge.request("historyArtifact", {
            "id": audioID,
            "filename": filename,
            "server": server
        });
    }

    function confirmDelete() {
        if (!selected || !available || acting || bridge.preview)
            return ;

        deleteDialog.recordID = selected.id;
        deleteDialog.recordServer = server;
        deleteDialog.interrupted = !!selected.paused;
        deleteDialog.open();
    }

    objectName: "historyPage"
    spacing: 14
    onFilteredChanged: reconcile()
    onSelectedChanged: loadEntry()
    onVisibleChanged: if (visible) Qt.callLater(maybeLoadOlder)
    Component.onCompleted: {
        server = bridge.snapshot.server || "";
        load(false);
    }

    // Follows a take being transcribed again until it settles.
    Timer {
        interval: 1500
        repeat: true
        running: root.retryingID.length > 0 && !root.retryStarting && root.available && !bridge.preview
        onTriggered: bridge.request("historyEntry", {
            "id": root.retryingID,
            "server": root.server
        }, "retry")
    }

    Connections {
        function onReply(action, data, requestID) {
            if (action === "history") {
                if (!bridge.preview && (data.queryID !== root.queryID || data.server !== root.server)) {
                    root.loading = false;
                    if (!root.retriedRead) {
                        root.retriedRead = true;
                        root.load(false, true);
                    } else {
                        root.message = "History could not be matched to this server. Update SottoDuo's background client, then refresh history.";
                    }
                    return ;
                }
                root.retriedRead = false;
                const next = root.append ? root.records.concat(data.items) : data.items;
                const seen = new Set();
                root.records = next.filter((r) => {
                    if (seen.has(r.id))
                        return false;

                    seen.add(r.id);
                    return true;
                });
                root.cursor = root.append && (data.nextCursor === root.cursor || data.items.length === 0) ? "" : data.nextCursor || "";
                root.loading = false;
                root.reconcile();
                Qt.callLater(root.maybeLoadOlder);
            }
            if (action === "historyEntry") {
                if (requestID !== "retry" && requestID !== "entry-" + root.entryEpoch)
                    return ;

                if (data.record.id === root.entryID)
                    root.entryID = "";
                if (data.server !== root.server)
                    return ;

                root.records = root.records.map((r) => {
                    return r.id === data.record.id ? data.record : r;
                });
                if (requestID === "retry")
                    root.retryFailures = 0;
                if (requestID === "retry" && data.record.id === root.retryingID && ["completed", "failed", "cancelled"].includes(data.record.status) && !data.record.paused) {
                    root.retryingID = "";
                    root.message = data.record.error || "Transcribed again.";
                }
            }
            if (action === "retryHistory") {
                root.retryStarting = false;
                if (data.server !== root.server)
                    return ;

                root.records = root.records.map((r) => {
                    return r.id === data.record.id ? data.record : r;
                });
                root.message = "Transcribing again. Nothing is pasted.";
            }
            if (action === "deleteHistory") {
                root.deleting = false;
                if (data.server !== root.server)
                    return ;

                root.records = root.records.filter((r) => {
                    return r.id !== data.id;
                });
                root.reconcile();
                // A deleted record may have been the pagination cursor.
                root.load(false);
                root.message = "Deleted from shared history.";
            }
            if (action === "historyAudio" || action === "historyArtifact") {
                const wanted = root.audioID === data.id && root.audioKind === (action === "historyAudio" ? data.kind : data.filename) && data.server === root.server && root.selectedID === data.id;
                root.audioID = "";
                if (!wanted)
                    return ;

                root.message = Qt.openUrlExternally(data.url) ? "Opened saved file." : "No application could open this saved file. Choose a default app in your desktop settings.";
            }
        }

        function onFailed(action, message, requestID) {
            if (!["history", "historyEntry", "retryHistory", "historyAudio", "historyArtifact", "deleteHistory"].includes(action))
                return ;

            if (action === "historyEntry" && requestID === "retry") {
                // A brief outage does not end the retry on the server; keep following it.
                if (++root.retryFailures < 20)
                    return ;
                root.retryingID = "";
            } else if (action === "historyEntry" && requestID === "entry-" + root.entryEpoch)
                root.entryID = "";

            if (action === "retryHistory") {
                root.retryStarting = false;
                root.retryingID = "";
            }

            if (action === "history")
                root.loading = false;

            if (action === "historyAudio" || action === "historyArtifact")
                root.audioID = "";

            if (action === "deleteHistory")
                root.deleting = false;

            root.message = message;
        }

        function onSnapshotChanged() {
            const server = bridge.snapshot.server || "";
            if (!bridge.connected || root.server !== server) {
                root.records = [];
                root.selectedID = "";
                root.cursor = "";
                root.deviceID = "";
                root.audioID = "";
                root.entryID = "";
                root.loading = false;
                root.deleting = false;
                root.retryStarting = false;
                if (bridge.connected && server !== root.retryServer)
                    root.retryingID = "";
                root.server = server;
                deleteDialog.close();
                retryDialog.close();
                if (bridge.connected)
                    root.load(false);

            }
        }

        target: bridge
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 12
        SLabel {
            ui: root.ui
            text: "History"
            font.pixelSize: 28
            font.weight: Font.DemiBold
            Layout.fillWidth: true
        }

        ComboBox {
            objectName: "historyDeviceFilter"
            Layout.preferredWidth: 178
            model: root.devices
            textRole: "name"
            currentIndex: Math.max(0, root.devices.findIndex((d) => {
                return d.id === root.deviceID;
            }))
            Accessible.name: "Device in loaded history"
            enabled: !root.acting
            onActivated: {
                root.deviceName = root.devices[currentIndex].name;
                root.deviceID = root.devices[currentIndex].id;
            }
        }

        ComboBox {
            objectName: "historySourceFilter"
            Layout.preferredWidth: 146
            model: ["All sources", "SottoDuo", "Wispr Flow"]
            currentIndex: ["", "sottoduo", "wispr-flow"].indexOf(root.source)
            enabled: !root.loading && !root.acting && root.available
            Accessible.name: "History source"
            onActivated: root.filterSource(["", "sottoduo", "wispr-flow"][currentIndex])
        }

        SButton {
            ui: root.ui
            objectName: "refreshHistory"
            symbolName: "refresh"
            accessibleLabel: "Refresh shared history"
            ToolTip.visible: hovered
            ToolTip.text: "Refresh shared history"
            enabled: !root.loading && !root.acting && root.available
            onClicked: root.load(false)
        }

    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 9
        StatusDot {
            objectName: "historyConnectionDot"
            ready: root.ui.serverReady
        }
        SLabel {
            ui: root.ui
            text: root.ui.connection
            Layout.fillWidth: true
        }
        SLabel {
            ui: root.ui
            text: root.ui.snapshot.server || ""
            color: root.ui.c.muted
        }
    }

    SLabel {
        ui: root.ui
        objectName: "historyMessage"
        text: root.message
        visible: text.length > 0
        Layout.fillWidth: true
    }

    SplitView {
        Layout.fillWidth: true
        Layout.fillHeight: true
        orientation: Qt.Horizontal
        handle: Rectangle {
            objectName: "historyResizeHandle"
            implicitWidth: 12
            color: "transparent"
            Rectangle {
                anchors.centerIn: parent
                width: SplitHandle.hovered || SplitHandle.pressed ? 3 : 1
                height: parent.height
                color: SplitHandle.hovered || SplitHandle.pressed ? root.ui.c.accent : root.ui.c.line
            }
            HoverHandler {
                cursorShape: Qt.SplitHCursor
            }
        }

        ListView {
            id: historyList
            objectName: "historyList"
            SplitView.preferredWidth: Math.max(225, root.width * 0.38)
            SplitView.minimumWidth: 220
            SplitView.maximumWidth: 380
            SplitView.fillHeight: true
            clip: true
            model: root.filtered
            spacing: 0
            onContentYChanged: root.maybeLoadOlder()
            onContentHeightChanged: root.maybeLoadOlder()
            onHeightChanged: root.maybeLoadOlder()

            SLabel {
                ui: root.ui
                anchors.centerIn: parent
                width: parent.width
                text: root.loading ? "Loading history…" : "No dictations to show."
                visible: root.filtered.length === 0
                color: root.ui.c.muted
            }

            ScrollBar.vertical: ScrollBar {
            }

            delegate: ItemDelegate {
                id: row

                required property var modelData
                readonly property var rowStatus: root.status(modelData)
                readonly property string transcript: modelData.finalText || modelData.insertionText || modelData.previewText || ""

                width: ListView.view.width
                implicitHeight: summary.implicitHeight + 30
                onClicked: root.selectedID = modelData.id
                Accessible.name: modelData.device.name + ", " + summaryText.text + (rowStatus ? ", " + rowStatus.label : "")

                contentItem: ColumnLayout {
                    id: summary

                    spacing: 7

                    SLabel {
                        ui: root.ui
                        text: new Date(modelData.createdAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) + " · " + modelData.device.name + (modelData.importedSource ? " · Wispr Flow" : "")
                        font.pixelSize: 12
                        color: root.ui.c.muted
                        elide: Text.ElideRight
                        maximumLineCount: 1
                        Layout.fillWidth: true
                    }

                    SLabel {
                        id: summaryText
                        ui: root.ui
                        text: row.transcript || (modelData.paused ? (root.duration(modelData) ? root.duration(modelData) + " of audio saved" : "Audio saved") : modelData.status === "failed" ? "No transcript" : modelData.status === "completed" || modelData.status === "cancelled" ? "No speech" : "No transcript yet")
                        color: row.transcript ? root.ui.c.ink : root.ui.c.muted
                        maximumLineCount: 2
                        elide: Text.ElideRight
                        Layout.fillWidth: true
                    }

                    HistoryChip {
                        ui: root.ui
                        status: row.rowStatus
                    }

                }

                background: Rectangle {
                    radius: 8
                    color: root.selectedID === modelData.id ? root.ui.c.tint : parent.hovered ? root.ui.c.surface : "transparent"
                    border.width: parent.activeFocus ? 2 : 0
                    border.color: root.ui.c.accent
                }
                Rectangle {
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.bottom: parent.bottom
                    anchors.leftMargin: 12
                    anchors.rightMargin: 12
                    height: 1
                    color: root.ui.c.line
                    opacity: 0.7
                }

            }

        }

        HistoryDetail {
            ui: root.ui
            history: root
            SplitView.minimumWidth: 280
            SplitView.fillWidth: true
            SplitView.fillHeight: true
        }

    }

    RowLayout {
        Layout.fillWidth: true
        SLabel {
            ui: root.ui
            text: root.records.length + (root.records.length === 1 ? " dictation" : " dictations") + (root.cursor ? " loaded" : "")
            color: root.ui.c.muted
            Layout.fillWidth: true
        }
        SLabel {
            ui: root.ui
            text: "Loading older…"
            color: root.ui.c.muted
            visible: root.loading && root.append
        }
    }

    Dialog {
        id: deleteDialog

        property string recordID: ""
        property string recordServer: ""
        property bool interrupted: false

        objectName: "deleteHistoryDialog"
        title: interrupted ? "Discard this recording?" : "Delete this dictation?"
        parent: Overlay.overlay
        anchors.centerIn: parent
        modal: true
        width: 420

        contentItem: ColumnLayout {
            SLabel {
                ui: root.ui
                Layout.fillWidth: true
                text: deleteDialog.interrupted ? "Its saved audio will be removed from shared history on every device. This cannot be undone." : "Its archived text and recordings will be removed from shared history on every device. This cannot be undone."
            }

            RowLayout {
                SButton {
                    ui: root.ui
                    text: deleteDialog.interrupted ? "Keep recording" : "Keep dictation"
                    onClicked: deleteDialog.close()
                }

                SButton {
                    ui: root.ui
                    objectName: "confirmHistoryDelete"
                    text: deleteDialog.interrupted ? "Discard recording" : "Delete dictation"
                    enabled: root.available && !root.acting && !bridge.preview && deleteDialog.recordServer === root.server
                    onClicked: {
                        root.deleting = true;
                        root.message = "Deleting…";
                        bridge.request("deleteHistory", {
                            "id": deleteDialog.recordID,
                            "server": deleteDialog.recordServer
                        });
                        deleteDialog.close();
                    }
                }

            }

        }

    }

    Dialog {
        id: retryDialog

        property string recordID: ""
        property string recordServer: ""
        property string engine: ""

        objectName: "retryHistoryDialog"
        title: "Transcribe this take again?"
        parent: Overlay.overlay
        anchors.centerIn: parent
        modal: true
        width: 420

        contentItem: ColumnLayout {
            SLabel {
                ui: root.ui
                Layout.fillWidth: true
                text: "The new transcript replaces the current one in History on every device. Nothing is pasted." + (retryDialog.engine ? " " + retryDialog.engine : "")
            }

            RowLayout {
                Layout.alignment: Qt.AlignRight
                SButton {
                    ui: root.ui
                    text: "Cancel"
                    onClicked: retryDialog.close()
                }

                SButton {
                    ui: root.ui
                    objectName: "confirmHistoryRetry"
                    primary: true
                    text: "Transcribe again"
                    enabled: root.available && !root.acting && !root.retryingID && !bridge.preview && retryDialog.recordServer === root.server
                    onClicked: {
                        root.startRetry(retryDialog.recordID, retryDialog.recordServer);
                        retryDialog.close();
                    }
                }

            }

        }

    }

}
