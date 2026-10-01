import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ScrollView {
    id: root
    required property var ui
    Component.onCompleted: bridge.desktop.refreshClientService()
    clip: true
    contentWidth: availableWidth
    ColumnLayout {
        width: root.availableWidth
        spacing: 22
        SLabel {
            ui: root.ui
            text: "This computer"
            font.pixelSize: 28
            font.weight: Font.DemiBold
        }
        SLabel {
            ui: root.ui
            text: "Connection, appearance and desktop integration."
            color: root.ui.c.muted
        }
        ConnectionSettings {
            ui: root.ui
        }
        Group {
            ui: root.ui
            title: "Appearance"
            Setting {
                ui: root.ui
                title: "Theme"
                detail: "Only this computer. All themes use the same layout."
                ComboBox {
                    implicitWidth: 245
                    model: ["Follow system", "SottoDuo · Warm light", "SottoDuo · Glacier dark", "Omarchy · Active theme"]
                    currentIndex: ["system", "light", "dark", "omarchy"].indexOf(bridge.theme)
                    onActivated: bridge.theme = ["system", "light", "dark", "omarchy"][currentIndex]
                }
            }
            Setting {
                ui: root.ui
                visible: bridge.theme === "omarchy"
                title: "Omarchy colors"
                detail: bridge.themeNote
            }
        }
        ShortcutSettings {
            ui: root.ui
            enabledForDesktop: !portalShortcuts.plasma
            visible: !portalShortcuts.plasma
        }
        PortalShortcutSettings {
            ui: root.ui
            visible: portalShortcuts.plasma
        }
        DjiSettings {
            ui: root.ui
        }
        Group {
            ui: root.ui
            title: "Desktop integration"
            Setting {
                ui: root.ui
                title: "Shortcuts and text insertion"
                detail: portalShortcuts.plasma ? "Use your Plasma shortcut while a text field is focused." : "Use your SottoDuo shortcut while a text field is focused."
            }
            Setting {
                ui: root.ui
                title: "Mute system audio while recording"
                detail: "Silences this computer's speakers during a take, then restores them."
                Switch {
                    objectName: "muteOutputSwitch"
                    Accessible.name: "Mute system audio while recording"
                    checked: !!root.ui.snapshot.muteOutputWhileRecording
                    enabled: bridge.connected && root.ui.snapshot.muteOutputWhileRecording !== undefined && !bridge.preview
                    onClicked: {
                        bridge.request("saveMuteOutput", {
                            enabled: checked
                        });
                        checked = Qt.binding(() => !!root.ui.snapshot.muteOutputWhileRecording);
                    }
                }
                Connections {
                    target: bridge
                    function onReply(action, data) {
                        if (action === "saveMuteOutput")
                            bridge.request("snapshot");
                    }
                }
            }
            Setting {
                ui: root.ui
                title: "Launch at login"
                detail: "Keep dictation feedback ready without opening this window. Your background dictation service must already be set up."
                Switch {
                    objectName: "launchAtLoginSwitch"
                    Accessible.name: "Launch SottoDuo at login"
                    checked: bridge.desktop.launchAtLogin
                    enabled: !bridge.preview
                    onClicked: {
                        bridge.desktop.setLaunchAtLogin(checked);
                        checked = Qt.binding(() => bridge.desktop.launchAtLogin);
                    }
                }
            }
            SLabel {
                ui: root.ui
                Layout.fillWidth: true
                Layout.margins: 12
                visible: bridge.desktop.error.length > 0
                text: bridge.desktop.error
                Accessible.role: Accessible.AlertMessage
            }
            Setting {
                ui: root.ui
                title: "Background dictation"
                detail: bridge.desktop.clientService === "Running" ? portalShortcuts.plasma ? "Running. Keep SottoDuo feedback open in the background for Plasma shortcuts; pairing-button dictation runs in the service." : "Running. Shortcuts and pairing-button dictation keep working when this window closes." : bridge.desktop.clientService === "Systemd user service unavailable" ? "This desktop does not provide a systemd user service. Start the SottoDuo client with your desktop's startup tools." : "Install and start the background client for keyboard and pairing-button dictation."
                SLabel {
                    ui: root.ui
                    text: bridge.desktop.clientService
                    color: root.ui.c.muted
                }
                SButton {
                    ui: root.ui
                    visible: bridge.desktop.clientService !== "Systemd user service unavailable"
                    text: bridge.desktop.clientServiceBusy ? "Working…" : bridge.desktop.clientService === "Running" ? "Restart background dictation" : "Set up and start"
                    enabled: !bridge.preview && !bridge.desktop.clientServiceBusy
                    onClicked: bridge.desktop.clientService === "Running" ? bridge.desktop.restartClientService() : bridge.desktop.setUpClientService()
                }
            }
            Setting {
                ui: root.ui
                title: "Quit SottoDuo feedback"
                detail: portalShortcuts.plasma ? "Hides the live indicator and disables the Plasma keyboard shortcut until you reopen SottoDuo. Pairing-button dictation stays running." : "Hides the live indicator until you reopen SottoDuo. Keyboard and pairing-button dictation stay running."
                SButton {
                    ui: root.ui
                    text: "Quit"
                    onClicked: bridge.desktop.quit()
                }
            }
        }
    }
}
