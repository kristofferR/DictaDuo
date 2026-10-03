import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ApplicationWindow {
    id: app
    width: 1040
    height: 740
    minimumWidth: 880
    minimumHeight: 620
    onClosing: close => {
        if (microphoneTestActive) {
            close.accepted = false;
            quitRequested = false;
            page = 0;
            notice = "Finish or cancel the microphone test before closing SottoDuo.";
        } else if (quitRequested && (portalShortcuts.plasma || shortcutCheckPending || shortcut.check && shortcut.check.active || endingShortcutCheck)) {
            close.accepted = false;
            if (portalShortcuts.plasma && !portalReleasePending) {
                portalReleasePending = true;
                bridge.request("releasePortalShortcut");
            }
            finishShortcutCheck();
        }
    }
    onVisibleChanged: {
        if (!visible)
            finishShortcutCheck();
        else if (bridge.connected)
            refresh();
    }
    property bool startHidden: false
    visible: !startHidden
    title: bridge.preview ? "SottoDuo · Preview" : "SottoDuo"
    color: c.canvas
    property var c: bridge.colors
    objectName: "mainWindow"
    property int page: 0
    property var snapshot: bridge.snapshot
    property var activity: snapshot.activity || ({
            phase: "idle"
        })
    property var result: snapshot.result || null
    property var shortcut: snapshot.shortcut || ({})
    readonly property string triggerVerb: snapshot.activationMode === "doubleTap" ? "Double tap" : "Hold"
    readonly property bool shortcutBlocked: !!shortcut.changing || (!!shortcut.check && !!shortcut.check.blocked)
    property bool shortcutCheckPending: false
    property bool finishShortcutCheckAfterReply: false
    property bool endingShortcutCheck: false
    property bool quitRequested: false
    property bool portalReleasePending: false
    property bool microphoneTestStarting: false
    readonly property bool microphoneTestActive: microphoneTestStarting || (busy && activity.trigger === "test")
    property var feedback: snapshot.feedback || ({})
    // The dictation shortcut, named on buttons, the overlay and the tray.
    readonly property string dictationKey: (portalShortcuts.plasma ? portalShortcuts.trigger : shortcut.key) || ""
    // Whether Start dictation can be offered, from the window or the tray.
    readonly property bool canStart: bridge.connected && serverReady && !snapshot.setupRequired && !shortcutBlocked && !microphoneTestActive
    // The window takes focus from the field being dictated into, so it steps aside first.
    function startFromWindow() {
        if (!canStart)
            return;
        app.hide();
        windowStart.restart();
    }
    Timer {
        id: windowStart
        interval: 300
        onTriggered: bridge.request("start")
    }
    readonly property string fallbackNote: activity.cloudUnavailable ? "Using local recognition (cloud unavailable)" : ""
    // Whole seconds left to undo a cancel; steps once per second, no continuous repaint.
    property int undoSeconds: 0
    function updateUndo() {
        undoSeconds = activity.undoUntil ? Math.max(0, Math.ceil((activity.undoUntil - Date.now()) / 1000)) : 0;
    }
    onActivityChanged: updateUndo()
    Timer {
        interval: 1000
        repeat: true
        running: app.activity.undoUntil > 0
        onTriggered: app.updateUndo()
    }
    // One line for the tray menu, read when it opens or the snapshot changes.
    readonly property string trayStatus: undoSeconds > 0 ? "Not pasted · saved to history" : activity.phase === "recording" ? "Listening · " + duration(feedback.elapsedSeconds) : busy ? messageFor(activity.phase) : connection
    function duration(seconds) {
        const value = Math.max(0, Math.floor(seconds || 0));
        return Math.floor(value / 60) + ":" + String(value % 60).padStart(2, "0");
    }
    property bool busy: snapshot.busy || false
    // Earlier takes may still process; only a capturing take blocks the next one.
    readonly property bool canStartTake: snapshot.canStartTake === undefined ? !busy : snapshot.canStartTake
    onBusyChanged: {
        if (!busy && bridge.connected && !snapshot.setupRequired)
            bridge.request("connection");
    }
    property var sources: ({
            items: [],
            next: null
        })
    property bool wasConnected: false
    property int connectionRevision: -1
    property bool sourcesChecked: false
    property string serverConnection: "Checking server"
    readonly property string connection: bridge.connected ? (snapshot.setupRequired ? "Dictation needs setup" : serverConnection) : bridge.connectionStatus === "setupRequired" ? "Dictation needs setup" : bridge.connectionStatus === "connecting" ? "Connecting dictation…" : "Dictation unavailable"
    property string notice: ""
    property bool serverReady: false
    property var pages: ["Dictation", "History", "Microphone", "Server preferences", "This computer"]
    onPageChanged: if (page === 2) refreshSources()
    palette.window: c.canvas
    palette.windowText: c.ink
    palette.base: c.surface
    palette.text: c.ink
    palette.button: c.surface
    palette.buttonText: c.ink
    palette.highlight: c.accent
    palette.highlightedText: c.onAccent
    palette.mid: c.line
    palette.dark: c.line
    font.family: "Sans Serif"
    font.pixelSize: 15
    function refresh() {
        if (!bridge.connected) {
            bridge.request("snapshot");
            return;
        }
        if (snapshot.setupRequired)
            return;
        bridge.request("connection");
        refreshSources();
        if (!portalShortcuts.plasma)
            bridge.request("shortcuts");
    }
    function refreshSources() {
        if (bridge.connected && !snapshot.setupRequired)
            bridge.request("sources");
    }
    function startMicrophoneTest() {
        microphoneTestStarting = true;
        bridge.request("test");
    }
    function syncMicrophoneTestStart() {
        const terminalTest = activity.trigger === "test" && ["idle", "failed", "cancelled", "completed"].includes(activity.phase);
        if ((busy && activity.trigger === "test") || terminalTest)
            microphoneTestStarting = false;
    }
    function startShortcutCheck() {
        shortcutCheckPending = true;
        finishShortcutCheckAfterReply = false;
        bridge.request("checkShortcut");
    }
    function finishShortcutCheck() {
        if (shortcutCheckPending) {
            finishShortcutCheckAfterReply = true;
        } else if (shortcut.check && shortcut.check.active && !endingShortcutCheck) {
            endingShortcutCheck = true;
            bridge.request("endShortcutCheck");
        }
    }
    function messageFor(phase) {
        // A cancelled take keeps its recording or processing phase while it can be undone.
        if (undoSeconds > 0)
            return "Not pasted";
        if (phase === "preparing")
            return "Starting microphone…";
        if (phase === "recording")
            return "Listening.";
        if (phase === "processing")
            return feedback.processingStage === "proofreading" ? "Cleaning up text…" : feedback.processingStage === "queued" ? "Waiting to transcribe…" : "Transcribing…";
        if (phase === "delivering")
            return "Delivering text…";
        if (phase === "failed")
            return "Dictation interrupted";
        if (phase === "cancelled")
            return activity.kept ? "Saved to history" : "Dictation cancelled";
        if (phase === "completed")
            return result && result.delivery === "inserted" ? "Inserted at your cursor" : result && result.delivery === "uncertain" ? "Check your text field" : "Text ready to copy";
        return triggerVerb + " to dictate.";
    }
    Component.onCompleted: {
        wasConnected = bridge.connected;
        bridge.desktop.refreshClientService();
        refresh();
    }
    Connections {
        target: bridge
        function onSnapshotChanged() {
            if (!bridge.connected) {
                app.microphoneTestStarting = false;
                app.notice = "";
                app.sourcesChecked = false;
                app.serverReady = false;
                app.sources = {
                    items: [],
                    next: null
                };
            } else if (!app.wasConnected || app.connectionRevision !== (bridge.snapshot.connectionRevision || 0)) {
                app.connectionRevision = bridge.snapshot.connectionRevision || 0;
                app.sourcesChecked = false;
                app.serverReady = false;
                app.sources = {
                    items: [],
                    next: null
                };
                app.serverConnection = "Checking server";
                app.refresh();
            }
            app.syncMicrophoneTestStart();
            app.wasConnected = bridge.connected;
        }
        function onReply(action, data) {
            if (action === "checkShortcut") {
                app.shortcutCheckPending = false;
                if (app.finishShortcutCheckAfterReply) {
                    app.finishShortcutCheckAfterReply = false;
                    app.endingShortcutCheck = true;
                    bridge.request("endShortcutCheck");
                }
            }
            if (action === "endShortcutCheck") {
                app.endingShortcutCheck = false;
                if (app.quitRequested && !app.portalReleasePending)
                    Qt.quit();
            }
            if (action === "releasePortalShortcut" && app.portalReleasePending) {
                app.portalReleasePending = false;
                if (!app.shortcutCheckPending && !app.endingShortcutCheck && !app.finishShortcutCheckAfterReply)
                    Qt.quit();
            }
            if (action === "saveConnection") {
                app.sourcesChecked = false;
                app.serverReady = false;
                app.serverConnection = "Checking server";
                app.sources = {
                    items: [],
                    next: null
                };
                bridge.request("snapshot");
            }
            if (action === "connection") {
                app.serverConnection = data.ready ? "Server online" : data.message || "Server not ready";
                app.serverReady = data.ready;
            }
            if (action === "sources") {
                app.sources = data;
                app.sourcesChecked = true;
            }
            if (action === "saveSources")
                app.notice = "Changes saved.";
        }
        function onFailed(action, message) {
            if (action === "test")
                app.microphoneTestStarting = false;
            if (action === "checkShortcut") {
                app.shortcutCheckPending = false;
                if (app.finishShortcutCheckAfterReply || app.quitRequested) {
                    app.finishShortcutCheckAfterReply = false;
                    app.endingShortcutCheck = true;
                    bridge.request("endShortcutCheck");
                }
            }
            if (action === "endShortcutCheck") {
                app.endingShortcutCheck = false;
                if (app.quitRequested && !app.portalReleasePending)
                    Qt.quit();
            }
            if (action === "releasePortalShortcut" && app.portalReleasePending) {
                app.portalReleasePending = false;
                app.quitRequested = false;
                app.notice = "Could not release the Plasma shortcut. Reconnect before quitting.";
            }
            if (!bridge.connected)
                return;
            // Receiver, sharing and DJI button controls display their errors beside the affected settings.
            if (["history", "historyEntry", "historyAudio", "historyArtifact", "deleteHistory", "preferences", "savePreferences", "processingDefaults", "saveMicrophones", "testConnection", "saveConnection", "receiver", "saveButton", "setButtonTarget", "setSharing", "shortcuts", "saveShortcut", "checkShortcut", "endShortcutCheck"].includes(action))
                return;
            if (action === "connection") {
                app.serverConnection = "Server unavailable";
                app.serverReady = false;
            } else if (action === "sources") {
                app.sourcesChecked = false;
                app.sources = {
                    items: [],
                    next: null
                };
            } else
                app.notice = message;
        }
    }
    Timer {
        interval: 5000
        running: app.visible && bridge.connected
        repeat: true
        onTriggered: app.refresh()
    }
    Timer {
        interval: 2000
        running: app.visible && app.page === 2 && bridge.connected && !app.snapshot.setupRequired
        repeat: true
        onTriggered: app.refreshSources()
    }
    RowLayout {
        anchors.fill: parent
        spacing: 0
        Rectangle {
            Layout.preferredWidth: 234
            Layout.fillHeight: true
            color: app.c.sidebar
            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 20
                spacing: 8
                RowLayout {
                    Layout.topMargin: 14
                    Layout.bottomMargin: 34
                    spacing: 12
                    Image {
                        source: "../mark.svg"
                        Layout.preferredWidth: 44
                        Layout.preferredHeight: 44
                    }
                    SLabel {
                        ui: app
                        text: "SottoDuo"
                        font.family: "Serif"
                        font.pixelSize: 37
                        font.weight: Font.DemiBold
                    }
                }
                Repeater {
                    model: app.pages
                    Button {
                        required property int index
                        required property string modelData
                        Layout.fillWidth: true
                        Layout.preferredHeight: 50
                        text: modelData
                        Accessible.name: text
                        onClicked: app.page = index
                        contentItem: RowLayout {
                            spacing: 12
                            Image {
                                Layout.preferredWidth: 24
                                Layout.preferredHeight: 24
                                Accessible.ignored: true
                                source: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + app.c.accent + '" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="' + ["M3 10v4m4-8v12m5-16v20m5-16v12m4-8v4", "M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2", "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-3 6v1a6 6 0 0 0 12 0v-1m-6 7v4m-4 0h8", "M4 3h16v7H4zM4 14h16v7H4zM7 6h1m-1 11h1m4-11h6m-6 11h6", "M3 3h18v13H3zM8 21h8m-4-5v5"][index] + '"/></svg>')
                            }
                            SLabel {
                                ui: app
                                text: modelData
                                font.pixelSize: 15
                                font.weight: app.page === index ? Font.DemiBold : Font.Normal
                                color: app.page === index ? app.c.ink : app.c.muted
                                Layout.fillWidth: true
                            }
                        }
                        background: Rectangle {
                            radius: 9
                            color: app.page === index ? app.c.tint : "transparent"
                            border.width: parent.activeFocus ? 2 : 0
                            border.color: app.c.accent
                        }
                    }
                }
                Item {
                    Layout.fillHeight: true
                }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 9
                    StatusDot {
                        objectName: "sidebarConnectionDot"
                        ready: app.serverReady
                    }
                    SLabel {
                        ui: app
                        text: bridge.preview ? "Preview · sample data" : app.connection
                        font.pixelSize: 12
                        color: app.c.ink
                        Layout.fillWidth: true
                    }
                }
            }
        }
        Rectangle {
            Layout.preferredWidth: 1
            Layout.fillHeight: true
            color: app.c.line
        }
        ColumnLayout {
            Layout.fillHeight: true
            Layout.fillWidth: true
            Layout.margins: 32
            spacing: 16
            Rectangle {
                objectName: "connectionBanner"
                visible: !!app.snapshot.setupRequired || (!bridge.connected && bridge.connectionStatus !== "connecting")
                Layout.fillWidth: true
                implicitHeight: offline.implicitHeight + 24
                radius: 10
                color: app.c.tint
                SLabel {
                    id: offline
                    ui: app
                    anchors.fill: parent
                    anchors.margins: 12
                    text: app.snapshot.setupRequired ? "Set up your server connection in This computer to start dictating." : bridge.desktop.clientService === "Systemd user service unavailable" ? "Background dictation is unavailable. Start the SottoDuo client with your desktop’s startup tools." : bridge.desktop.clientService !== "Running" ? "Background dictation is stopped. Open This computer to set it up and start it." : "Dictation is unavailable. SottoDuo couldn’t connect to its background service. Try reconnecting in This computer."
                }
            }
            Rectangle {
                objectName: "actionNotice"
                visible: bridge.connected && app.notice.length > 0
                Layout.fillWidth: true
                implicitHeight: noticeRow.implicitHeight + 16
                radius: 10
                color: app.c.tint
                RowLayout {
                    id: noticeRow
                    anchors.fill: parent
                    anchors.margins: 8
                    SLabel {
                        ui: app
                        text: app.notice
                        Layout.fillWidth: true
                        Accessible.role: Accessible.AlertMessage
                    }
                    SButton {
                        ui: app
                        text: "Dismiss"
                        onClicked: app.notice = ""
                    }
                }
            }
            Loader {
                Layout.fillWidth: true
                Layout.fillHeight: true
                visible: app.page !== 2 && app.page !== 3
                sourceComponent: [dictation, history, null, null, computer][app.page]
            }
            Loader {
                Layout.fillWidth: true
                Layout.fillHeight: true
                visible: app.page === 2
                // Keep microphone drafts and in-flight saves when visiting another page.
                property bool opened: false
                onVisibleChanged: if (visible) opened = true
                active: opened || visible
                sourceComponent: microphone
            }
            Loader {
                Layout.fillWidth: true
                Layout.fillHeight: true
                visible: app.page === 3
                // Keep shared drafts and in-flight saves when visiting another page.
                property bool opened: false
                onVisibleChanged: if (visible) opened = true
                active: opened || visible
                sourceComponent: preferences
            }
        }
    }
    Component {
        id: dictation
        Dictation {
            ui: app
        }
    }
    Component {
        id: history
        History {
            ui: app
        }
    }
    Component {
        id: microphone
        Microphone {
            ui: app
        }
    }
    Component {
        id: preferences
        Preferences {
            ui: app
        }
    }
    Component {
        id: computer
        Computer {
            ui: app
        }
    }
    Hud {
        ui: app
    }
}
