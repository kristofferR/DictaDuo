import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Group {
    id: root
    objectName: "djiSettings"
    title: "DJI button"
    property var receiver: null
    property bool checking: false
    property bool saving: false
    property bool targeting: false
    // Shown until the server's state catches up with a chosen target.
    property var pendingTarget: null
    property bool showHelp: false
    property string error: ""
    property string receiverError: ""
    readonly property bool receiving: !!ui.snapshot.buttonEnabled
    readonly property string deviceID: ui.snapshot.device ? ui.snapshot.device.id || "" : ""
    // The live registration when receiving, otherwise the last receiver check.
    readonly property var routing: ui.snapshot.button && ui.snapshot.button.buttonTarget ? ui.snapshot.button : receiver
    readonly property bool targetSupported: !!routing && !!routing.buttonTarget
    readonly property var target: pendingTarget || (targetSupported ? routing.buttonTarget : ({
                mode: "lastDictated"
            }))
    readonly property var host: receiver ? receiver.sharingHost : null
    readonly property string hostLabel: !host ? "" : host.local ? "this computer" : host.name
    function always(device) {
        return device.id === deviceID ? "Always this computer" : "Always " + device.name;
    }
    readonly property var targetChoices: {
        const choices = [
            {
                label: "Last computer I dictated on",
                target: {
                    mode: "lastDictated"
                }
            }
        ];
        const seen = [];
        for (const destination of (routing && routing.destinations) || []) {
            if (seen.includes(destination.device.id))
                continue;
            seen.push(destination.device.id);
            choices.push({
                label: always(destination.device),
                target: {
                    mode: "device",
                    device: destination.device
                }
            });
        }
        if (target.mode === "device" && target.device && !seen.includes(target.device.id))
            choices.push({
                label: always(target.device) + " (offline)",
                target: {
                    mode: "device",
                    device: target.device
                }
            });
        choices.push({
            label: "Nowhere",
            target: {
                mode: "off"
            }
        });
        return choices;
    }
    readonly property int targetIndex: target.mode === "off" ? targetChoices.length - 1 : target.mode === "device" ? targetChoices.findIndex(choice => choice.target.device && target.device && choice.target.device.id === target.device.id) : 0
    readonly property string rightNow: {
        const selected = routing ? routing.selected : null;
        if (!selected)
            return "Right now: nowhere";
        const name = selected.device.id === deviceID ? "this computer" : selected.device.name;
        return "Right now: " + name + (target.mode === "lastDictated" ? ", where you last dictated" : "");
    }
    readonly property string receiverStatus: {
        if (!bridge.connected)
            return "Connect to background dictation to check the receiver.";
        if (!receiver)
            return checking ? "Checking receiver…" : "Receiver has not been checked.";
        const source = receiver.source;
        const place = hostLabel ? "Plugged into " + hostLabel + " · " : "";
        // Other computers only see the receiver when it is shared with them.
        if (!source && receiver.reported)
            return place + "not shared with this computer. Share it on " + (hostLabel || "the server's computer") + ".";
        if (!source)
            return "No DJI receiver found. Plug it into " + (hostLabel || "the server's computer") + ".";
        if (source.link === "connected")
            return place + "transmitter linked";
        if (source.link === "disconnected")
            return place + "transmitter not linked. Turn it on and link it to the receiver.";
        return place + "transmitter status unknown";
    }
    function checkReceiver() {
        if (!bridge.connected || checking)
            return;
        checking = true;
        bridge.request("receiver");
    }
    function chooseTarget(index) {
        const choice = targetChoices[index];
        if (!choice || targeting)
            return;
        targeting = true;
        error = "";
        pendingTarget = choice.target;
        bridge.request("setButtonTarget", {
            target: choice.target
        });
    }
    Component.onCompleted: checkReceiver()
    Timer {
        interval: 5000
        running: bridge.connected && root.visible
        repeat: true
        onTriggered: root.checkReceiver()
    }
    Timer {
        id: settleTarget
        interval: 3000
        onTriggered: root.pendingTarget = null
    }
    Connections {
        target: bridge
        function onSnapshotChanged() {
            if (!bridge.connected) {
                root.receiver = null;
                root.checking = false;
                root.saving = false;
                root.targeting = false;
                root.pendingTarget = null;
            }
        }
        function onReply(action, data) {
            if (action === "receiver") {
                root.receiver = data;
                root.receiverError = "";
                root.checking = false;
            }
            if (action === "saveButton") {
                root.saving = false;
                bridge.request("snapshot");
                root.checkReceiver();
            }
            if (action === "setButtonTarget") {
                root.targeting = false;
                root.receiver = Object.assign({}, root.receiver || {}, {
                    available: data.available,
                    selected: data.selected || null,
                    destinations: data.destinations,
                    buttonTarget: data.buttonTarget || null
                });
                settleTarget.restart();
                bridge.request("snapshot");
            }
        }
        function onFailed(action, message) {
            if (action === "receiver") {
                root.receiverError = message;
                root.receiver = null;
                root.checking = false;
            } else if (action === "saveButton") {
                root.error = message;
                root.saving = false;
            } else if (action === "setButtonTarget") {
                root.error = message;
                root.targeting = false;
                root.pendingTarget = null;
            }
        }
    }
    Setting {
        ui: root.ui
        title: "Button types into"
        detail: !root.targetSupported && !!root.routing ? "Update the server to choose where the button types." : root.targeting ? "Saving…" : root.rightNow
        ComboBox {
            objectName: "djiTargetPicker"
            implicitWidth: 245
            Accessible.name: "Button types into"
            model: root.targetChoices
            textRole: "label"
            currentIndex: root.targetIndex
            // A new model resets the index; restore the server's target.
            onModelChanged: currentIndex = Qt.binding(() => root.targetIndex)
            enabled: bridge.connected && root.targetSupported && !root.targeting && !bridge.preview && !root.ui.busy
            onActivated: root.chooseTarget(currentIndex)
        }
    }
    Setting {
        ui: root.ui
        title: "Receiver"
        detail: root.receiverStatus
        SButton {
            ui: root.ui
            text: root.checking ? "Checking…" : "Check receiver"
            enabled: bridge.connected && !root.checking
            onClicked: root.checkReceiver()
        }
    }
    SLabel {
        ui: root.ui
        Layout.fillWidth: true
        Layout.margins: 12
        font.pixelSize: 12
        color: root.ui.c.muted
        visible: !!root.receiver && !!root.receiver.source && !!root.receiver.source.reason && root.receiver.source.link !== "connected"
        text: root.receiver && root.receiver.source ? root.receiver.source.reason || "" : ""
    }
    Setting {
        ui: root.ui
        title: "Let the DJI button type here"
        detail: root.saving ? "Saving…" : !root.ui.snapshot.buttonSettingsSupported ? "Update the background client to change this setting." : root.receiving ? "Locking this computer stops it typing here." : "The button never types into this computer."
        Switch {
            objectName: "djiEnabledSwitch"
            Accessible.name: "Let the DJI button type here"
            checked: root.receiving
            enabled: bridge.connected && !!root.ui.snapshot.buttonSettingsSupported && !root.ui.busy && !root.saving && !bridge.preview
            onClicked: {
                root.saving = true;
                root.error = "";
                bridge.request("saveButton", {
                    enabled: checked
                });
                checked = Qt.binding(() => root.receiving);
            }
        }
    }
    Setting {
        ui: root.ui
        title: "Setup help"
        SButton {
            objectName: "djiHelpToggle"
            ui: root.ui
            text: root.showHelp ? "Hide" : "Show"
            Accessible.name: root.showHelp ? "Hide setup help" : "Show setup help"
            onClicked: root.showHelp = !root.showHelp
        }
    }
    SLabel {
        ui: root.ui
        Layout.fillWidth: true
        Layout.margins: 12
        visible: root.showHelp
        font.pixelSize: 12
        text: "Focus a text field, then tap the transmitter's button to start dictating and again to stop. The text goes to the computer the button types into. The button always records from the DJI receiver.\n\nPlug the receiver into the computer running the SottoDuo server, turn on the transmitter, and check that they are linked. On Linux, that computer needs the DJI receiver access rules and an active local login. If recording works but the button does nothing, check the button permission in the server setup.\n\nChecking the receiver only reads its status. It never records, resets the receiver or changes Bluetooth connections."
    }
    SLabel {
        ui: root.ui
        objectName: "djiSettingsError"
        Layout.fillWidth: true
        Layout.margins: 12
        visible: text.length > 0
        text: root.error || root.receiverError
        Accessible.role: Accessible.AlertMessage
    }
}
