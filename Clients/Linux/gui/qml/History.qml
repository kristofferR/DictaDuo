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
    readonly property bool acting: deleting || audioID.length > 0
    readonly property bool available: bridge.connected && !bridge.snapshot.setupRequired && server === bridge.snapshot.server

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
        });
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

    Connections {
        function onReply(action, data) {
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
                if (data.record.id === root.entryID)
                    root.entryID = "";
                if (data.server !== root.server)
                    return ;

                root.records = root.records.map((r) => {
                    return r.id === data.record.id ? data.record : r;
                });
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

        function onFailed(action, message) {
            if (!["history", "historyEntry", "historyAudio", "historyArtifact", "deleteHistory"].includes(action))
                return ;

            if (action === "historyEntry")
                root.entryID = "";

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
                root.server = server;
                deleteDialog.close();
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
                required property var modelData

                width: ListView.view.width
                implicitHeight: summary.implicitHeight + 30
                onClicked: root.selectedID = modelData.id
                Accessible.name: modelData.device.name + ", " + (modelData.finalText || modelData.insertionText || modelData.previewText || modelData.status)

                contentItem: ColumnLayout {
                    id: summary

                    spacing: 8

                    SLabel {
                        ui: root.ui
                        text: new Date(modelData.createdAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
                        font.pixelSize: 12
                        color: root.ui.c.muted
                        Layout.fillWidth: true
                    }

                    SLabel {
                        ui: root.ui
                        text: modelData.finalText || modelData.insertionText || modelData.previewText || ({ receiving: "Recording…", queued: "Waiting to transcribe", transcribing: "Transcribing…", proofreading: "Cleaning up text…", failed: "Transcription failed", cancelled: "Cancelled", completed: "No speech" })[modelData.status] || modelData.status
                        maximumLineCount: 2
                        elide: Text.ElideRight
                        Layout.fillWidth: true
                    }

                    SLabel {
                        ui: root.ui
                        text: modelData.device.name + (modelData.importedSource ? " · Wispr Flow" : "")
                        font.pixelSize: 11
                        color: root.ui.c.muted
                        Layout.fillWidth: true
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

        objectName: "deleteHistoryDialog"
        title: "Delete this dictation?"
        parent: Overlay.overlay
        anchors.centerIn: parent
        modal: true
        width: 420

        contentItem: ColumnLayout {
            SLabel {
                ui: root.ui
                Layout.fillWidth: true
                text: "Its archived text and recordings will be removed from shared history on every device. This cannot be undone."
            }

            RowLayout {
                SButton {
                    ui: root.ui
                    text: "Keep dictation"
                    onClicked: deleteDialog.close()
                }

                SButton {
                    ui: root.ui
                    objectName: "confirmHistoryDelete"
                    text: "Delete dictation"
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

}
