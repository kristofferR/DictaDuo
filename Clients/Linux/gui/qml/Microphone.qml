import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ScrollView {
    id: root
    objectName: "microphonePage"
    required property var ui
    property var draft: ({
            mode: "automatic",
            priority: [],
            profiles: [],
            knownInputs: []
        })
    property string revision: ""
    property bool dirty: false
    property bool pending: false
    property bool conflicted: false
    property bool awaitingSnapshot: false
    property string submittedRevision: ""
    property string submittedDraft: ""
    property string message: ""
    property var seenInputs: []
    // The one sharing change in flight, shown until the server confirms it.
    property string sharingKey: ""
    property bool sharingValue: false
    readonly property var sharingHost: ui.sources.sharingHost || null
    readonly property string deviceID: ui.snapshot.device ? ui.snapshot.device.id || "" : ""
    readonly property string fallbackPlace: !sharingHost ? "" : sharingHost.local ? "this computer" : sharingHost.name
    readonly property string sharingNote: {
        if (!sharingHost)
            return "";
        if (sharingHost.local)
            return "Your other computers can use mics you share here. Each take still belongs to the computer that started it.";
        const count = ui.sources.items.length;
        return sharingHost.name + " shares " + count + (count === 1 ? " mic" : " mics") + " with this computer. Add one to your list to dictate with it here. Sharing is set on " + sharingHost.name + ".";
    }
    readonly property bool scopeChanged: !!ui.snapshot.microphones && (draft.server !== ui.snapshot.microphones.value.server || draft.hostID !== ui.snapshot.microphones.value.hostID)
    readonly property bool editable: bridge.connected && !bridge.preview && !ui.busy && !ui.snapshot.connectionChanging && !conflicted && !!revision && !scopeChanged
    readonly property var activeProfile: draft.profiles.find(p => p.id === draft.activeProfileID) || ({
            name: "Default",
            priority: []
        })
    readonly property var inputChoices: {
        const choices = [
            { label: "Automatic · priority list", mode: "automatic" },
            { label: "System default", mode: "systemDefault" }
        ];
        for (const source of ui.sources.items)
            choices.push({ label: source.name, mode: "fixed", identity: source.identity });
        if (draft.mode === "fixed" && draft.fixed && !choices.some(choice => choice.identity && key(choice.identity) === key(draft.fixed)))
            choices.push({ label: nameFor(draft.fixed) + " (disconnected)", mode: "fixed", identity: draft.fixed });
        return choices;
    }
    readonly property int selectedInputIndex: draft.mode === "fixed" ? inputChoices.findIndex(choice => choice.identity && draft.fixed && key(choice.identity) === key(draft.fixed)) : draft.mode === "systemDefault" ? 1 : 0
    clip: true
    contentWidth: availableWidth
    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }
    function key(value) {
        return JSON.stringify([value.hostID, value.id]);
    }
    function rememberInputs() {
        let inputs = seenInputs.slice();
        for (const source of ui.sources.items) {
            const input = {
                identity: source.identity,
                name: source.name
            };
            const index = inputs.findIndex(x => key(x.identity) === key(input.identity));
            if (index < 0)
                inputs.push(input);
            else
                inputs[index] = input;
        }
        seenInputs = inputs;
    }
    function loadSaved() {
        const saved = ui.snapshot.microphones;
        if (!saved)
            return;
        if (draft.server !== saved.value.server)
            seenInputs = [];
        draft = clone(saved.value);
        revision = saved.revision;
        dirty = false;
        pending = false;
        conflicted = false;
        awaitingSnapshot = false;
        submittedRevision = "";
        submittedDraft = "";
        message = "";
        rememberInputs();
    }
    Component.onCompleted: loadSaved()
    function rank(id) {
        return draft.priority.findIndex(x => key(x) === key(id));
    }
    function edited(next) {
        draft = next;
        dirty = true;
        message = "";
        saveChanges();
    }
    function saveChanges() {
        if (!dirty || pending || awaitingSnapshot || !editable || (draft.mode === "fixed" && !draft.fixed))
            return;
        const current = ui.snapshot.microphones;
        if (current && current.revision !== revision) {
            conflicted = true;
            message = "Microphone settings changed on another device. Reload the latest settings to continue.";
            return;
        }
        rememberInputs();
        let value = clone(draft);
        const inputs = seenInputs.slice();
        for (const input of value.knownInputs || [])
            if (!inputs.some(x => key(x.identity) === key(input.identity)))
                inputs.push(input);
        const referenced = [];
        for (const profile of value.profiles)
            for (const id of profile.priority)
                referenced.push(id);
        if (value.fixed)
            referenced.push(value.fixed);
        value.knownInputs = inputs.filter(input => referenced.some(id => key(id) === key(input.identity)));
        submittedRevision = revision;
        submittedDraft = JSON.stringify(draft);
        pending = true;
        bridge.request("saveMicrophones", { value: value, revision: revision });
    }
    function selectProfile(id) {
        let next = clone(draft);
        next.activeProfileID = id;
        next.priority = clone(next.profiles.find(p => p.id === id).priority);
        edited(next);
    }
    function changePriority(id, action) {
        let next = clone(draft);
        const index = rank(id);
        if (action === "add" && index < 0)
            next.priority.push(id);
        if (action === "remove" && index >= 0)
            next.priority.splice(index, 1);
        if (action === "up" && index > 0)
            [next.priority[index - 1], next.priority[index]] = [next.priority[index], next.priority[index - 1]];
        if (action === "down" && index >= 0 && index < next.priority.length - 1)
            [next.priority[index + 1], next.priority[index]] = [next.priority[index], next.priority[index + 1]];
        next.profiles.find(p => p.id === next.activeProfileID).priority = clone(next.priority);
        edited(next);
    }
    function movePriority(id, targetID) {
        if (!editable)
            return;
        let next = clone(draft);
        const from = next.priority.findIndex(x => key(x) === key(id));
        const to = next.priority.findIndex(x => key(x) === key(targetID));
        if (from < 0 || to < 0 || from === to)
            return;
        const moved = next.priority.splice(from, 1)[0];
        next.priority.splice(to, 0, moved);
        next.profiles.find(p => p.id === next.activeProfileID).priority = clone(next.priority);
        edited(next);
    }
    function nameFor(id) {
        const live = ui.sources.items.find(s => key(s.identity) === key(id));
        const saved = seenInputs.concat(draft.knownInputs || []).find(s => key(s.identity) === key(id));
        return live ? live.name : saved ? saved.name : id.id;
    }
    function liveSource(id) {
        return ui.sources.items.find(s => key(s.identity) === key(id));
    }
    function transportLabel(transport) {
        return ({
                usb: "USB",
                bluetooth: "Bluetooth",
                builtIn: "Built-in"
            })[transport] || "Other";
    }
    function sourceDetail(source) {
        if (!sharingHost)
            return transportLabel(source.transport);
        if (!sharingHost.local)
            return "Shared from " + sharingHost.name;
        return transportLabel(source.transport) + " · " + (source.shared ? "shared" : "only this computer");
    }
    function sourceStatus(source) {
        if (!source)
            return "Not connected";
        if (source.recordingFor)
            return source.recordingFor.id === deviceID ? "Recording for this computer" : "Busy · " + source.recordingFor.name + " is dictating";
        return source.eligible ? "Ready" : source.unavailableReason || "Not connected";
    }
    function detailFor(id) {
        const live = liveSource(id);
        return live ? sourceDetail(live) : "Not connected";
    }
    function shared(source) {
        return sharingKey === key(source.identity) ? sharingValue : !!source.shared;
    }
    function setSharing(source, value) {
        sharingKey = key(source.identity);
        sharingValue = value;
        message = "";
        bridge.request("setSharing", {
            source: source.identity,
            shared: value
        });
    }
    function editName(create) {
        profileDialog.creating = create;
        profileName.text = create ? "" : activeProfile.name;
        profileDialog.error = "";
        profileDialog.open();
        profileName.forceActiveFocus();
    }
    function saveName() {
        const name = profileName.text.trim();
        if (!name || draft.profiles.some(p => p.name.toLowerCase() === name.toLowerCase() && (profileDialog.creating || p.id !== draft.activeProfileID))) {
            profileDialog.error = "Choose a non-empty, unique name.";
            return;
        }
        let next = clone(draft);
        if (profileDialog.creating) {
            const id = "profile-" + Date.now() + "-" + Math.random().toString(36).slice(2);
            next.profiles.push({
                id: id,
                name: name,
                priority: []
            });
            next.activeProfileID = id;
            next.priority = [];
        } else
            next.profiles.find(p => p.id === next.activeProfileID).name = name;
        edited(next);
        profileDialog.close();
    }
    Connections {
        target: root.ui
        function onSourcesChanged() {
            root.rememberInputs();
        }
    }
    Connections {
        target: bridge
        function onReply(action, data) {
            if (action === "setSharing") {
                // Apply the confirmed sharing now; the next refresh brings the rest.
                const items = root.ui.sources.items.map(item => {
                    const updated = data.sources.find(s => root.key(s.identity) === root.key(item.identity));
                    return updated ? Object.assign({}, item, {
                        shared: updated.shared
                    }) : item;
                });
                root.ui.sources = Object.assign({}, root.ui.sources, {
                    items: items
                });
                root.sharingKey = "";
                root.ui.refreshSources();
            }
            if (action === "saveMicrophones" && root.pending) {
                if (root.scopeChanged) {
                    root.loadSaved();
                    return;
                }
                const unchanged = JSON.stringify(root.draft) === root.submittedDraft;
                root.revision = data.revision;
                root.pending = false;
                root.awaitingSnapshot = root.ui.snapshot.microphones?.revision !== root.revision;
                if (unchanged) {
                    root.draft = root.clone(data.value);
                    root.dirty = false;
                    root.message = "";
                }
                if (!root.awaitingSnapshot && root.dirty)
                    root.saveChanges();
                bridge.request("snapshot");
                root.ui.refreshSources();
            }
        }
        function onFailed(action, message) {
            if (action === "setSharing") {
                root.sharingKey = "";
                root.message = message;
            }
            if (action === "saveMicrophones" && root.pending) {
                root.pending = false;
                if (root.scopeChanged) {
                    root.loadSaved();
                    return;
                }
                root.conflicted = message.startsWith("Microphone settings changed.");
                root.message = message;
            }
        }
        function onSnapshotChanged() {
            if (!bridge.connected) {
                root.awaitingSnapshot = false;
                return;
            }
            if (root.scopeChanged && !root.pending) {
                root.loadSaved();
                return;
            }
            if (root.awaitingSnapshot) {
                const current = root.ui.snapshot.microphones;
                if (!current || current.revision === root.submittedRevision)
                    return;
                root.awaitingSnapshot = false;
                if (current.revision !== root.revision) {
                    root.conflicted = true;
                    root.message = "Microphone settings changed on another device. Reload the latest settings to continue.";
                    return;
                }
            }
            if (!root.dirty && !root.pending && !profileDialog.visible && !deleteDialog.visible && root.ui.snapshot.microphones && root.ui.snapshot.microphones.revision !== root.revision)
                root.loadSaved();
            else if (root.dirty && !root.pending && !root.message)
                root.saveChanges();
        }
    }
    Timer {
        interval: 4000
        running: root.dirty && !root.pending && !root.conflicted && bridge.connected && root.message.length > 0
        repeat: false
        onTriggered: {
            root.message = "";
            root.saveChanges();
        }
    }
    ColumnLayout {
        width: root.availableWidth
        spacing: 22
        SLabel {
            ui: root.ui
            text: "Microphone"
            font.pixelSize: 28
            font.weight: Font.DemiBold
        }
        SLabel {
            ui: root.ui
            text: "Choose where your voice comes from."
            color: root.ui.c.muted
        }
        Rectangle {
            objectName: "microphoneSharingNote"
            visible: !!root.sharingHost
            Layout.fillWidth: true
            implicitHeight: sharingNoteText.implicitHeight + 24
            radius: 10
            color: root.ui.c.tint
            SLabel {
                id: sharingNoteText
                ui: root.ui
                anchors.fill: parent
                anchors.margins: 12
                font.pixelSize: 14
                text: root.sharingNote
            }
        }
        Group {
            ui: root.ui
            Setting {
                ui: root.ui
                title: "Choose input"
                ComboBox {
                    objectName: "microphoneMode"
                    implicitWidth: 245
                    model: root.inputChoices
                    textRole: "label"
                    currentIndex: root.selectedInputIndex
                    enabled: root.editable
                    onActivated: {
                        const choice = root.inputChoices[currentIndex];
                        let next = root.clone(root.draft);
                        next.mode = choice.mode;
                        if (choice.identity)
                            next.fixed = choice.identity;
                        root.edited(next);
                    }
                }
            }
            Setting {
                ui: root.ui
                title: "Next dictation"
                detail: root.pending ? "Saving microphone settings for your next dictation…" : root.ui.sources.reason || "Availability is checked again when dictation starts."
                SLabel {
                    ui: root.ui
                    objectName: "nextMicrophone"
                    text: root.ui.sources.next ? root.ui.sources.next.name : "None available"
                    Layout.maximumWidth: 230
                }
            }
            Setting {
                ui: root.ui
                visible: root.draft.mode === "fixed"
                title: root.draft.fixed ? root.nameFor(root.draft.fixed) : "Choose a fixed input below"
                detail: root.draft.fixed ? root.detailFor(root.draft.fixed) + " · " + root.sourceStatus(root.liveSource(root.draft.fixed)) + ". If it can't start, SottoDuo uses another ready mic." : "If the fixed input can't start, SottoDuo uses another ready mic."
            }
        }
        Group {
            ui: root.ui
            title: "Input priority"
            Setting {
                ui: root.ui
                title: "Saved list"
                detail: root.draft.mode === "automatic" ? "Uses the first ready microphone in this list." : "Lists are used in Automatic mode. Your current input mode is unchanged."
                ComboBox {
                    objectName: "microphoneProfilePicker"
                    implicitWidth: 205
                    model: root.draft.profiles.map(p => p.name)
                    currentIndex: root.draft.profiles.findIndex(p => p.id === root.draft.activeProfileID)
                    enabled: root.editable
                    onActivated: root.selectProfile(root.draft.profiles[currentIndex].id)
                }
                SButton {
                    ui: root.ui
                    objectName: "useMicrophonePriorityList"
                    text: root.draft.mode === "automatic" ? "In use" : "Use list"
                    enabled: root.editable && root.draft.mode !== "automatic"
                    onClicked: {
                        let next = root.clone(root.draft);
                        next.mode = "automatic";
                        root.edited(next);
                    }
                }
                SButton {
                    ui: root.ui
                    text: "+"
                    objectName: "newMicrophoneProfile"
                    Accessible.name: "New priority list"
                    Layout.preferredWidth: 44
                    horizontalPadding: 10
                    enabled: root.editable && root.draft.profiles.length < 16
                    onClicked: root.editName(true)
                }
                SButton {
                    id: profileActions
                    ui: root.ui
                    text: "⋯"
                    objectName: "microphoneProfileOptions"
                    Accessible.name: "Priority list options"
                    Layout.preferredWidth: 44
                    horizontalPadding: 10
                    enabled: root.editable
                    onClicked: profileMenu.open()
                    Menu {
                        id: profileMenu
                        objectName: "microphoneProfileMenu"
                        y: profileActions.height
                        MenuItem {
                            text: "Rename list…"
                            enabled: root.editable
                            onTriggered: root.editName(false)
                        }
                        MenuItem {
                            objectName: "deleteMicrophoneProfile"
                            text: "Delete list…"
                            enabled: root.editable && root.draft.profiles.length > 1
                            onTriggered: deleteDialog.open()
                        }
                    }
                }
            }
            Repeater {
                model: root.draft.priority
                Item {
                    id: priorityRow
                    required property var modelData
                    required property int index
                    readonly property var identity: modelData
                    Layout.fillWidth: true
                    implicitHeight: prioritySetting.implicitHeight
                    Setting {
                        id: prioritySetting
                        anchors.fill: parent
                        ui: root.ui
                        title: (priorityRow.index + 1) + ". " + root.nameFor(priorityRow.identity)
                        detail: root.detailFor(priorityRow.identity)
                        SLabel {
                            ui: root.ui
                            text: root.sourceStatus(root.liveSource(priorityRow.identity))
                            color: root.ui.c.muted
                            font.pixelSize: 13
                            Layout.maximumWidth: 200
                        }
                        Rectangle {
                            id: reorderHandle
                            objectName: "microphoneReorderHandle" + priorityRow.index
                            Layout.preferredWidth: 32
                            Layout.preferredHeight: 38
                            color: "transparent"
                            Accessible.role: Accessible.Button
                            Accessible.name: "Drag to reorder " + root.nameFor(priorityRow.identity)
                            Text {
                                anchors.centerIn: parent
                                text: "⠿"
                                font.pixelSize: 23
                                color: root.editable ? root.ui.c.muted : root.ui.c.line
                            }
                            HoverHandler {
                                cursorShape: root.editable ? reorderDrag.active ? Qt.ClosedHandCursor : Qt.OpenHandCursor : Qt.ArrowCursor
                            }
                            DragHandler {
                                id: reorderDrag
                                enabled: root.editable && root.draft.priority.length > 1
                                xAxis.enabled: false
                                onActiveChanged: {
                                    if (active) {
                                        reorderHandle.Drag.start();
                                    } else {
                                        reorderHandle.Drag.drop();
                                        reorderHandle.y = 0;
                                    }
                                }
                            }
                            Drag.source: priorityRow
                            Drag.keys: ["sottoduo/microphone-priority"]
                            Drag.hotSpot.x: width / 2
                            Drag.hotSpot.y: height / 2
                        }
                        SButton {
                            id: priorityActions
                            ui: root.ui
                            objectName: "microphonePriorityActions" + priorityRow.index
                            text: "⋯"
                            Accessible.name: "Actions for " + root.nameFor(priorityRow.identity)
                            Layout.preferredWidth: 44
                            horizontalPadding: 10
                            enabled: root.editable
                            onClicked: priorityMenu.open()
                            Menu {
                                id: priorityMenu
                                objectName: "microphonePriorityMenu" + priorityRow.index
                                y: priorityActions.height
                                MenuItem {
                                    text: "Move up"
                                    enabled: root.editable && priorityRow.index > 0
                                    onTriggered: root.changePriority(priorityRow.identity, "up")
                                }
                                MenuItem {
                                    text: "Move down"
                                    enabled: root.editable && priorityRow.index < root.draft.priority.length - 1
                                    onTriggered: root.changePriority(priorityRow.identity, "down")
                                }
                                MenuItem {
                                    objectName: "microphoneMoveTop" + priorityRow.index
                                    text: "Move to top"
                                    enabled: root.editable && priorityRow.index > 0
                                    onTriggered: root.movePriority(priorityRow.identity, root.draft.priority[0])
                                }
                                MenuSeparator {}
                                MenuItem {
                                    text: "Remove from priority list"
                                    enabled: root.editable
                                    onTriggered: root.changePriority(priorityRow.identity, "remove")
                                }
                            }
                        }
                    }
                    Rectangle {
                        anchors.fill: parent
                        color: "transparent"
                        radius: 8
                        border.width: dropArea.containsDrag && dropArea.drag.source !== priorityRow ? 2 : 0
                        border.color: root.ui.c.accent
                    }
                    DropArea {
                        id: dropArea
                        anchors.fill: parent
                        keys: ["sottoduo/microphone-priority"]
                        onDropped: drop => {
                            if (root.editable && drop.source && drop.source !== priorityRow) {
                                root.movePriority(drop.source.identity, priorityRow.identity);
                                drop.acceptProposedAction();
                            }
                        }
                    }
                }
            }
            Setting {
                ui: root.ui
                visible: root.draft.priority.length === 0
                title: "No priorities yet"
                detail: "Add a microphone from the connected inputs below."
            }
            SLabel {
                ui: root.ui
                visible: root.ui.sources.items.some(source => root.rank(source.identity) < 0)
                text: "Available inputs"
                color: root.ui.c.muted
                font.pixelSize: 13
                Layout.leftMargin: 14
                Layout.topMargin: 12
            }
            Repeater {
                model: root.ui.sources.items.filter(source => root.rank(source.identity) < 0)
                Setting {
                    required property var modelData
                    ui: root.ui
                    title: modelData.name
                    detail: root.sourceDetail(modelData)
                    SLabel {
                        ui: root.ui
                        text: root.sourceStatus(modelData)
                        color: root.ui.c.muted
                        font.pixelSize: 13
                        Layout.maximumWidth: 200
                    }
                    SButton {
                        ui: root.ui
                        text: "+"
                        Accessible.name: "Add " + modelData.name + " to priority list"
                        Layout.preferredWidth: 44
                        horizontalPadding: 10
                        enabled: root.editable && root.draft.priority.length < 32
                        onClicked: root.changePriority(modelData.identity, "add")
                    }
                }
            }
            Setting {
                ui: root.ui
                visible: root.ui.sources.items.length === 0
                title: "No inputs reported"
                detail: "Saved microphones stay in their lists. Inputs update automatically while connected."
            }
        }
        SLabel {
            ui: root.ui
            text: "Drag a handle to reorder. Disconnected microphones keep their place. If none in the list is ready, SottoDuo uses any other ready mic" + (root.fallbackPlace ? " on " + root.fallbackPlace + ", which records one take at a time" : "") + "."
            color: root.ui.c.muted
            font.pixelSize: 13
            Layout.fillWidth: true
        }
        RowLayout {
            visible: root.message.length > 0 || root.conflicted
            spacing: 12
            SLabel {
                ui: root.ui
                text: root.message
                Layout.fillWidth: true
            }
            SButton {
                ui: root.ui
                objectName: "reloadMicrophoneSettings"
                text: "Reload latest settings"
                visible: root.conflicted
                onClicked: root.loadSaved()
            }
        }
        MicrophoneTestButton {
            objectName: "microphonePageTestButton"
            ui: root.ui
            Layout.fillWidth: true
        }
        Group {
            ui: root.ui
            objectName: "microphoneSharing"
            title: "Share with my other computers"
            visible: !!root.sharingHost && root.sharingHost.local
            Repeater {
                model: root.ui.sources.items
                Setting {
                    required property var modelData
                    required property int index
                    ui: root.ui
                    title: modelData.name
                    detail: root.shared(modelData) ? "Shared" : "Only this computer"
                    Switch {
                        objectName: "shareMicrophone" + index
                        Accessible.name: "Share " + modelData.name + " with my other computers"
                        checked: root.shared(modelData)
                        enabled: bridge.connected && !bridge.preview && !root.sharingKey && !root.ui.snapshot.connectionChanging
                        onClicked: {
                            root.setSharing(modelData, checked);
                            checked = Qt.binding(() => root.shared(modelData));
                        }
                    }
                }
            }
            Setting {
                ui: root.ui
                visible: root.ui.sources.items.length === 0
                title: "No mics connected"
                detail: "Mics plugged into this computer appear here."
            }
        }
        DjiSettings {
            ui: root.ui
        }
    }
    Dialog {
        id: profileDialog
        objectName: "microphoneProfileDialog"
        onClosed: if (!root.dirty && !root.pending && !root.awaitingSnapshot)
            root.loadSaved()
        property bool creating: true
        property string error: ""
        title: creating ? "New priority list" : "Rename priority list"
        parent: Overlay.overlay
        anchors.centerIn: parent
        modal: true
        width: 380
        contentItem: ColumnLayout {
            TextField {
                id: profileName
                objectName: "microphoneProfileName"
                Layout.fillWidth: true
                placeholderText: "Desk, travel…"
                placeholderTextColor: root.ui.c.muted
                maximumLength: 80
                onAccepted: if (root.editable)
                    root.saveName()
            }
            SLabel {
                ui: root.ui
                text: profileDialog.error || "Each list remembers its own microphone order."
                Layout.fillWidth: true
            }
            RowLayout {
                SButton {
                    ui: root.ui
                    text: "Cancel"
                    onClicked: profileDialog.close()
                }
                SButton {
                    ui: root.ui
                    text: profileDialog.creating ? "Create" : "Rename"
                    enabled: root.editable && !!profileName.text.trim()
                    onClicked: root.saveName()
                }
            }
        }
    }
    Dialog {
        id: deleteDialog
        onClosed: if (!root.dirty && !root.pending && !root.awaitingSnapshot)
            root.loadSaved()
        title: "Delete “" + root.activeProfile.name + "”?"
        parent: Overlay.overlay
        anchors.centerIn: parent
        modal: true
        width: 400
        contentItem: ColumnLayout {
            SLabel {
                ui: root.ui
                text: "This removes the saved list immediately. Another list will be selected. Microphones are not removed."
                Layout.fillWidth: true
            }
            RowLayout {
                SButton {
                    ui: root.ui
                    text: "Cancel"
                    onClicked: deleteDialog.close()
                }
                SButton {
                    ui: root.ui
                    text: "Delete list"
                    enabled: root.editable && root.draft.profiles.length > 1
                    onClicked: {
                        let next = root.clone(root.draft);
                        next.profiles = next.profiles.filter(p => p.id !== next.activeProfileID);
                        next.activeProfileID = next.profiles[0].id;
                        next.priority = root.clone(next.profiles[0].priority);
                        root.edited(next);
                        deleteDialog.close();
                    }
                }
            }
        }
    }
}
