import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Group {
    id: root
    objectName: "connectionSettings"
    title: "Connection"
    property string ticket: ""
    property var hosts: []
    property string hostName: ""
    property string message: ""
    property bool pending: false
    property bool tested: false
    property bool dirty: false
    property bool editing: false
    readonly property bool configured: !ui.snapshot.setupRequired && !!ui.snapshot.server
    property string activeRequestID: ""
    function loadConnection() {
        server.text = ui.snapshot.server || "";
        deviceName.text = ui.snapshot.device ? ui.snapshot.device.name : "This computer";
    }
    Component.onCompleted: loadConnection()
    readonly property bool available: bridge.connected && !bridge.preview && !ui.snapshot.connectionChanging
    function edited() {
        ticket = "";
        tested = false;
        message = "";
        activeRequestID = "";
    }
    function clearSecret() {
        accessToken.clear();
    }
    Connections {
        target: root.ui
        function onVisibleChanged() {
            if (!root.ui.visible) {
                root.clearSecret();
                root.edited();
                root.pending = false;
            }
        }
    }
    Connections {
        target: bridge
        function onReply(action, data, requestID) {
            if (requestID !== root.activeRequestID || !root.pending)
                return;
            if (action === "testConnection") {
                root.pending = false;
                root.activeRequestID = "";
                if (!root.ui.visible)
                    return;
                root.ticket = data.ticket;
                root.hosts = data.hosts;
                root.hostName = data.hostName || "";
                hostPicker.currentIndex = root.hosts.indexOf(data.hostID);
                hostID.text = data.hostID || "";
                root.tested = true;
                root.message = data.message;
            } else if (action === "saveConnection") {
                root.pending = false;
                root.activeRequestID = "";
                root.ticket = "";
                root.tested = false;
                root.dirty = false;
                root.editing = false;
                root.message = "Connection saved. Dictate here once to point the DJI button back at this computer.";
                root.clearSecret();
                bridge.request("snapshot");
                root.ui.refresh();
            }
        }
        function onFailed(action, message, requestID) {
            if (requestID === root.activeRequestID && root.pending && ["testConnection", "saveConnection"].includes(action)) {
                root.pending = false;
                root.activeRequestID = "";
                root.ticket = "";
                root.message = message;
                root.clearSecret();
            }
        }
        function onSnapshotChanged() {
            if (bridge.connected && !root.dirty && !root.pending && !root.ticket)
                root.loadConnection();
            if (!bridge.connected) {
                root.pending = false;
                root.clearSecret();
                root.edited();
            }
        }
    }
    ColumnLayout {
        visible: root.configured && !root.editing
        Layout.fillWidth: true
        Layout.margins: 12
        spacing: 0
        Setting {
            ui: root.ui
            title: "Server address"
            SLabel {
                ui: root.ui
                text: root.ui.snapshot.server || ""
                color: root.ui.c.muted
            }
        }
        Setting {
            ui: root.ui
            title: "Access token"
            SLabel {
                ui: root.ui
                text: "Saved"
                color: root.ui.c.muted
            }
        }
        Setting {
            ui: root.ui
            title: "Device name"
            SLabel {
                ui: root.ui
                text: root.ui.snapshot.device?.name || "This computer"
                color: root.ui.c.muted
            }
        }
        RowLayout {
            Layout.fillWidth: true
            Layout.margins: 14
            spacing: 9
            StatusDot {
                objectName: "computerConnectionDot"
                ready: root.ui.serverReady
            }
            SLabel {
                ui: root.ui
                text: root.ui.connection
                Layout.fillWidth: true
            }
            SLabel {
                ui: root.ui
                objectName: "connectionStatusAddress"
                text: root.ui.snapshot.server || ""
                color: root.ui.c.muted
                wrapMode: Text.NoWrap
                elide: Text.ElideMiddle
                Layout.preferredWidth: Math.min(260, root.width * 0.35)
            }
            SButton {
                ui: root.ui
                text: "Edit connection"
                onClicked: root.editing = true
            }
        }
        Rectangle {
            Layout.fillWidth: true
            Layout.leftMargin: 14
            Layout.rightMargin: 14
            Layout.preferredHeight: 1
            color: root.ui.c.line
            opacity: 0.65
        }
    }
    ColumnLayout {
        visible: !root.configured || root.editing
        Layout.fillWidth: true
        Layout.margins: 12
        spacing: 10
        SLabel {
            ui: root.ui
            Layout.fillWidth: true
            text: "Connect this computer to your SottoDuo server. Shared transcription settings are in Server preferences."
            color: root.ui.c.muted
        }
        SLabel {
            ui: root.ui
            text: "Server address"
        }
        TextField {
            id: server
            objectName: "connectionServer"
            Layout.fillWidth: true
            placeholderText: "http://your-server:8391"
            Accessible.name: "Server address"
            enabled: root.available && !root.pending
            placeholderTextColor: root.ui.c.muted
            selectByMouse: true
            onTextEdited: {
                root.dirty = true;
                root.edited();
            }
        }
        SLabel {
            ui: root.ui
            text: "Access token"
        }
        TextField {
            id: accessToken
            objectName: "connectionToken"
            Layout.fillWidth: true
            placeholderText: root.ui.snapshot.setupRequired ? "Paste the server’s access token" : "Leave blank to keep the token for the same address"
            Accessible.name: "Access token"
            echoMode: TextInput.Password
            inputMethodHints: Qt.ImhSensitiveData | Qt.ImhNoPredictiveText
            maximumLength: 4096
            enabled: root.available && !root.pending
            placeholderTextColor: root.ui.c.muted
            selectByMouse: true
            onTextEdited: {
                root.dirty = true;
                root.edited();
            }
        }
        SLabel {
            ui: root.ui
            text: "Device name"
        }
        TextField {
            id: deviceName
            objectName: "connectionDeviceName"
            Layout.fillWidth: true
            Accessible.name: "Device name"
            maximumLength: 120
            enabled: root.available && !root.pending
            placeholderTextColor: root.ui.c.muted
            selectByMouse: true
            onTextEdited: {
                root.dirty = true;
                root.edited();
            }
        }
        SLabel {
            ui: root.ui
            visible: root.tested && root.hosts.length > 0
            // One computer provides the server's microphones in a normal setup.
            text: root.hosts.length === 1 ? "Microphones on " + (root.hostName || root.hosts[0]) : "Microphones provided by"
        }
        ComboBox {
            id: hostPicker
            objectName: "connectionHostPicker"
            Layout.fillWidth: true
            visible: root.tested && root.hosts.length > 1
            model: root.hosts
            enabled: !root.pending
            Accessible.name: "Microphone computer"
            displayText: currentIndex < 0 ? "Choose a computer" : currentText
        }
        TextField {
            id: hostID
            objectName: "connectionHostID"
            Layout.fillWidth: true
            visible: root.tested && root.hosts.length === 0
            placeholderText: "Microphone computer ID (advanced)"
            placeholderTextColor: root.ui.c.muted
            Accessible.name: "Microphone computer ID"
            maximumLength: 200
            enabled: !root.pending
        }
        SLabel {
            ui: root.ui
            Layout.fillWidth: true
            visible: root.tested && root.hosts.length === 0
            text: "The server has no microphones yet. Set up audio on the server computer, then test again."
            color: root.ui.c.muted
        }
        SLabel {
            ui: root.ui
            Layout.fillWidth: true
            text: "Changing server or microphone computer resets your microphone choices. Saving stops the DJI button typing here until you dictate again; it never starts recording."
            color: root.ui.c.muted
        }
        RowLayout {
            SButton {
                ui: root.ui
                visible: root.configured
                text: "Cancel"
                onClicked: {
                    root.clearSecret();
                    root.edited();
                    root.dirty = false;
                    root.loadConnection();
                    root.editing = false;
                }
            }
            SButton {
                ui: root.ui
                objectName: "testConnectionButton"
                text: root.pending ? "Please wait…" : "Test connection"
                enabled: root.available && !root.pending && server.text.trim().length > 0 && deviceName.text.trim().length > 0
                onClicked: {
                    root.pending = true;
                    root.edited();
                    root.activeRequestID = String(Date.now()) + ":" + String(Math.random());
                    bridge.request("testConnection", {
                        server: server.text,
                        name: deviceName.text,
                        accessToken: accessToken.text
                    }, root.activeRequestID);
                    root.clearSecret();
                }
            }
            SButton {
                ui: root.ui
                objectName: "saveConnectionButton"
                text: "Save connection"
                enabled: root.available && !root.pending && !!root.ticket && !root.ui.busy && !root.ui.shortcutBlocked && (root.hosts.length ? hostPicker.currentIndex >= 0 : !!hostID.text.trim())
                onClicked: {
                    root.pending = true;
                    root.message = "";
                    root.activeRequestID = String(Date.now()) + ":" + String(Math.random());
                    bridge.request("saveConnection", {
                        ticket: root.ticket,
                        hostID: root.hosts.length ? hostPicker.currentText : hostID.text.trim()
                    }, root.activeRequestID);
                }
            }
        }
    }
    SLabel {
        ui: root.ui
        objectName: "connectionSetupMessage"
        Layout.fillWidth: true
        Layout.margins: 12
        visible: text.length > 0
        text: !bridge.connected ? "Start the installed background dictation service, then reconnect. In a terminal: systemctl --user start sottoduo-client.service" : root.message || root.ui.snapshot.setupMessage || ""
        Accessible.role: Accessible.AlertMessage
    }
    SButton {
        ui: root.ui
        Layout.margins: 12
        visible: !bridge.connected
        text: "Reconnect"
        onClicked: bridge.request("snapshot")
    }
}
