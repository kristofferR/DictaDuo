import QtQuick

// A history status label tinted by its tone: ok, neutral, warning, error or accent.
Rectangle {
    id: chip

    required property var ui
    property var status: null
    readonly property string tone: status ? status.tone : "neutral"

    visible: !!status
    implicitWidth: label.implicitWidth + 16
    implicitHeight: label.implicitHeight + 4
    radius: height / 2
    color: ({
            ok: ui.c.okTint,
            warning: ui.c.warningTint,
            error: ui.c.errorTint,
            accent: "transparent"
        })[tone] || "transparent"
    border.width: tone === "accent" ? 1 : 0
    border.color: ui.c.line
    Accessible.role: Accessible.StaticText
    Accessible.name: label.text

    // A translucent neutral stays visible on selected and hovered rows too.
    Rectangle {
        anchors.fill: parent
        radius: parent.radius
        visible: chip.tone === "neutral"
        color: chip.ui.c.muted
        opacity: 0.18
    }

    Text {
        id: label
        anchors.centerIn: parent
        text: chip.status ? chip.status.label : ""
        textFormat: Text.PlainText
        font.pixelSize: 12
        font.weight: Font.DemiBold
        color: ({
                ok: chip.ui.c.ok,
                warning: chip.ui.c.warning,
                error: chip.ui.c.error,
                accent: chip.ui.c.ink
            })[chip.tone] || chip.ui.c.muted
    }
}
