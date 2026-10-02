#include "Bridge.h"
#include <chrono>
#include <QApplication>
#include <QClipboard>
#include <QColor>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalSocket>
#include <QRegularExpression>
#include <QStandardPaths>
#include <QStyleHints>
#include <cmath>

namespace {
constexpr auto maximumResponseBytes = 32 * 1024 * 1024;

QColor blend(const QColor &a, const QColor &b, double fraction) {
  return QColor::fromRgbF(a.redF() * (1 - fraction) + b.redF() * fraction,
                          a.greenF() * (1 - fraction) + b.greenF() * fraction,
                          a.blueF() * (1 - fraction) + b.blueF() * fraction);
}
double luminance(const QColor &color) {
  auto linear = [](double c) {
    return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4);
  };
  return .2126 * linear(color.redF()) + .7152 * linear(color.greenF()) +
         .0722 * linear(color.blueF());
}
double contrast(const QColor &a, const QColor &b) {
  const double x = luminance(a), y = luminance(b);
  return (std::max(x, y) + .05) / (std::min(x, y) + .05);
}
} // namespace
Bridge::Bridge(bool preview, QObject *parent)
    : QObject(parent), m_preview(preview), m_desktop(preview, this) {
  m_theme = m_settings.value("appearance", "system").toString();
  if (!QStringList{"system", "light", "dark", "omarchy"}.contains(m_theme))
    m_theme = "system";
  updateColors();
  connect(qApp->styleHints(), &QStyleHints::colorSchemeChanged, this,
          [this] { updateColors(); });
  if (m_preview) {
    QFile fixture(":/qt/qml/SottoDuo/preview.json");
    if (!fixture.open(QIODevice::ReadOnly))
      qFatal("Missing preview fixture.");
    m_fixture =
        QJsonDocument::fromJson(fixture.readAll()).object().toVariantMap();
    m_snapshot = m_fixture.value("snapshot").toMap();
    m_connected = true;
  } else {
    connect(&m_poll, &QTimer::timeout, this, [this] { request("snapshot"); });
    m_poll.start(500);
    request("snapshot");
  }
  connect(&m_themePoll, &QTimer::timeout, this, [this] {
    if (m_theme == "omarchy")
      updateColors();
  });
  m_themePoll.start(3000);
}
QString Bridge::connectionStatus() const {
  if (m_connected)
    return "connected";
  if (!m_connectionChecked)
    return "connecting";
  QString config = qEnvironmentVariable("SOTTODUO_CLIENT_CONFIG");
  if (!qEnvironmentVariableIsSet("SOTTODUO_CLIENT_CONFIG")) {
    const QString xdgConfigHome = qEnvironmentVariable("XDG_CONFIG_HOME");
    const QString configHome =
        xdgConfigHome.isEmpty()
            ? QStandardPaths::writableLocation(
                  QStandardPaths::GenericConfigLocation)
            : xdgConfigHome;
    config = QDir(configHome).filePath("sottoduo/linux-client.json");
  }
  return m_hasConnected || QFileInfo(config).isFile() ? "unavailable"
                                                      : "setupRequired";
}
void Bridge::disconnected() {
  m_poll.setInterval(500);
  m_connected = false;
  m_connectionChecked = true;
  m_snapshot.clear();
  emit snapshotChanged();
}
void Bridge::setTheme(const QString &theme) {
  if (!QStringList{"system", "light", "dark", "omarchy"}.contains(theme))
    return;
  const bool changed = m_theme != theme;
  m_theme = theme;
  if (!m_preview)
    m_settings.setValue("appearance", theme);
  updateColors();
  if (changed)
    emit themeChanged();
}
void Bridge::updateColors() {
  const bool dark = m_theme == "dark" || m_theme == "omarchy" ||
                    (m_theme == "system" && qApp->styleHints()->colorScheme() ==
                                                Qt::ColorScheme::Dark);
  QVariantMap colors =
      dark ? QVariantMap{{"ink", "#edf5fa"},     {"muted", "#a4b8c7"},
                         {"canvas", "#1b252e"},  {"surface", "#222c35"},
                         {"sidebar", "#2b3e4d"}, {"line", "#485b6b"},
                         {"accent", "#a7d6f5"},  {"onAccent", "#192c3a"},
                         {"tint", "#304452"}}
           : QVariantMap{{"ink", "#352d3a"},     {"muted", "#766d78"},
                         {"canvas", "#f8f6f2"},  {"surface", "#fffdf9"},
                         {"sidebar", "#ede8e4"}, {"line", "#d5cdd1"},
                         {"accent", "#b44634"},  {"onAccent", "#ffffff"},
                         {"tint", "#eee2de"}};
  QString note;
  if (m_theme == "omarchy") {
    const QString state = qEnvironmentVariable(
        "XDG_STATE_HOME", QDir::homePath() + "/.local/state");
    const QString config =
        QStandardPaths::writableLocation(QStandardPaths::GenericConfigLocation);
    QFile file(state + "/omarchy/current/theme/colors.toml");
    if (!file.exists())
      file.setFileName(config + "/omarchy/current/theme/colors.toml");
    QMap<QString, QColor> palette;
    if (file.open(QIODevice::ReadOnly) && file.size() <= 65536) {
      const auto lines = QString::fromUtf8(file.readAll()).split('\n');
      const QRegularExpression colorLine(
          R"re(^\s*([a-zA-Z0-9_]+)\s*=\s*["'](#[a-fA-F0-9]{6})["']\s*(?:#.*)?$)re");
      for (const auto &line : lines) {
        const auto match = colorLine.match(line);
        if (match.hasMatch())
          palette.insert(match.captured(1), QColor(match.captured(2)));
      }
    }
    if (palette.contains("background") && palette.contains("foreground")) {
      const QColor bg = palette["background"];
      QColor fg = palette["foreground"];
      const QColor high =
          luminance(bg) < .18 ? QColor("white") : QColor("black");
      if (contrast(bg, fg) < 4.5)
        fg = high;
      QColor accent = palette.value("accent", palette.value("color4", fg));
      if (contrast(bg, accent) < 4.5)
        accent = fg;
      colors = {{"canvas", bg.name()},
                {"ink", fg.name()},
                {"muted", blend(fg, bg, .25).name()},
                {"surface", blend(bg, fg, .025).name()},
                {"sidebar", blend(bg, fg, .05).name()},
                {"line", blend(bg, fg, .25).name()},
                {"accent", accent.name()},
                {"onAccent", contrast(accent, QColor("black")) >
                                     contrast(accent, QColor("white"))
                                 ? "#000000"
                                 : "#ffffff"},
                {"tint", blend(bg, accent, .13).name()}};
      note = "Following the active Omarchy palette.";
    } else
      note = "Omarchy colors unavailable. Using Glacier until a palette is "
             "available.";
  }
  if (colors != m_colors || note != m_themeNote) {
    m_colors = colors;
    m_themeNote = note;
    emit themeChanged();
  }
}
void Bridge::request(const QString &action, const QVariantMap &arguments,
                     const QString &requestID) {
  if (m_preview) {
    QTimer::singleShot(0, this, [this, action, requestID] {
      if (m_fixture.contains(action))
        emit reply(action, m_fixture.value(action), requestID);
      else
        emit failed(action,
                    "Preview mode uses sample data. No changes were made.", requestID);
    });
    return;
  }
  const QString pendingKey = requestID.isEmpty() ? action : action + ':' + requestID;
  if (m_pending.contains(pendingKey))
    return;
  m_pending.insert(pendingKey);
  sendRequest(action, arguments, requestID,
              [this, pendingKey] { m_pending.remove(pendingKey); });
}
void Bridge::requestShortcutEdge(const QString &action) {
  // One-shot shortcuts share the queue so a cancel cannot overtake a pending start.
  if (action != "start" && action != "stop" && action != "cancel" && action != "undo" &&
      action != "copyLast")
    return;
  // CLOCK_MONOTONIC milliseconds, the same clock as the client's process.hrtime.
  const double at = std::chrono::duration<double, std::milli>(
                        std::chrono::steady_clock::now().time_since_epoch())
                        .count();
  m_shortcutEdges.enqueue({action, at});
  sendNextShortcutEdge();
}
void Bridge::sendNextShortcutEdge() {
  if (m_shortcutEdgeInFlight || m_shortcutEdges.isEmpty())
    return;
  m_shortcutEdgeInFlight = true;
  const auto [action, at] = m_shortcutEdges.dequeue();
  // Tagged so the client can tell shortcut edges from the microphone test's Stop,
  // and timed so a slow lock check cannot stretch or shrink the gesture.
  sendRequest(action, {{"shortcut", true}, {"at", at}}, {}, [this] {
    m_shortcutEdgeInFlight = false;
    QTimer::singleShot(0, this, [this] { sendNextShortcutEdge(); });
  });
}
void Bridge::sendRequest(const QString &action, const QVariantMap &arguments,
                         const QString &requestID,
                         std::function<void()> complete) {
  auto *socket = new QLocalSocket(this);
  auto *timer = new QTimer(socket);
  timer->setSingleShot(true);
  auto bytes = std::make_shared<QByteArray>();
  auto finished = std::make_shared<bool>(false);
  auto finish = [this, socket, timer, action, requestID, bytes, finished,
                 complete](bool valid) {
    if (*finished)
      return;
    *finished = true;
    timer->stop();
    complete();
    if (valid)
      receive(action, *bytes, requestID);
    else {
      disconnected();
      if (action != "snapshot")
        emit failed(
            action,
            "Dictation is unavailable. Try reconnecting in This computer.", requestID);
    }
    socket->abort();
    socket->deleteLater();
  };
  connect(socket, &QLocalSocket::connected, socket,
          [socket, action, arguments] {
            auto request = QJsonObject::fromVariantMap(arguments);
            request.insert("version", 1);
            request.insert("action", action);
            socket->write(
                QJsonDocument(request).toJson(QJsonDocument::Compact) + '\n');
          });
  connect(socket, &QLocalSocket::readyRead, socket, [socket, bytes, finish] {
    bytes->append(socket->readAll());
    if (bytes->size() > maximumResponseBytes)
      finish(false);
    else if (bytes->endsWith('\n'))
      finish(true);
  });
  connect(socket, &QLocalSocket::errorOccurred, socket,
          [finish](QLocalSocket::LocalSocketError) { finish(false); });
  connect(timer, &QTimer::timeout, socket, [finish] { finish(false); });
  int timeout = 12000;
  if (action == "snapshot")
    timeout = 2000;
  else if (action == "saveShortcut")
    timeout = 35000;
  else if (action == "history" || action == "historyEntry")
    timeout = 70000;
  else if (action == "deleteHistory")
    timeout = 75000;
  else if (action == "historyAudio" || action == "historyArtifact")
    timeout = 370000;
  timer->start(timeout);
  const QString runtime = qEnvironmentVariable("XDG_RUNTIME_DIR");
  if (runtime.isEmpty()) {
    finish(false);
    return;
  }
  socket->connectToServer(runtime + "/sottoduo-client/control.sock");
}
void Bridge::receive(const QString &action, const QByteArray &bytes,
                     const QString &requestID) {
  QJsonParseError error;
  const auto document = QJsonDocument::fromJson(bytes, &error);
  const auto object = document.object();
  if (error.error != QJsonParseError::NoError || !object.value("ok").toBool()) {
    if (action == "snapshot") {
      disconnected();
    } else
      emit failed(action,
                  object.value("error").toString("Invalid client response."), requestID);
    return;
  }
  if (action == "snapshot") {
    const auto next = object.value("data").toObject().toVariantMap();
    if (next.value("version").toInt() != 1) {
      disconnected();
      return;
    }
    m_poll.setInterval(
        next.value("activity").toMap().value("phase").toString() == "recording"
            ? 100
            : 500);
    if (next != m_snapshot || !m_connected) {
      m_snapshot = next;
      m_connected = true;
      m_connectionChecked = true;
      m_hasConnected = true;
      emit snapshotChanged();
    }
  } else
    emit reply(action, object.value("data").toVariant(), requestID);
}
void Bridge::copy(const QString &text) {
  if (!text.isEmpty())
    QApplication::clipboard()->setText(text);
}
void Bridge::previewPhase(const QString &phase) {
  if (!m_preview)
    return;
  auto activity = m_snapshot.value("activity").toMap();
  activity["phase"] = phase;
  m_snapshot["activity"] = activity;
  emit snapshotChanged();
}
