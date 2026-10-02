import QtQuick

Rectangle {
    required property bool ready
    // A hollow ring for something switched off.
    property bool off: false
    implicitWidth: 6
    implicitHeight: 6
    radius: width / 2
    color: off ? "transparent" : ready ? "#4ade80" : "#fb923c"
    border.width: off ? 1.5 : 0
    border.color: "#94a3b8"
    Accessible.ignored: true
}
