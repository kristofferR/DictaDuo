#include "Bridge.h"
#include "GuiInstance.h"
#include "HudSurface.h"
#include "PortalShortcuts.h"
#include <LayerShellQt/Shell>
#include <QApplication>
#include <QCommandLineParser>
#include <QDateTime>
#include <QDir>
#include <QIcon>
#include <QMenu>
#include <QPainter>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QSystemTrayIcon>
#include <QTimer>

namespace {
QIcon dot(const QColor &color) {
  QPixmap pixmap(12, 12);
  pixmap.fill(Qt::transparent);
  QPainter painter(&pixmap);
  painter.setRenderHint(QPainter::Antialiasing);
  painter.setPen(Qt::NoPen);
  painter.setBrush(color);
  painter.drawEllipse(QRectF(3, 3, 6, 6));
  return QIcon(pixmap);
}
/** The tray mark with a static recording dot in its corner; no animation. */
QIcon recordingIcon(const QIcon &mark) {
  QIcon icon;
  for (const int size : {16, 22, 24, 32, 48, 64}) {
    QPixmap pixmap = mark.pixmap(size, size);
    QPainter painter(&pixmap);
    painter.setRenderHint(QPainter::Antialiasing);
    const qreal diameter = size * 0.46;
    painter.setPen(QPen(QColor("#ffffff"), std::max(1.0, size / 16.0)));
    painter.setBrush(QColor("#e5484d"));
    painter.drawEllipse(QRectF(size - diameter - 0.5, size - diameter - 0.5,
                               diameter, diameter));
    icon.addPixmap(pixmap);
  }
  return icon;
}
} // namespace

int main(int argc, char **argv) {
#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
#endif
  LayerShellQt::Shell::useLayerShell();
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif
  QApplication app(argc, argv);
  app.setOrganizationName("SottoDuo");
  app.setApplicationName("SottoDuo");
  app.setDesktopFileName("sottoduo");
  QCommandLineParser parser;
  parser.setApplicationDescription("SottoDuo for Linux");
  parser.addHelpOption();
  parser.addOption(
      {"preview", "Show sample data without connecting to a client."});
  parser.addOption(
      {"background",
       "Keep dictation feedback available without opening settings."});
  parser.addOption(
      {"theme", "Preview appearance: system, light, dark or omarchy.", "name"});
  parser.addOption({"capture",
                    "Save preview screenshots and exit (requires --preview).",
                    "directory"});
  parser.process(app);
  const bool preview = parser.isSet("preview");
  const bool background = parser.isSet("background");
  if (parser.isSet("capture") && !preview)
    return 2;
  if (preview && background)
    return 2;
  GuiInstance instance;
  if (!preview) {
    const auto result = instance.acquire(background);
    if (result == GuiInstance::Result::Forwarded)
      return 0;
    if (result == GuiInstance::Result::Failed) {
      qCritical().noquote() << instance.error();
      return 1;
    }
    app.setQuitOnLastWindowClosed(false);
  }
  QQuickStyle::setStyle("Basic");
  qmlRegisterSingletonType<HudSurface>(
      "SottoDuo.Native", 1, 0, "HudSurface",
      [](QQmlEngine *, QJSEngine *) -> QObject * { return new HudSurface; });
  Bridge bridge(preview);
  PortalShortcuts portalShortcuts(!preview);
  if (!preview) {
    QObject::connect(&portalShortcuts, &PortalShortcuts::pressed, &bridge,
                     [&bridge] { bridge.requestShortcutEdge("start"); });
    QObject::connect(&portalShortcuts, &PortalShortcuts::released, &bridge,
                     [&bridge] { bridge.requestShortcutEdge("stop"); });
    QObject::connect(&portalShortcuts, &PortalShortcuts::action, &bridge,
                     [&bridge](const QString &name) {
                       bridge.requestShortcutEdge(name == "copy" ? "copyLast" : name);
                     });
  }
  if (parser.isSet("theme"))
    bridge.setTheme(parser.value("theme"));
  QQmlApplicationEngine engine;
  engine.setInitialProperties({{"startHidden", background}});
  engine.rootContext()->setContextProperty("bridge", &bridge);
  engine.rootContext()->setContextProperty("portalShortcuts", &portalShortcuts);
  QObject::connect(
      &engine, &QQmlApplicationEngine::objectCreationFailed, &app,
      [] { QCoreApplication::exit(1); }, Qt::QueuedConnection);
  engine.loadFromModule("SottoDuo", "Main");
  if (engine.rootObjects().isEmpty())
    return 1;
  auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
  if (!window)
    return 1;
  const QIcon markIcon(":/qt/qml/SottoDuo/mark.svg");
  const QIcon recordingMark = recordingIcon(markIcon);
  QSystemTrayIcon tray(markIcon);
  QMenu menu;
  menu.setToolTipsVisible(true);
  auto *status = menu.addAction("Checking server");
  status->setEnabled(false);
  menu.addSeparator();
  // Menu text cannot tick while open, so Undo has no countdown and hides when it expires.
  auto *undo = menu.addAction("Undo: paste it now", &bridge,
                              [&bridge] { bridge.request("undo"); });
  auto *finish = menu.addAction("Finish dictation", &bridge,
                                [&bridge] { bridge.request("stop"); });
  auto *cancel = menu.addAction("Cancel dictation", &bridge,
                                [&bridge] { bridge.request("cancel"); });
  auto *start = menu.addAction("Start dictation", &bridge,
                               [window] { QMetaObject::invokeMethod(window, "startFromTray"); });
  auto *copyLast = menu.addAction("Copy last dictation", &bridge,
                                  [&bridge] { bridge.request("copyLast"); });
  menu.addSeparator();
  auto show = [window] {
    window->show();
    window->raise();
    window->requestActivate();
  };
  QObject::connect(&instance, &GuiInstance::showRequested, &app, show);
  menu.addAction("Open SottoDuo", &app, show);
  auto quit = [window, &app] {
    window->setProperty("quitRequested", true);
    if (window->close())
      app.quit();
    else if (!window->property("quitRequested").toBool()) {
      window->show();
      window->requestActivate();
    }
  };
  auto *quitAction = menu.addAction("Quit SottoDuo feedback", &app, quit);
  quitAction->setToolTip(
      portalShortcuts.plasma()
          ? "Closes this window and the tray. The Plasma shortcut stops until "
            "you open SottoDuo again."
          : "Closes this window and the tray. Dictation keeps running in the "
            "background.");
  // Icons are only replaced when they change, since each update reaches the tray host.
  auto recordingShown = std::make_shared<bool>(false);
  auto statusColor = std::make_shared<QString>("unset");
  auto updateTray = [&bridge, &menu, &tray, window, status, undo, finish,
                     cancel, start, copyLast, markIcon, recordingMark,
                     recordingShown, statusColor] {
    const auto snapshot = bridge.snapshot();
    const auto activity = snapshot.value("activity").toMap();
    const QString phase = activity.value("phase").toString();
    const bool busy = snapshot.value("busy").toBool();
    const bool undoOpen = activity.value("undoUntil").toDouble() >
                          double(QDateTime::currentMSecsSinceEpoch());
    const bool recording = phase == "recording" && !undoOpen;
    status->setText(window->property("trayStatus").toString());
    const QString color = undoOpen    ? ""
                          : recording ? "#e5484d"
                          : window->property("serverReady").toBool()
                              ? "#4ade80"
                              : "#fb923c";
    if (*statusColor != color) {
      *statusColor = color;
      status->setIcon(color.isEmpty() ? QIcon() : dot(QColor(color)));
    }
    undo->setVisible(undoOpen);
    finish->setVisible(recording &&
                       activity.value("trigger").toString() == "shortcut");
    cancel->setVisible(
        busy && !undoOpen &&
        QStringList{"preparing", "recording", "processing"}.contains(phase));
    // During undo, Start only shows once a new take can start; otherwise it would paste.
    start->setVisible(window->property("canStartTake").toBool());
    start->setEnabled(window->property("canStart").toBool());
    const QString key = window->property("dictationKey").toString();
    // Text after a tab is drawn as the menu's shortcut hint.
    start->setText(key.isEmpty() ? "Start dictation" : "Start dictation\t" + key);
    copyLast->setEnabled(snapshot.value("hasLastDictation").toBool());
    menu.setDefaultAction(undoOpen    ? undo
                          : recording ? finish
                                      : nullptr);
    if (*recordingShown != recording) {
      *recordingShown = recording;
      tray.setIcon(recording ? recordingMark : markIcon);
    }
  };
  QObject::connect(&menu, &QMenu::aboutToShow, &app, updateTray);
  QObject::connect(&bridge, &Bridge::snapshotChanged, &app, updateTray);
  updateTray();
  QObject::connect(bridge.desktop(), &DesktopIntegration::quitRequested, &app,
                   quit);
  tray.setToolTip("SottoDuo");
  tray.setContextMenu(&menu);
  QObject::connect(&tray, &QSystemTrayIcon::activated, &app,
                   [show](QSystemTrayIcon::ActivationReason reason) {
                     if (reason == QSystemTrayIcon::Trigger)
                       show();
                   });
  if (!preview && QSystemTrayIcon::isSystemTrayAvailable()) {
    tray.show();
  }
  if (parser.isSet("capture")) {
    const QString directory = parser.value("capture");
    QDir().mkpath(directory);
    auto *timer = new QTimer(&app);
    // Five pages, then each preview.json state on the Dictation page.
    auto step = std::make_shared<int>(-1);
    auto name = std::make_shared<QString>();
    auto success = std::make_shared<bool>(true);
    QObject::connect(
        timer, &QTimer::timeout, &app,
        [&, timer, step, name, success, directory] {
          if (*step >= 0)
            *success = window->grabWindow().save(directory + '/' + *name +
                                                 ".png") &&
                       *success;
          ++*step;
          if (*step == 5 + bridge.previewStateCount()) {
            timer->stop();
            app.exit(*success ? 0 : 1);
            return;
          }
          if (*step < 5) {
            *name = QString("page-%1").arg(*step);
            window->setProperty("page", *step);
          } else {
            *name = "dictation-" + bridge.applyPreviewState(*step - 5);
            window->setProperty("page", 0);
          }
        });
    timer->start(400);
  }
  return app.exec();
}
