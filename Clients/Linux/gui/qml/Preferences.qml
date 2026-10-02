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
    // Recognition runs locally with Parakeet, which ignores language and vocabulary.
    readonly property bool parakeet: !!draft && draft.preferences.recognitionEngine === "parakeet" && !!health && (health.recognitionEngines || []).includes("parakeet")
    readonly property bool editable: !!draft && bridge.connected && !ui.snapshot.setupRequired && !ui.snapshot.connectionChanging && !saving && !discardOnRead && !bridge.preview && draftServer === ui.snapshot.server

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
                    title: "Voice"

                    RowLayout {
                        spacing: 8
                        ColumnLayout {
                            spacing: 2
                            SLabel {
                                ui: root.ui
                                text: root.health && root.health.speech ? root.health.speech.modelID : "Checking…"
                                Layout.alignment: Qt.AlignRight
                            }
                            SLabel {
                                ui: root.ui
                                text: root.health && root.health.speech ? (root.health.speech.message || root.health.speech.backend) : ""
                                color: root.ui.c.muted
                                font.pixelSize: 13
                                Layout.alignment: Qt.AlignRight
                            }
                        }
                        StatusDot {
                            objectName: "speechModelReadiness"
                            property string status: root.health && root.health.speech ? root.health.speech.ready ? "Ready" : "Not ready" : "Unavailable"
                            ready: !!(root.health && root.health.speech && root.health.speech.ready)
                            Accessible.ignored: false
                            Accessible.name: "Voice " + status
                        }
                    }

                }

                Setting {
                    ui: root.ui
                    title: "Text cleanup"

                    RowLayout {
                        spacing: 8
                        ColumnLayout {
                            spacing: 2
                            SLabel {
                                ui: root.ui
                                text: root.health && root.health.proofreading ? root.health.proofreading.modelID : "Checking…"
                                Layout.alignment: Qt.AlignRight
                            }
                            SLabel {
                                ui: root.ui
                                text: root.health && root.health.proofreading ? (root.health.proofreading.message || root.health.proofreading.backend) : ""
                                color: root.ui.c.muted
                                font.pixelSize: 13
                                Layout.alignment: Qt.AlignRight
                            }
                        }
                        StatusDot {
                            property string status: root.health && root.health.proofreading ? root.health.proofreading.ready ? "Ready" : "Not ready" : "Unavailable"
                            ready: !!(root.health && root.health.proofreading && root.health.proofreading.ready)
                            Accessible.ignored: false
                            Accessible.name: "Text cleanup " + status
                        }
                    }

                }

            }

            Group {
                ui: root.ui
                title: "Processing"
                enabled: root.editable

                Setting {
                    ui: root.ui
                    title: "Speech recognition"

                    ComboBox {
                        implicitWidth: 330
                        model: ["Automatic (Soniox, with local fallback)", "Cloud only (Soniox)", "Local only"]
                        currentIndex: root.draft ? ["automatic", "cloud", "local"].indexOf(root.draft.preferences.recognitionMode || "automatic") : 0
                        onActivated: root.edit("recognitionMode", ["automatic", "cloud", "local"][currentIndex])
                    }

                }

                Setting {
                    ui: root.ui
                    title: "Local engine"
                    // A choice only when the server has both engines installed and reports its selection.
                    visible: !!(root.draft && root.draft.preferences.recognitionEngine && root.health && root.health.recognitionEngines && root.health.recognitionEngines.length > 1)
                    detail: root.parakeet ? "Faster. Detects 25 European languages on its own, not Norwegian, and ignores recognition vocabulary." : "Slower. Follows the Language setting and uses recognition vocabulary."

                    ComboBox {
                        objectName: "recognitionEngine"
                        implicitWidth: 245
                        model: ["Whisper large-v3-turbo", "Parakeet v3"]
                        currentIndex: root.draft ? ["whisper", "parakeet"].indexOf(root.draft.preferences.recognitionEngine || "whisper") : 0
                        Accessible.name: "Local engine"
                        Accessible.description: "Parakeet is faster but recognizes only 25 European languages, not Norwegian, and ignores recognition vocabulary."
                        onActivated: root.edit("recognitionEngine", ["whisper", "parakeet"][currentIndex])
                    }

                }

                Setting {
                    ui: root.ui
                    title: "Local engine"
                    visible: !!(root.health && root.health.recognitionEngines && root.health.recognitionEngines.length === 1)
                    detail: "The only engine installed on the server."

                    SLabel {
                        ui: root.ui
                        text: root.health && root.health.recognitionEngines && root.health.recognitionEngines[0] === "parakeet" ? "Parakeet v3" : "Whisper large-v3-turbo"
                    }

                }

                Setting {
                    ui: root.ui
                    title: "Language"
                    detail: root.parakeet ? "Used for cloud recognition. Parakeet detects the language itself." : ""

                    ComboBox {
                        property var codes: ["auto", "en", "es", "fr", "de", "it", "pt", "nl", "ja", "zh", "ko", "hi", "ar", "pl", "ru", "uk", "sv", "no"]

                        implicitWidth: 245
                        model: ["Detect automatically", "English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Japanese", "Chinese", "Korean", "Hindi", "Arabic", "Polish", "Russian", "Ukrainian", "Swedish", "Norwegian"]
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
