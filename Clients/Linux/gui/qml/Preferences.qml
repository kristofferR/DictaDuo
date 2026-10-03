import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: root

    required property var ui
    property var draft: null
    property var latest: null
    property string draftServer: ""
    property bool dirty: false
    property int editRevision: 0
    property bool saving: false
    property bool reading: false
    property bool discardOnRead: false
    property bool changedRemotely: false
    property string message: ""
    property string defaultPrompt: ""
    property var health: null
    property bool showModelDetails: false
    // Recognition runs locally with Parakeet, which ignores language and vocabulary.
    readonly property bool parakeet: {
        editRevision;
        return !!draft && draft.preferences.recognitionEngine === "parakeet" && !!health && (health.recognitionEngines || []).includes("parakeet");
    }
    // Whether Soniox is configured on the server; undefined from an older server.
    readonly property var cloudRecognition: health && typeof health.cloudRecognition === "boolean" ? health.cloudRecognition : undefined
    readonly property var installedEngines: health && health.recognitionEngines ? health.recognitionEngines : []
    readonly property var modes: ["automatic", "cloud", "local"]
    readonly property string mode: {
        editRevision;
        return draft ? draft.preferences.recognitionMode || "automatic" : "automatic";
    }
    readonly property bool editable: !!draft && bridge.connected && !ui.snapshot.setupRequired && !ui.snapshot.connectionChanging && !saving && !discardOnRead && !bridge.preview && draftServer === ui.snapshot.server

    // A friendly model name. The exact ID stays in Model details.
    function modelName(runtime) {
        if (runtime.backend.startsWith("soniox"))
            return "Soniox";
        if (runtime.modelID.startsWith("whisper-large-v3-turbo"))
            return "Whisper large-v3-turbo";
        if (runtime.modelID.startsWith("parakeet-tdt-0.6b-v3"))
            return "Parakeet v3";
        if (runtime.modelID.startsWith("Qwen3-4B"))
            return "Qwen3 4B";
        return runtime.modelID;
    }

    // Ready, Loading, Off or Unavailable. The server reports warm-up in these messages.
    function modelStatus(runtime, enabled) {
        if (!enabled)
            return "Off";
        if (runtime.ready)
            return "Ready";
        if ((runtime.message || "").startsWith("Loading") || (health.message || "").startsWith("Loading"))
            return "Loading";
        return "Unavailable";
    }

    // Exact model IDs and backends, as the server reports them.
    function modelDetails() {
        if (!health)
            return "";
        const lines = [health.speech, health.proofreading].map((runtime) => [runtime.modelID, runtime.backend].concat(runtime.message ? [runtime.message] : []).join(" · "));
        if (cloudRecognition !== undefined)
            lines.push("soniox/websocket · " + (cloudRecognition ? "API key configured" : "no API key"));
        return lines.join("\n");
    }

    // What the selected mode does on this server; engine names live here, not in the labels.
    function modeCaption() {
        if (cloudRecognition === undefined)
            return "";
        if (mode === "automatic")
            return cloudRecognition ? "Uses Soniox, with local fallback." : "Local only until a Soniox key is added.";
        if (mode === "cloud")
            return cloudRecognition ? "Uses Soniox, with no local fallback." : "Needs a Soniox API key on the server.";
        return "Audio never leaves your server.";
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function changed() {
        editRevision++;
        dirty = true;
        message = "";
    }

    function edit(key, value) {
        if (draft) {
            draft.preferences[key] = value;
            changed();
        }
    }

    function load(value) {
        const next = clone(value);
        if (!next.preferences.dictionary)
            next.preferences.dictionary = { lists: [] };
        draft = next;
        latest = clone(value);
        draftServer = ui.snapshot.server;
        cleanup.text = next.preferences.proofreadingPrompt !== undefined ? next.preferences.proofreadingPrompt : defaultPrompt;
        vocabulary.text = next.preferences.vocabulary || "";
        dirty = false;
        changedRemotely = false;
        message = "";
    }

    function read(discard) {
        if (reading || saving || !bridge.connected)
            return ;

        discardOnRead = discard;
        reading = true;
        bridge.request("preferences");
    }

    function reload() {
        if (dirty)
            discardDialog.open();
        else
            read(true);
    }

    objectName: "processingSettings"
    Component.onCompleted: {
        read(false);
        bridge.request("processingDefaults");
        bridge.request("connection");
    }

    Connections {
        function onReply(action, data) {
            if (action === "processingDefaults")
                root.defaultPrompt = data.proofreadingPrompt;

            if (action === "connection")
                root.health = data;

            if (action === "preferences") {
                root.reading = false;
                // A late read cannot replace a newer save or erase a local draft.
                if (root.latest && data.revision < root.latest.revision) {
                    root.discardOnRead = false;
                    return ;
                }
                root.latest = root.clone(data);
                if (root.discardOnRead || (!root.dirty && !dictionary.confirming && !root.saving && (!root.draft || data.revision !== root.draft.revision)))
                    root.load(data);
                else if (root.draft && data.revision !== root.draft.revision)
                    root.changedRemotely = true;
                root.discardOnRead = false;
            }
            if (action === "savePreferences" && root.saving) {
                root.saving = false;
                root.load(data);
                root.message = "Shared preferences saved. Changes apply to new dictations.";
            }
        }

        function onFailed(action, message) {
            if (action === "savePreferences") {
                root.saving = false;
                root.message = message;
                root.read(false);
            }
            if (action === "preferences") {
                root.reading = false;
                root.discardOnRead = false;
                root.message = "Could not load shared preferences. Your edits are kept. Check the connection and try reloading.";
            }
            if (action === "connection")
                root.health = null;

        }

        function onSnapshotChanged() {
            if (!bridge.connected) {
                root.health = null;
                root.saving = false;
                root.reading = false;
                root.discardOnRead = false;
            }
            if (root.draft && bridge.connected && root.draftServer !== root.ui.snapshot.server) {
                root.changedRemotely = true;
                root.latest = null;
                root.health = null;
                root.message = "The connected server changed. Discard and reload its shared preferences before editing.";
            }
        }

        target: bridge
    }

    Timer {
        interval: 5000
        repeat: true
        running: root.visible && root.ui.visible && bridge.connected
        onTriggered: {
            root.read(false);
            if (!root.defaultPrompt)
                bridge.request("processingDefaults");

        }
    }

    SLabel {
        ui: root.ui
        text: "SottoDuo · Server preferences"
        font.pixelSize: 18
        font.weight: Font.DemiBold
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 9
        StatusDot {
            objectName: "preferencesConnectionDot"
            ready: root.ui.serverReady
        }
        SLabel {
            ui: root.ui
            text: root.ui.connection
            Layout.fillWidth: true
        }
        SLabel {
            ui: root.ui
            objectName: "preferencesServerAddress"
            text: root.ui.snapshot.server || ""
            visible: text.length > 0
            color: root.ui.c.muted
            font.pixelSize: 13
            wrapMode: Text.NoWrap
            elide: Text.ElideMiddle
            Layout.preferredWidth: Math.min(220, root.width * 0.35)
        }
        Item { Layout.fillWidth: true }
        SButton {
            ui: root.ui
            objectName: "reloadProcessingSettings"
            text: root.changedRemotely ? "Reload" : "Discard changes"
            visible: root.dirty || root.changedRemotely
            enabled: !root.reading && !root.saving && bridge.connected
            onClicked: root.reload()
        }
        SButton {
            ui: root.ui
            objectName: "saveProcessingSettings"
            text: root.saving ? "Saving…" : "Save shared preferences"
            primary: true
            enabled: root.editable && root.dirty && !root.changedRemotely
            onClicked: {
                root.saving = true;
                root.message = "";
                bridge.request("savePreferences", {
                    "value": root.draft,
                    "server": root.draftServer
                });
            }
        }
    }

    SLabel {
        ui: root.ui
        objectName: "processingMessage"
        Layout.fillWidth: true
        visible: text.length > 0
        text: root.message || (root.changedRemotely ? "Shared preferences changed on another device. Your edits are kept here. Discard and reload to continue." : "")
    }

    ScrollView {
        id: settingsScroll

        objectName: "processingScroll"
        Layout.fillWidth: true
        Layout.fillHeight: true
        Layout.topMargin: 28
        contentWidth: availableWidth
        clip: true

        ColumnLayout {
            width: settingsScroll.availableWidth
            spacing: 22

            Group {
                ui: root.ui
                title: "Server models"

                Setting {
                    ui: root.ui
                    title: "Speech recognition"

                    SLabel {
                        ui: root.ui
                        // With Soniox configured, readiness still describes the local engine.
                        // In Automatic mode with Soniox configured, readiness describes the local engine.
                        text: !root.health ? "Checking…" : root.health.speech.backend.startsWith("soniox") && !!root.latest && root.latest.preferences.recognitionMode !== "cloud" ? (root.parakeet ? "Parakeet v3" : "Whisper large-v3-turbo") : root.modelName(root.health.speech)
                    }
                    StatusDot {
                        id: speechStatus
                        objectName: "speechModelReadiness"
                        property string status: root.health ? root.modelStatus(root.health.speech, true) : ""
                        visible: status.length > 0
                        ready: status === "Ready"
                    }
                    SLabel {
                        ui: root.ui
                        text: speechStatus.status
                        color: root.ui.c.muted
                        Accessible.name: "Speech recognition " + text
                    }
                }

                Setting {
                    ui: root.ui
                    title: "Text cleanup"

                    SLabel {
                        ui: root.ui
                        text: root.health ? root.modelName(root.health.proofreading) : "Checking…"
                    }
                    StatusDot {
                        id: cleanupStatus
                        objectName: "cleanupModelReadiness"
                        property string status: root.health ? root.modelStatus(root.health.proofreading, !root.latest || root.latest.preferences.textCorrectionEnabled) : ""
                        visible: status.length > 0
                        ready: status === "Ready"
                        off: status === "Off"
                    }
                    SLabel {
                        ui: root.ui
                        text: cleanupStatus.status
                        color: root.ui.c.muted
                        Accessible.name: "Text cleanup " + text
                    }
                }

                Setting {
                    ui: root.ui
                    title: "Cloud recognition"
                    visible: root.cloudRecognition !== undefined
                    detail: root.cloudRecognition === false ? "No API key on the server" : ""

                    SLabel {
                        ui: root.ui
                        text: "Soniox"
                    }
                    StatusDot {
                        objectName: "cloudRecognitionStatus"
                        ready: root.cloudRecognition === true
                        off: !ready
                    }
                    SLabel {
                        ui: root.ui
                        text: root.cloudRecognition ? "On" : "Off"
                        color: root.ui.c.muted
                        Accessible.name: "Cloud recognition " + text
                    }
                }

                Setting {
                    ui: root.ui
                    title: (root.showModelDetails ? "⌄  " : "›  ") + "Model details"

                    SButton {
                        ui: root.ui
                        objectName: "modelDetailsToggle"
                        text: root.showModelDetails ? "Hide" : "Show"
                        enabled: !!root.health
                        Accessible.name: (root.showModelDetails ? "Hide" : "Show") + " model details"
                        onClicked: root.showModelDetails = !root.showModelDetails
                    }
                }

                SLabel {
                    ui: root.ui
                    objectName: "modelDetails"
                    Layout.fillWidth: true
                    Layout.margins: 14
                    visible: root.showModelDetails && !!root.health
                    text: root.modelDetails()
                    font.family: "monospace"
                    font.pixelSize: 12
                    color: root.ui.c.muted
                }

            }

            Group {
                ui: root.ui
                title: "Processing"
                enabled: root.editable

                Setting {
                    ui: root.ui
                    title: "Recognition mode"
                    detail: root.modeCaption()

                    ComboBox {
                        id: modeBox

                        objectName: "recognitionMode"
                        // An older server does not report whether Soniox is configured.
                        readonly property var choices: root.cloudRecognition === undefined ? [{
                            "text": "Automatic (Soniox, with local fallback)",
                            "enabled": true
                        }, {
                            "text": "Cloud only (Soniox)",
                            "enabled": true
                        }, {
                            "text": "Local only",
                            "enabled": true
                        }] : [{
                            "text": "Automatic",
                            "enabled": true
                        }, {
                            "text": root.cloudRecognition ? "Cloud only" : "Cloud only (needs a Soniox API key)",
                            "enabled": root.cloudRecognition
                        }, {
                            "text": "Local only",
                            "enabled": true
                        }]

                        implicitWidth: 330
                        model: choices
                        textRole: "text"
                        currentIndex: root.modes.indexOf(root.mode)
                        Accessible.name: "Recognition mode"
                        onActivated: (index) => {
                            if (choices[index].enabled)
                                root.edit("recognitionMode", root.modes[index]);
                            else
                                currentIndex = Qt.binding(() => root.modes.indexOf(root.mode));
                        }

                        delegate: ItemDelegate {
                            required property var modelData
                            required property int index

                            width: ListView.view.width
                            text: modelData.text
                            enabled: modelData.enabled
                            highlighted: modeBox.highlightedIndex === index
                        }

                    }

                }

                Setting {
                    ui: root.ui
                    title: "Local engine"
                    // A choice only when the server has both engines installed and reports its selection.
                    visible: !!(root.draft && root.draft.preferences.recognitionEngine && root.installedEngines.length > 1)
                    detail: root.parakeet ? "Faster, but covers 25 European languages (not Norwegian) and ignores recognition vocabulary." : "Parakeet v3 is faster but covers 25 European languages (not Norwegian) and ignores recognition vocabulary."

                    ComboBox {
                        objectName: "recognitionEngine"
                        implicitWidth: 245
                        model: ["Whisper large-v3-turbo", "Parakeet v3"]
                        currentIndex: root.draft ? ["whisper", "parakeet"].indexOf(root.draft.preferences.recognitionEngine || "whisper") : 0
                        Accessible.name: "Local engine"
                        onActivated: root.edit("recognitionEngine", ["whisper", "parakeet"][currentIndex])
                    }

                }

                Setting {
                    ui: root.ui
                    title: "Local engine"
                    visible: root.installedEngines.length === 1
                    detail: root.installedEngines[0] === "whisper" ? "Install Parakeet on the server to choose it. It is faster but covers 25 European languages (not Norwegian) and ignores recognition vocabulary." : ""

                    SLabel {
                        ui: root.ui
                        objectName: "onlyRecognitionEngine"
                        text: (root.installedEngines[0] === "parakeet" ? "Parakeet v3" : "Whisper large-v3-turbo") + " (only engine installed)"
                    }

                }

                Setting {
                    ui: root.ui
                    title: "Language"
                    detail: {
                        root.editRevision;
                        if (!root.parakeet)
                            return "";
                        return root.draft.preferences.language === "no" ? "Parakeet does not recognize Norwegian. Choose Whisper as the local engine for Norwegian." : "Used for cloud recognition. Parakeet detects the language itself.";
                    }

                    ComboBox {
                        // Older servers reject Norwegian, so it is offered only when the server lists it.
                        readonly property bool norwegian: !!root.health && (root.health.features || []).includes("language-no") || (!!root.draft && root.draft.preferences.language === "no")
                        property var codes: ["auto", "en", "es", "fr", "de", "it", "pt", "nl", "ja", "zh", "ko", "hi", "ar", "pl", "ru", "uk", "sv"].concat(norwegian ? ["no"] : [])

                        implicitWidth: 245
                        model: ["Detect automatically", "English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Japanese", "Chinese", "Korean", "Hindi", "Arabic", "Polish", "Russian", "Ukrainian", "Swedish"].concat(norwegian ? ["Norwegian"] : [])
                        currentIndex: root.draft ? codes.indexOf(root.draft.preferences.language) : 0
                        onActivated: root.edit("language", codes[currentIndex])
                    }

                }

                Setting {
                    ui: root.ui
                    title: "Clean up text after transcribing"

                    Switch {
                        checked: root.draft ? root.draft.preferences.textCorrectionEnabled : false
                        Accessible.name: "Clean up text after transcribing"
                        onClicked: root.edit("textCorrectionEnabled", checked)
                    }

                }

                Setting {
                    ui: root.ui
                    title: "Text cleanup instructions"

                    SButton {
                        ui: root.ui
                        objectName: "resetCleanupPrompt"
                        text: "Reset to default"
                        enabled: {
                            root.editRevision;
                            return !!root.defaultPrompt && !!root.draft && root.draft.preferences.proofreadingPrompt !== root.defaultPrompt;
                        }
                        onClicked: {
                            root.edit("proofreadingPrompt", root.defaultPrompt);
                            root.draft = root.clone(root.draft);
                            cleanup.text = root.defaultPrompt;
                        }
                    }

                }

                ScrollView {
                    Layout.fillWidth: true
                    Layout.margins: 12
                    Layout.preferredHeight: 320
                    background: Rectangle {
                        color: root.ui.c.canvas
                        radius: 6
                        border.width: cleanup.activeFocus ? 2 : 1
                        border.color: cleanup.activeFocus ? root.ui.c.accent : root.ui.c.line
                    }

                    TextArea {
                        id: cleanup

                        objectName: "cleanupInstructions"
                        text: root.draft ? (root.draft.preferences.proofreadingPrompt !== undefined ? root.draft.preferences.proofreadingPrompt : root.defaultPrompt) : ""
                        Accessible.name: "Text cleanup instructions"
                        color: root.ui.c.ink
                        selectionColor: root.ui.c.accent
                        selectedTextColor: root.ui.c.onAccent
                        padding: 12
                        background: null
                        textFormat: TextEdit.PlainText
                        wrapMode: TextEdit.Wrap
                        selectByMouse: true
                        onTextChanged: {
                            if (activeFocus && root.draft && text !== root.draft.preferences.proofreadingPrompt) {
                                root.edit("proofreadingPrompt", text);
                            }
                        }
                    }

                }

                Setting {
                    ui: root.ui
                    title: "Recognition vocabulary"
                    detail: root.parakeet ? "Parakeet ignores this list. Dictionary replacements and text cleanup still apply." : "Names and specialized terms that help recognition."
                }

                ScrollView {
                    Layout.fillWidth: true
                    Layout.margins: 12
                    Layout.preferredHeight: 110
                    background: Rectangle {
                        color: root.ui.c.canvas
                        radius: 6
                        border.width: vocabulary.activeFocus ? 2 : 1
                        border.color: vocabulary.activeFocus ? root.ui.c.accent : root.ui.c.line
                    }

                    TextArea {
                        id: vocabulary

                        objectName: "recognitionVocabulary"
                        text: root.draft ? root.draft.preferences.vocabulary : ""
                        placeholderText: "SottoDuo, PipeWire, names you use often…"
                        placeholderTextColor: root.ui.c.muted
                        color: root.ui.c.ink
                        selectionColor: root.ui.c.accent
                        selectedTextColor: root.ui.c.onAccent
                        padding: 12
                        background: null
                        textFormat: TextEdit.PlainText
                        wrapMode: TextEdit.Wrap
                        selectByMouse: true
                        onTextChanged: {
                            if (activeFocus && root.draft && text !== root.draft.preferences.vocabulary) {
                                root.edit("vocabulary", text);
                            }
                        }
                    }

                }

            }

            Group {
                ui: root.ui
                title: "Shared history"
                enabled: root.editable

                Setting {
                    ui: root.ui
                    title: "Keep original microphone audio"

                    Switch {
                        checked: root.draft ? root.draft.preferences.keepOriginalAudio : false
                        Accessible.name: "Keep original microphone audio"
                        onClicked: root.edit("keepOriginalAudio", checked)
                    }

                }
                SLabel {
                    ui: root.ui
                    text: "Recognition audio is always kept. This also saves the original microphone audio for future dictations."
                    color: root.ui.c.muted
                    font.pixelSize: 13
                    Layout.fillWidth: true
                    Layout.margins: 14
                }

            }

            DictionaryEditor {
                id: dictionary

                ui: root.ui
                editor: root
            }

        }

    }

    Dialog {
        id: discardDialog

        title: "Discard unsaved shared settings?"
        parent: Overlay.overlay
        anchors.centerIn: parent
        modal: true
        width: 410

        contentItem: ColumnLayout {
            SLabel {
                ui: root.ui
                text: "Your local edits will be replaced with the latest settings from the connected server. Nothing is saved by reloading."
                Layout.fillWidth: true
            }

            RowLayout {
                SButton {
                    ui: root.ui
                    text: "Keep editing"
                    onClicked: discardDialog.close()
                }

                SButton {
                    ui: root.ui
                    text: "Discard and reload"
                    enabled: !root.reading && !root.saving && bridge.connected
                    onClicked: {
                        root.read(true);
                        discardDialog.close();
                    }
                }

            }

        }

    }

}
