#include "Bridge.h"
#include "GuiInstance.h"
#include "HudSurface.h"
#include "PortalShortcuts.h"
#include <LayerShellQt/Shell>
#include <QApplication>
#include <QCommandLineParser>
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
  QSystemTrayIcon tray(QIcon(":/qt/qml/SottoDuo/mark.svg"));
  QMenu menu;
  auto *connectionStatus = menu.addAction("Checking server");
  menu.addSeparator();
  QObject::connect(&menu, &QMenu::aboutToShow, &app,
                   [window, connectionStatus] {
                     const bool ready = window->property("serverReady").toBool();
                     QPixmap dot(12, 12);
                     dot.fill(Qt::transparent);
                     QPainter painter(&dot);
                     painter.setRenderHint(QPainter::Antialiasing);
                     painter.setPen(Qt::NoPen);
                     painter.setBrush(QColor(ready ? "#4ade80" : "#fb923c"));
                     painter.drawEllipse(QRectF(3, 3, 6, 6));
                     connectionStatus->setIcon(QIcon(dot));
                     connectionStatus->setText(window->property("connection").toString());
                   });
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
  menu.addAction(portalShortcuts.plasma()
                     ? "Quit SottoDuo feedback (Plasma shortcut stops)"
                     : "Quit SottoDuo feedback (dictation stays running)",
                 &app, quit);
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
    auto page = std::make_shared<int>(-1);
    auto success = std::make_shared<bool>(true);
    QObject::connect(
        timer, &QTimer::timeout, &app, [&, timer, page, success, directory] {
          if (*page >= 0)
            *success = window->grabWindow().save(
                           directory + QString("/page-%1.png").arg(*page)) &&
                       *success;
          ++*page;
          if (*page == 5) {
            timer->stop();
            app.exit(*success ? 0 : 1);
            return;
          }
          window->setProperty("page", *page);
        });
    timer->start(400);
  }
  return app.exec();
}
