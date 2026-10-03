#include "../Bridge.h"
#include "../HudSurface.h"
#include <LayerShellQt/Shell>
#include <QApplication>
#include <QColor>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QJSValue>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalServer>
#include <QLocalSocket>
#include <QQmlApplicationEngine>
#include <QQmlComponent>
#include <QQmlContext>
#include <QQuickItem>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>
#include <QTimer>

class BridgeTest : public QObject {
  Q_OBJECT
private slots:
  void initTestCase() {
    QQuickStyle::setStyle("Basic");
    qmlRegisterSingletonType<HudSurface>(
        "SottoDuo.Native", 1, 0, "HudSurface",
        [](QQmlEngine *, QJSEngine *) -> QObject * { return new HudSurface; });
  }
  void waylandOverlayLifecycle() {
    if (!qEnvironmentVariableIsSet("SOTTODUO_GUI_TEST_WAYLAND"))
      QSKIP("Opt-in compositor test; run this slot alone on Wayland.");
    QVERIFY(QGuiApplication::platformName().startsWith("wayland"));
    Bridge bridge(true);
    QQmlEngine engine;
    QSignalSpy warnings(&engine, &QQmlEngine::warnings);
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false}, {"supported", false}, {"trigger", ""}, {"message", ""}});
    QQmlComponent model(&engine);
    model.setData(R"(
      import QtQml
      QtObject {
        property bool visible: false
        property bool active: false
        property bool busy: false
        property var activity: ({ phase: "idle", source: "No microphone in use" })
        property var feedback: ({})
        function duration(seconds) { return "0:00"; }
        property int undoSeconds: 0
        property string dictationKey: ""
        property string fallbackNote: ""
        property var c: bridge.colors
        function messageFor(phase) { return "Dictation preview"; }
      }
    )",
                  QUrl());
    QScopedPointer<QObject> ui(model.create());
    QVERIFY2(ui, qPrintable(model.errorString()));
    QQmlComponent component(
        &engine, QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/Hud.qml"));
    QScopedPointer<QObject> object(component.createWithInitialProperties(
        {{"ui", QVariant::fromValue(ui.data())}}));
    QVERIFY2(object, qPrintable(component.errorString()));
    auto *hud = qobject_cast<QQuickWindow *>(object.data());
    QVERIFY(hud);
    for (int cycle = 0; cycle < 2; ++cycle) {
      hud->show();
      QVERIFY(QTest::qWaitForWindowExposed(hud));
      QTest::qWait(2000);
      QVERIFY(!hud->isActive());
      const QString capture = qEnvironmentVariable("SOTTODUO_GUI_TEST_CAPTURE");
      if (!capture.isEmpty())
        QVERIFY(hud->grabWindow().save(capture));
      hud->hide();
      QTest::qWait(500);
    }
    QCOMPARE(warnings.count(), 0);
  }
  void themeFollowsPaletteAndRecovers() {
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    qputenv("XDG_STATE_HOME", directory.path().toUtf8());
    qputenv("XDG_CONFIG_HOME", directory.path().toUtf8());
    const QString path = directory.path() + "/omarchy/current/theme";
    QVERIFY(QDir().mkpath(path));
    auto write = [&path](const QByteArray &colors) {
      QFile file(path + "/colors.toml");
      QVERIFY(file.open(QIODevice::WriteOnly));
      QCOMPARE(file.write(colors), colors.size());
    };
    write("background = \"#101913\"\nforeground = \"#a1af9c\"\naccent = "
          "\"#4a9a68\"\n");
    Bridge bridge(true);
    bridge.setTheme("omarchy");
    QCOMPARE(bridge.colors()["canvas"].toString(), "#101913");
    QCOMPARE(bridge.colors()["accent"].toString(), "#4a9a68");
    write(
        "background = '#ffffff'\nforeground = '#111111'\naccent = '#0000aa'\n");
    QTRY_COMPARE_WITH_TIMEOUT(bridge.colors()["canvas"].toString(),
                              QString("#ffffff"), 4500);
    // A missing theme uses an explicit fallback and recovers when it returns.
    QVERIFY(QFile::remove(path + "/colors.toml"));
    bridge.setTheme("omarchy");
    QCOMPARE(bridge.colors()["canvas"].toString(), "#1b252e");
    QVERIFY(bridge.themeNote().contains("unavailable"));
    bridge.setTheme("light");
    QCOMPARE(bridge.colors()["canvas"].toString(), "#f8f6f2");
  }
  void privateSocketReceivesStructuredSnapshot() {
    QTemporaryDir directory;
    qputenv("XDG_RUNTIME_DIR", directory.path().toUtf8());
    QVERIFY(QDir().mkpath(directory.path() + "/sottoduo-client"));
    QLocalServer server;
    QVERIFY(server.listen(directory.path() + "/sottoduo-client/control.sock"));
    QByteArray input;
    connect(&server, &QLocalServer::newConnection, &server, [&] {
      auto *socket = server.nextPendingConnection();
      connect(socket, &QLocalSocket::readyRead, socket, [&, socket] {
        input += socket->readAll();
        if (input.endsWith('\n'))
          socket->write("{\"ok\":true,\"data\":{\"version\":1,\"activity\":{"
                        "\"phase\":\"recording\"},\"busy\":true}}\n");
      });
    });
    Bridge bridge(false);
    QTRY_VERIFY(bridge.connected());
    QCOMPARE(QJsonDocument::fromJson(input).object()["action"].toString(),
             "snapshot");
    QCOMPARE(bridge.snapshot()["activity"].toMap()["phase"].toString(),
             "recording");
    server.close();
    QTRY_VERIFY_WITH_TIMEOUT(!bridge.connected(), 2500);
    QVERIFY(bridge.snapshot().isEmpty());
    QCOMPARE(bridge.connectionStatus(), "unavailable");
  }
  void portalEdgesPreserveRepeatedPressRelease() {
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    qputenv("XDG_RUNTIME_DIR", directory.path().toUtf8());
    QVERIFY(QDir().mkpath(directory.path() + "/sottoduo-client"));
    QLocalServer server;
    QVERIFY(server.listen(directory.path() + "/sottoduo-client/control.sock"));
    QStringList edges;
    connect(&server, &QLocalServer::newConnection, &server, [&] {
      auto *socket = server.nextPendingConnection();
      connect(socket, &QLocalSocket::readyRead, socket, [&, socket] {
        if (!socket->canReadLine())
          return;
        const QString action = QJsonDocument::fromJson(socket->readLine())
                                   .object()["action"].toString();
        if (action == "snapshot") {
          socket->write("{\"ok\":true,\"data\":{\"version\":1}}\n");
          return;
        }
        edges.append(action);
        auto respond = [socket] { socket->write("{\"ok\":true,\"data\":{}}\n"); };
        if (edges.size() == 2)
          QTimer::singleShot(100, socket, respond);
        else
          respond();
      });
    });
    Bridge bridge(false);
    QTRY_VERIFY(bridge.connected());
    for (const auto &action : {"start", "stop", "start", "stop"})
      bridge.requestShortcutEdge(action);
    QTRY_COMPARE_WITH_TIMEOUT(edges.size(), 4, 3000);
    QCOMPARE(edges, (QStringList{"start", "stop", "start", "stop"}));
  }
  void offlinePagesShareOneConnectionNotice() {
    QTemporaryDir directory;
    qputenv("XDG_RUNTIME_DIR", directory.path().toUtf8());
    qputenv("SOTTODUO_CLIENT_CONFIG",
            (directory.path() + "/client.json").toUtf8());
    Bridge bridge(false);
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false}, {"supported", false}, {"trigger", ""}, {"message", ""}});
    QSignalSpy warnings(&engine, &QQmlEngine::warnings);
    engine.load(QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/Main.qml"));
    QVERIFY(!engine.rootObjects().isEmpty());
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    QVERIFY(window);
    QTRY_COMPARE(bridge.connectionStatus(), QString("setupRequired"));
    auto *banner = window->findChild<QQuickItem *>("connectionBanner");
    auto *notice = window->findChild<QQuickItem *>("actionNotice");
    QVERIFY(banner && notice);
    QVERIFY(banner->isVisible());
    for (const int page : {1, 3, 0}) {
      window->setProperty("page", page);
      QTest::qWait(50);
      QVERIFY(!notice->isVisible());
      QVERIFY(window->property("notice").toString().isEmpty());
    }
    auto *key = window->findChild<QQuickItem *>("shortcutKeycap");
    QVERIFY(key && key->isVisible());
    auto *offlineDot = window->findChild<QQuickItem *>("dictationConnectionDot");
    QVERIFY(offlineDot);
    QCOMPARE(offlineDot->property("color").value<QColor>(), QColor("#fb923c"));
    QVERIFY(key->width() > 0 && key->height() > 0);
    QVERIFY(!window->property("sourcesChecked").toBool());
    const QString capture = qEnvironmentVariable("SOTTODUO_GUI_TEST_CAPTURE");
    if (!capture.isEmpty())
      QVERIFY(window->grabWindow().save(capture));
    QFile config(qEnvironmentVariable("SOTTODUO_CLIENT_CONFIG"));
    QVERIFY(config.open(QIODevice::WriteOnly));
    config.close();
    bridge.request("snapshot");
    QTRY_COMPARE(bridge.connectionStatus(), QString("unavailable"));
    QVERIFY(banner->isVisible());
    QVERIFY(!notice->isVisible());
    QCOMPARE(warnings.count(), 0);
    qunsetenv("SOTTODUO_CLIENT_CONFIG");
  }
  void connectionStatusDotsCoverEachPage() {
    Bridge bridge(true);
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false}, {"supported", false}, {"trigger", ""}, {"message", ""}});
    engine.load(QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/Main.qml"));
    QVERIFY(!engine.rootObjects().isEmpty());
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    QVERIFY(window);
    QTRY_VERIFY(window->property("serverReady").toBool());
    auto *sidebar = window->findChild<QQuickItem *>("sidebarConnectionDot");
    QVERIFY(sidebar);
    const int pages[] = {0, 1, 3, 4};
    const char *names[] = {"dictationConnectionDot", "historyConnectionDot",
                           "preferencesConnectionDot", "computerConnectionDot"};
    for (int index = 0; index < 4; ++index) {
      window->setProperty("page", pages[index]);
      QTRY_VERIFY(window->findChild<QQuickItem *>(names[index]));
      auto *dot = window->findChild<QQuickItem *>(names[index]);
      window->setProperty("serverReady", true);
      QCOMPARE(dot->property("color").value<QColor>(), QColor("#4ade80"));
      QCOMPARE(sidebar->property("color").value<QColor>(), QColor("#4ade80"));
      window->setProperty("serverReady", false);
      QCOMPARE(dot->property("color").value<QColor>(), QColor("#fb923c"));
      QCOMPARE(sidebar->property("color").value<QColor>(), QColor("#fb923c"));
    }
  }
  void djiSettingsChooseTargetAndRetainSaveErrors() {
    QTemporaryDir directory;
    qputenv("XDG_RUNTIME_DIR", directory.path().toUtf8());
    QVERIFY(QDir().mkpath(directory.path() + "/sottoduo-client"));
    QLocalServer server;
    QVERIFY(server.listen(directory.path() + "/sottoduo-client/control.sock"));
    QJsonObject targetRequest;
    connect(&server, &QLocalServer::newConnection, &server, [&] {
      auto *socket = server.nextPendingConnection();
      connect(socket, &QLocalSocket::readyRead, socket, [&, socket] {
        if (!socket->canReadLine())
          return;
        const auto request = QJsonDocument::fromJson(socket->readLine()).object();
        if (request["action"] == "setButtonTarget")
          targetRequest = request;
        socket->write("{\"ok\":true,\"data\":{\"version\":1}}\n");
      });
    });
    Bridge bridge(false);
    QTRY_VERIFY(bridge.connected());
    QQmlEngine engine;
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false}, {"supported", false}, {"trigger", ""}, {"message", ""}});
    QSignalSpy warnings(&engine, &QQmlEngine::warnings);
    QQmlComponent model(&engine);
    model.setData(R"(
      import QtQml
      QtObject {
        property var snapshot: ({ buttonEnabled: true, buttonSettingsSupported: true,
          device: { id: "linux", name: "Omarchy" },
          button: { available: true, selectedHere: false,
            selected: { id: "b", device: { id: "mac", name: "MacBook" } },
            destinations: [{ id: "a", device: { id: "linux", name: "Omarchy" } },
                           { id: "b", device: { id: "mac", name: "MacBook" } }],
            buttonTarget: { mode: "lastDictated" } } })
        property bool busy: false
        property var c: bridge.colors
      }
    )",
                  QUrl());
    QScopedPointer<QObject> ui(model.create());
    QVERIFY2(ui, qPrintable(model.errorString()));
    QQmlComponent component(
        &engine,
        QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/DjiSettings.qml"));
    QScopedPointer<QObject> settings(component.createWithInitialProperties(
        {{"ui", QVariant::fromValue(ui.data())}}));
    QVERIFY2(settings, qPrintable(component.errorString()));
    auto *picker = settings->findChild<QQuickItem *>("djiTargetPicker");
    auto *receiving = settings->findChild<QQuickItem *>("djiEnabledSwitch");
    QVERIFY(picker && receiving);
    // Last dictated, this computer, MacBook, nowhere.
    QCOMPARE(picker->property("count").toInt(), 4);
    QCOMPARE(picker->property("currentIndex").toInt(), 0);
    QCOMPARE(settings->property("rightNow").toString(),
             "Right now: MacBook, where you last dictated");
    QVERIFY(picker->isEnabled() && receiving->isEnabled());
    ui->setProperty("busy", true);
    QVERIFY(!receiving->isEnabled());
    ui->setProperty("busy", false);

    // A pinned computer that is not connected stays listed as offline.
    auto state = ui->property("snapshot").value<QJSValue>().toVariant().toMap();
    auto button = state["button"].toMap();
    button["buttonTarget"] = QVariantMap{
        {"mode", "device"}, {"device", QVariantMap{{"id", "studio"}, {"name", "Studio"}}}};
    state["button"] = button;
    ui->setProperty("snapshot", state);
    QCOMPARE(picker->property("count").toInt(), 5);
    QCOMPARE(picker->property("currentIndex").toInt(), 3);
    QCOMPARE(picker->property("displayText").toString(), "Always Studio (offline)");
    QCOMPARE(settings->property("rightNow").toString(), "Right now: MacBook");

    QVERIFY(QMetaObject::invokeMethod(settings.data(), "chooseTarget", Q_ARG(QVariant, 4)));
    QTRY_COMPARE(targetRequest["target"].toObject()["mode"].toString(), QString("off"));
    QTRY_VERIFY(!settings->property("targeting").toBool());
    // The offline entry leaves the list once the target is "Nowhere".
    QCOMPARE(picker->property("count").toInt(), 4);
    QCOMPARE(picker->property("currentIndex").toInt(), 3);

    emit bridge.failed("setButtonTarget", "Cannot change the button");
    auto *error = settings->findChild<QQuickItem *>("djiSettingsError");
    QVERIFY(error);
    QCOMPARE(error->property("text").toString(), "Cannot change the button");
    QCOMPARE(picker->property("currentIndex").toInt(), 3);
    emit bridge.failed("saveButton", "Cannot save settings");
    QCOMPARE(error->property("text").toString(), "Cannot save settings");
    QCOMPARE(warnings.count(), 0);
  }
  void pagesRenderAndOverlayCannotTakeFocus() {
    Bridge bridge(true);
    bridge.setTheme("dark");
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false}, {"supported", false}, {"trigger", ""}, {"message", ""}});
    QSignalSpy warnings(&engine, &QQmlEngine::warnings);
    engine.load(QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/Main.qml"));
    QVERIFY(!engine.rootObjects().isEmpty());
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    QVERIFY(window);
    auto *hud = window->findChild<QQuickWindow *>("dictationHud");
    QVERIFY(hud);
    QVERIFY(!hud->transientParent());
    QVERIFY(hud->flags().testFlag(Qt::WindowDoesNotAcceptFocus));
    QVERIFY(hud->flags().testFlag(Qt::WindowTransparentForInput));
    for (int page = 0; page < 5; ++page) {
      QVERIFY(window->setProperty("page", page));
      QTest::qWait(50);
      QVERIFY(!window->grabWindow().isNull());
    }
    const QString djiCapture = qEnvironmentVariable("SOTTODUO_GUI_DJI_CAPTURE");
    if (!djiCapture.isEmpty()) {
      QVERIFY(window->setProperty("page", 2));
      QTest::qWait(50);
      auto *dji = window->findChild<QQuickItem *>("djiSettings");
      QVERIFY(dji);
      for (auto *parent = dji->parentItem(); parent;
           parent = parent->parentItem()) {
        if (parent->property("contentY").isValid()) {
          parent->setProperty("contentY",
                              dji->mapToItem(parent, QPointF()).y() +
                                  parent->property("contentY").toReal());
          break;
        }
      }
      QTest::qWait(50);
      QVERIFY(window->grabWindow().save(djiCapture));
      QVERIFY(window->setProperty("page", 4));
      QTest::qWait(50);
    }
    auto *login = window->findChild<QQuickItem *>("launchAtLoginSwitch");
    QVERIFY(login);
    QVERIFY(!login->isEnabled());
    for (auto *parent = login->parentItem(); parent;
         parent = parent->parentItem()) {
      if (parent->property("contentY").isValid()) {
        parent->setProperty("contentY",
                            parent->property("contentHeight").toReal() -
                                parent->height());
        break;
      }
    }
    QTest::qWait(50);
    const QString capture = qEnvironmentVariable("SOTTODUO_GUI_SETTINGS_CAPTURE");
    if (!capture.isEmpty())
      QVERIFY(window->grabWindow().save(capture));
    QCOMPARE(warnings.count(), 0);
    QVERIFY(!hud->isVisible());
  }
  void settingsCanStartHiddenAndCloseWithoutAbandoningTest() {
    Bridge bridge(true);
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false}, {"supported", false}, {"trigger", ""}, {"message", ""}});
    engine.setInitialProperties({{"startHidden", true}});
    QSignalSpy warnings(&engine, &QQmlEngine::warnings);
    engine.load(QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/Main.qml"));
    QVERIFY(!engine.rootObjects().isEmpty());
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    QVERIFY(window);
    QVERIFY(!window->isVisible());
    window->show();
    QVERIFY(window->isVisible());
    QVERIFY(QMetaObject::invokeMethod(window, "startMicrophoneTest"));
    QVERIFY(window->property("microphoneTestStarting").toBool());
    QVERIFY(!window->close());
    QVERIFY(window->isVisible());
    QTRY_VERIFY(!window->property("microphoneTestStarting").toBool());
    window->setProperty("microphoneTestStarting", true);
    auto failedSnapshot = window->property("snapshot").toMap();
    failedSnapshot["message"] = "No microphone is available.";
    window->setProperty("snapshot", failedSnapshot);
    window->setProperty("busy", false);
    window->setProperty(
        "activity", QVariantMap{{"phase", "failed"}, {"trigger", "test"}});
    QVERIFY(QMetaObject::invokeMethod(window, "syncMicrophoneTestStart"));
    QVERIFY(!window->property("microphoneTestStarting").toBool());
    window->setProperty("microphoneTestStarting", true);
    window->setProperty(
        "activity", QVariantMap{{"phase", "idle"}, {"trigger", "test"}});
    QVERIFY(QMetaObject::invokeMethod(window, "syncMicrophoneTestStart"));
    QVERIFY(!window->property("microphoneTestStarting").toBool());
    window->setProperty("busy", true);
    window->setProperty(
        "activity", QVariantMap{{"phase", "recording"}, {"trigger", "test"}});
    QVERIFY(!window->close());
    QVERIFY(window->isVisible());
    QVERIFY(!window->property("notice").toString().isEmpty());
    window->setProperty("busy", false);
    QVERIFY(window->close());
    QVERIFY(!window->isVisible());
    window->show();
    QVERIFY(window->isVisible());
    QCOMPARE(warnings.count(), 0);
  }
  void liveFeedbackShowsTimeAndPartialTextWithoutActivatingOverlay() {
    Bridge bridge(true);
    bridge.setTheme("dark");
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false}, {"supported", false}, {"trigger", ""}, {"message", ""}});
    QSignalSpy warnings(&engine, &QQmlEngine::warnings);
    engine.load(QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/Main.qml"));
    QVERIFY(!engine.rootObjects().isEmpty());
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    QVERIFY(window);
    QVariantMap feedback{
        {"elapsedSeconds", 145},
        {"partialText", "A provisional sentence"},
        {"streamAvailable", true},
        {"levels", QVariantList{0.05, 0.2, 0.5, 0.8, 0.4, 0.1, 0.3, 0.7, 0.2}}};
    QVariantMap state{{"busy", true},
                      {"activity", QVariantMap{{"phase", "recording"},
                                               {"trigger", "shortcut"},
                                               {"source", "DJI Mic Mini"},
                                               {"cloudUnavailable", true}}},
                      {"feedback", feedback}};
    window->setProperty("snapshot", state);
    auto *clock = window->findChild<QQuickItem *>("recordingClock");
    auto *text = window->findChild<QQuickItem *>("dictationTranscript");
    QVERIFY(clock && text);
    QCOMPARE(clock->property("text").toString(), "2:25");
    // Recording sessions have no duration limit, so no countdown is shown.
    QVERIFY(!window->findChild<QQuickItem *>("recordingLimitNotice"));
    QCOMPARE(text->property("text").toString(), "A provisional sentence");
    QTest::qWait(100);
    const QString capture = qEnvironmentVariable("SOTTODUO_GUI_LIVE_CAPTURE");
    if (!capture.isEmpty())
      QVERIFY(window->grabWindow().save(capture));
    auto *hud = window->findChild<QQuickWindow *>("dictationHud");
    QVERIFY(hud);
    QVERIFY(hud->flags().testFlag(Qt::WindowDoesNotAcceptFocus));
    QVERIFY(hud->flags().testFlag(Qt::WindowTransparentForInput));
    auto *subtitle = hud->findChild<QQuickItem *>("hudSubtitle");
    QVERIFY(subtitle);
    QCOMPARE(subtitle->property("text").toString(),
             "2:25 · Using local recognition (cloud unavailable)");
    const QString hudCapture = qEnvironmentVariable("SOTTODUO_GUI_HUD_CAPTURE");
    if (!hudCapture.isEmpty()) {
      hud->show();
      QTest::qWait(50);
      QVERIFY(hud->grabWindow().save(hudCapture));
      hud->hide();
    }
    feedback["levels"] = QVariantList{};
    state["feedback"] = feedback;
    state["activity"] = QVariantMap{{"phase", "processing"}};
    window->setProperty("snapshot", state);
    state["busy"] = false;
    state["activity"] = QVariantMap{{"phase", "completed"}};
    state["result"] =
        QVariantMap{{"text", "Final sentence."}, {"delivery", "preview"}};
    window->setProperty("snapshot", state);
    QCOMPARE(text->property("text").toString(), "Final sentence.");
    QCOMPARE(warnings.count(), 0);
  }
  void shortcutKeyAndCheckAreVisibleWithoutEnablingRecording() {
    Bridge bridge(true);
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false}, {"supported", false}, {"trigger", ""}, {"message", ""}});
    QSignalSpy warnings(&engine, &QQmlEngine::warnings);
    engine.load(QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/Main.qml"));
    QVERIFY(!engine.rootObjects().isEmpty());
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    QVERIFY(window);
    auto *key = window->findChild<QQuickItem *>("configuredShortcutKey");
    QVERIFY(key);
    QCOMPARE(key->property("text").toString(), "Menu");
    auto state = bridge.snapshot();
    auto shortcut = state["shortcut"].toMap();
    shortcut["check"] = QVariantMap{{"active", true},
                                    {"blocked", true},
                                    {"held", true},
                                    {"presses", 1},
                                    {"releases", 0},
                                    {"events", QVariantList{"0.0s  Check started", "0.5s  Press detected"}},
                                    {"remainingSeconds", 20},
                                    {"message", "Press detected"}};
    state["shortcut"] = shortcut;
    window->setProperty("snapshot", state);
    auto *test = window->findChild<QQuickItem *>("microphoneTestButton");
    QVERIFY(test && !test->isEnabled());
    window->setProperty("page", 4);
    QTest::qWait(50);
    auto *result = window->findChild<QQuickItem *>("shortcutCheckResult");
    QVERIFY(result);
    QVERIFY(result->property("text").toString().contains("Presses: 1"));
    auto *events = window->findChild<QQuickItem *>("shortcutDiagnosticsEvents");
    auto *toggle = window->findChild<QQuickItem *>("shortcutDiagnosticsToggle");
    QVERIFY(events && toggle);
    QVERIFY(QMetaObject::invokeMethod(toggle, "clicked"));
    QVERIFY(events->isVisible());
    QVERIFY(events->property("text").toString().contains("Press detected"));
    auto *settings = window->findChild<QQuickItem *>("shortcutSettings");
    QVERIFY(settings);
    const QString capture = qEnvironmentVariable("SOTTODUO_GUI_SHORTCUT_CAPTURE");
    if (!capture.isEmpty()) {
      for (auto *parent = settings->parentItem(); parent;
           parent = parent->parentItem()) {
        if (parent->property("contentY").isValid()) {
          parent->setProperty("contentY",
                              settings->mapToItem(parent, QPointF()).y() +
                                  parent->property("contentY").toReal());
          break;
        }
      }
      QTest::qWait(50);
      QVERIFY(window->grabWindow().save(capture));
    }
    QCOMPARE(warnings.count(), 0);
  }
  void microphoneSettingsSaveImmediatelyAndKeepInputsCurrent() {
    QTemporaryDir directory;
    qputenv("XDG_RUNTIME_DIR", directory.path().toUtf8());
    QVERIFY(QDir().mkpath(directory.path() + "/sottoduo-client"));
    QLocalServer server;
    QVERIFY(server.listen(directory.path() + "/sottoduo-client/control.sock"));
    QFile fixture(":/qt/qml/SottoDuo/preview.json");
    QVERIFY(fixture.open(QIODevice::ReadOnly));
    auto sample = QJsonDocument::fromJson(fixture.readAll()).object();
    int saves = 0;
    bool holdFirstSave = true;
    bool failNextSave = false;
    QLocalSocket *heldSocket = nullptr;
    QJsonObject heldRequest;
    auto completeSave = [&](QLocalSocket *socket, const QJsonObject &request) {
      auto snapshot = sample["snapshot"].toObject();
      auto microphones = snapshot["microphones"].toObject();
      if (request["revision"] != microphones["revision"]) {
        socket->write("{\"ok\":false,\"error\":\"Microphone settings changed. Reload the latest settings, then edit again.\"}\n");
        return;
      }
      microphones["value"] = request["value"];
      microphones["revision"] = QString("saved-%1").arg(++saves);
      snapshot["microphones"] = microphones;
      sample["snapshot"] = snapshot;
      socket->write(QJsonDocument(QJsonObject{{"ok", true}, {"data", microphones}})
                        .toJson(QJsonDocument::Compact) + '\n');
    };
    connect(&server, &QLocalServer::newConnection, &server, [&] {
      auto *socket = server.nextPendingConnection();
      connect(socket, &QLocalSocket::readyRead, socket, [&, socket] {
        if (!socket->canReadLine())
          return;
        const auto request = QJsonDocument::fromJson(socket->readLine()).object();
        const auto action = request["action"].toString();
        if (action == "setSharing") {
          auto reported = sample["sources"].toObject();
          auto items = reported["items"].toArray();
          for (int i = 0; i < items.size(); ++i) {
            auto item = items[i].toObject();
            if (item["identity"] == request["source"])
              item["shared"] = request["shared"];
            items[i] = item;
          }
          reported["items"] = items;
          sample["sources"] = reported;
          socket->write(QJsonDocument(QJsonObject{{"ok", true}, {"data", QJsonObject{{"sources", items}}}})
                            .toJson(QJsonDocument::Compact) + '\n');
          return;
        }
        if (action == "saveMicrophones") {
          if (failNextSave) {
            failNextSave = false;
            socket->write("{\"ok\":false,\"error\":\"Microphone settings changed. Reload the latest settings, then edit again.\"}\n");
            return;
          }
          if (holdFirstSave) {
            holdFirstSave = false;
            heldSocket = socket;
            heldRequest = request;
          } else {
            completeSave(socket, request);
          }
          return;
        }
        const auto data = sample.contains(action) ? sample[action]
                                                  : QJsonValue(QJsonObject());
        socket->write(QJsonDocument(QJsonObject{{"ok", true}, {"data", data}})
                          .toJson(QJsonDocument::Compact) + '\n');
      });
    });
    Bridge bridge(false);
    QTRY_VERIFY(bridge.connected());
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false}, {"supported", false}, {"trigger", ""}, {"message", ""}});
    QSignalSpy warnings(&engine, &QQmlEngine::warnings);
    engine.load(QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/Main.qml"));
    QVERIFY(!engine.rootObjects().isEmpty());
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    QVERIFY(window);
    window->setProperty("page", 2);
    auto *page = window->findChild<QQuickItem *>("microphonePage");
    auto *mode = window->findChild<QQuickItem *>("microphoneMode");
    auto *picker = window->findChild<QQuickItem *>("microphoneProfilePicker");
    auto *create = window->findChild<QQuickItem *>("newMicrophoneProfile");
    QVERIFY(page && mode && picker && create);
    QTRY_COMPARE(mode->property("count").toInt(), 4);
    // This computer shares its mics; each switch follows the server's answer.
    auto findVisual = [&](const QString &name) -> QQuickItem * {
      QList<QQuickItem *> pending{window->contentItem()};
      while (!pending.isEmpty()) {
        auto *item = pending.takeLast();
        if (item->objectName() == name)
          return item;
        for (auto *child : item->childItems())
          pending.append(child);
      }
      return nullptr;
    };
    auto *note = window->findChild<QQuickItem *>("microphoneSharingNote");
    auto *shareDji = findVisual("shareMicrophone0");
    auto *shareAirPods = findVisual("shareMicrophone1");
    QVERIFY(note && note->isVisible());
    QVERIFY(shareDji && shareAirPods);
    QVERIFY(shareDji->property("checked").toBool());
    QVERIFY(!shareAirPods->property("checked").toBool());
    QVERIFY(QMetaObject::invokeMethod(shareAirPods, "toggle"));
    QVERIFY(QMetaObject::invokeMethod(shareAirPods, "clicked"));
    QVERIFY(!page->property("sharingKey").toString().isEmpty());
    QVERIFY(shareAirPods->property("checked").toBool());
    QTRY_VERIFY(page->property("sharingKey").toString().isEmpty());
    // Refreshed inputs recreate the rows.
    shareAirPods = findVisual("shareMicrophone1");
    QVERIFY(shareAirPods && shareAirPods->property("checked").toBool());
    QVERIFY(sample["sources"].toObject()["items"].toArray()[1].toObject()["shared"].toBool());
    const QString capture = qEnvironmentVariable("SOTTODUO_GUI_MICROPHONE_CAPTURE");
    if (!capture.isEmpty()) {
      auto *content = page->property("contentItem").value<QQuickItem *>();
      QVERIFY(content);
      content->setProperty("contentY",
                           qMax(0.0, content->property("contentHeight").toReal() -
                                         content->height()));
      QTest::qWait(50);
      QVERIFY(window->grabWindow().save(capture));
      content->setProperty("contentY", 0);
    }

    // A second edit during the first write must persist the latest choice.
    QVERIFY(mode->setProperty("currentIndex", 3));
    QVERIFY(QMetaObject::invokeMethod(mode, "activated", Q_ARG(int, 3)));
    QTRY_VERIFY(heldSocket);
    QVERIFY(page->property("pending").toBool());
    auto *useList = window->findChild<QQuickItem *>("useMicrophonePriorityList");
    QVERIFY(useList && useList->isEnabled());
    QVERIFY(QMetaObject::invokeMethod(useList, "clicked"));
    completeSave(heldSocket, heldRequest);
    QTRY_COMPARE(saves, 2);
    QTRY_VERIFY(!page->property("dirty").toBool() &&
                !page->property("pending").toBool() &&
                !page->property("awaitingSnapshot").toBool());
    QCOMPARE(sample["snapshot"].toObject()["microphones"].toObject()["value"]
                 .toObject()["mode"].toString(), QString("automatic"));

    // Reordering and profile creation also persist on the action itself.
    const QVariantMap dji{{"hostID", "desktop"}, {"id", "dji"}};
    const QVariantMap airpods{{"hostID", "desktop"}, {"id", "airpods"}};
    QVERIFY(QMetaObject::invokeMethod(page, "movePriority",
                                      Q_ARG(QVariant, dji), Q_ARG(QVariant, airpods)));
    QTRY_COMPARE(saves, 3);
    QCOMPARE(sample["snapshot"].toObject()["microphones"].toObject()["value"]
                 .toObject()["priority"].toArray().first().toObject()["id"].toString(),
             QString("airpods"));
    QVERIFY(QMetaObject::invokeMethod(page, "editName", Q_ARG(QVariant, true)));
    auto *name = window->findChild<QQuickItem *>("microphoneProfileName");
    QVERIFY(name);
    name->setProperty("text", "Travel");
    QVERIFY(QMetaObject::invokeMethod(page, "saveName"));
    QTRY_COMPARE(saves, 4);
    QTRY_COMPARE(picker->property("currentIndex").toInt(), 1);
    QTRY_VERIFY(!page->property("dirty").toBool());

    failNextSave = true;
    QVERIFY(mode->setProperty("currentIndex", 1));
    QVERIFY(QMetaObject::invokeMethod(mode, "activated", Q_ARG(int, 1)));
    QTRY_VERIFY(page->property("conflicted").toBool());
    QCOMPARE(page->property("draft").value<QJSValue>().toVariant().toMap()["mode"].toString(),
             QString("systemDefault"));
    auto *reload = window->findChild<QQuickItem *>("reloadMicrophoneSettings");
    QVERIFY(reload && reload->isVisible());
    QVERIFY(QMetaObject::invokeMethod(reload, "clicked"));
    QTRY_VERIFY(!page->property("dirty").toBool() &&
                !page->property("conflicted").toBool());
    QCOMPARE(mode->property("currentIndex").toInt(), 0);

    auto snapshot = sample["snapshot"].toObject();
    snapshot["busy"] = true;
    sample["snapshot"] = snapshot;
    bridge.request("snapshot");
    QTRY_VERIFY(!create->isEnabled() && !picker->isEnabled());
    snapshot["busy"] = false;
    sample["snapshot"] = snapshot;
    bridge.request("snapshot");
    QTRY_VERIFY(create->isEnabled() && picker->isEnabled());

    auto reportedSources = sample["sources"].toObject();
    auto liveInputs = reportedSources["items"].toArray();
    liveInputs.append(QJsonObject{
        {"identity", QJsonObject{{"hostID", "desktop"}, {"id", "webcam"}}},
        {"name", "Webcam microphone"}, {"transport", "usb"},
        {"eligible", true}});
    reportedSources["items"] = liveInputs;
    sample["sources"] = reportedSources;
    QTRY_COMPARE_WITH_TIMEOUT(mode->property("count").toInt(), 5, 6000);
    liveInputs.removeLast();
    reportedSources["items"] = liveInputs;
    sample["sources"] = reportedSources;
    QTRY_COMPARE_WITH_TIMEOUT(mode->property("count").toInt(), 4, 6000);
    QCOMPARE(warnings.count(), 0);
  }
  void historyKeepsSelectionAndScopesConfirmedActions() {
    QTemporaryDir directory;
    qputenv("XDG_RUNTIME_DIR", directory.path().toUtf8());
    QVERIFY(QDir().mkpath(directory.path() + "/sottoduo-client"));
    QLocalServer server;
    QVERIFY(server.listen(directory.path() + "/sottoduo-client/control.sock"));
    QFile fixture(":/qt/qml/SottoDuo/preview.json");
    QVERIFY(fixture.open(QIODevice::ReadOnly));
    auto sample = QJsonDocument::fromJson(fixture.readAll()).object();
    auto items = sample["history"].toObject()["items"].toArray();
    auto olderItem = items[1].toObject();
    olderItem["id"] = "preview-older";
    QJsonObject deleted, audio;
    QString requestedSource;
    int reads = 0;
    int olderReads = 0;
    bool correlate = true;
    connect(&server, &QLocalServer::newConnection, &server, [&] {
      auto *socket = server.nextPendingConnection();
      connect(socket, &QLocalSocket::readyRead, socket, [&, socket] {
        if (!socket->canReadLine()) return;
        const auto request = QJsonDocument::fromJson(socket->readLine()).object();
        const auto action = request["action"].toString();
        auto data = sample.value(action);
        if (action == "history") {
          ++reads;
          const bool older = !request["before"].toString().isEmpty();
          if (older) ++olderReads;
          requestedSource = request["source"].toString();
          data = QJsonObject{{"items", older ? QJsonArray{olderItem} : items}, {"nextCursor", older ? QJsonValue() : QJsonValue("older")}, {"queryID",correlate ? request["queryID"] : QJsonValue()}, {"server",sample["snapshot"].toObject()["server"]}};
        } else if (action == "deleteHistory") {
          deleted = request;
          items.removeAt(0);
          data = QJsonObject{{"id",request["id"]},{"server",request["server"]}};
        } else if (action == "historyAudio") {
          audio = request;
          socket->write(QJsonDocument(QJsonObject{{"ok",false},{"error","Recording no longer available. Refresh history."}}).toJson(QJsonDocument::Compact) + '\n');
          return;
        }
        socket->write(QJsonDocument(QJsonObject{{"ok",true},{"data",data}}).toJson(QJsonDocument::Compact) + '\n');
      });
    });
    Bridge bridge(false);
    QTRY_VERIFY(bridge.connected());
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false}, {"supported", false}, {"trigger", ""}, {"message", ""}});
    QSignalSpy warnings(&engine, &QQmlEngine::warnings);
    engine.load(QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/Main.qml"));
    QVERIFY(!engine.rootObjects().isEmpty());
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    QVERIFY(window);
    window->setProperty("page",1);
    auto *page = window->findChild<QQuickItem *>("historyPage");
    QVERIFY(page);
    const int listed = items.size() + 1;
    QTRY_COMPARE(page->property("records").toList().size(), listed);
    QTRY_VERIFY(olderReads > 0);
    QTRY_VERIFY(!page->property("loading").toBool());
    QCOMPARE(page->property("selectedID").toString(), "");
    page->setProperty("selectedID", "preview");
    auto *remove = page->findChild<QQuickItem *>("deleteHistory");
    auto *copy = page->findChild<QQuickItem *>("copyHistory");
    auto *date = page->findChild<QQuickItem *>("historyDetailDate");
    auto *open = page->findChild<QQuickItem *>("openHistoryAudio");
    auto *transcript = page->findChild<QQuickItem *>("historyTranscript");
    QVERIFY(remove && copy && date && open && transcript);
    QVERIFY(!date->property("text").toString().isEmpty());
    QVERIFY(QMetaObject::invokeMethod(copy, "clicked"));
    QCOMPARE(copy->property("symbolName").toString(), QString("check"));
    QCOMPARE(copy->property("accessibleLabel").toString(), QString("Copied transcript"));
    QVERIFY(open->isEnabled());
    QVERIFY(QMetaObject::invokeMethod(open,"clicked"));
    QTRY_VERIFY(!audio.isEmpty());
    QCOMPARE(audio["id"].toString(),"preview");
    QCOMPARE(audio["kind"].toString(),"inference");
    QTRY_VERIFY(page->property("message").toString().contains("no longer available"));
    page->setProperty("selectedID","preview-2");
    QCOMPARE(copy->property("symbolName").toString(), QString("copy"));
    QCOMPARE(copy->property("accessibleLabel").toString(), QString("Copy transcript"));
    QCOMPARE(page->property("selectedID").toString(),"preview-2");
    auto *list = page->findChild<QQuickItem *>("historyList");
    QVERIFY(list);
    QCOMPARE(list->property("count").toInt(),listed);
    auto *handle = window->findChild<QQuickItem *>("historyResizeHandle");
    QVERIFY(handle);
    const auto originalWidth = list->width();
    const auto start = handle->mapToScene(QPointF(handle->width() / 2,
                                                  handle->height() / 2)).toPoint();
    const auto end = start + QPoint(65, 0);
    QTest::mousePress(window, Qt::LeftButton, Qt::NoModifier, start);
    for (int step = 1; step <= 5; ++step)
      QTest::mouseMove(window, start + (end - start) * step / 5, 20);
    QTest::mouseRelease(window, Qt::LeftButton, Qt::NoModifier, end);
    QTRY_VERIFY(list->width() > originalWidth + 30);
    page->setProperty("deviceID","desktop");
    QCOMPARE(list->property("count").toInt(),1);
    QCOMPARE(page->property("selectedID").toString(),"preview");
    page->setProperty("deviceID","");
    QVERIFY(QMetaObject::invokeMethod(remove,"clicked"));
    auto *dialog = window->findChild<QObject *>("deleteHistoryDialog");
    QVERIFY(dialog);
    QVERIFY(dialog->property("visible").toBool());
    QVERIFY(deleted.isEmpty());
    page->setProperty("selectedID","preview-2");
    auto *confirm = window->findChild<QQuickItem *>("confirmHistoryDelete");
    QVERIFY(confirm);
    QVERIFY(QMetaObject::invokeMethod(confirm,"clicked"));
    QTRY_VERIFY(!deleted.isEmpty());
    QCOMPARE(deleted["id"].toString(),"preview");
    QTRY_VERIFY(!page->property("loading").toBool());
    QCOMPARE(page->property("selectedID").toString(),"preview-2");
    QTRY_COMPARE(list->property("count").toInt(),listed - 1);
    QVERIFY(QMetaObject::invokeMethod(page,"filterSource",Q_ARG(QVariant,"wispr-flow")));
    QTRY_COMPARE(requestedSource, "wispr-flow");
    QTRY_VERIFY(!page->property("loading").toBool());
    auto snapshot = sample["snapshot"].toObject();
    snapshot["server"] = "https://another.example.com";
    sample["snapshot"] = snapshot;
    const int previousReads = reads;
    bridge.request("snapshot");
    QTRY_VERIFY(reads > previousReads);
    QCOMPARE(page->property("server").toString(),"https://another.example.com");
    QTRY_VERIFY(!page->property("loading").toBool());
    correlate = false;
    const int beforeLegacy = reads;
    auto *refresh = page->findChild<QQuickItem *>("refreshHistory");
    QVERIFY(refresh);
    QVERIFY(QMetaObject::invokeMethod(refresh,"clicked"));
    QTRY_VERIFY(page->property("message").toString().contains("Update SottoDuo"));
    QVERIFY(!page->property("loading").toBool());
    QCOMPARE(reads, beforeLegacy + 2);
    QCOMPARE(warnings.count(),0);
  }
  void historyShowsStatusAndTranscribesAgain() {
    QTemporaryDir directory;
    qputenv("XDG_RUNTIME_DIR", directory.path().toUtf8());
    QVERIFY(QDir().mkpath(directory.path() + "/sottoduo-client"));
    QLocalServer server;
    QVERIFY(server.listen(directory.path() + "/sottoduo-client/control.sock"));
    QFile fixture(":/qt/qml/SottoDuo/preview.json");
    QVERIFY(fixture.open(QIODevice::ReadOnly));
    auto sample = QJsonDocument::fromJson(fixture.readAll()).object();
    const auto items = sample["history"].toObject()["items"].toArray();
    QStringList retried;
    QJsonObject settled;
    connect(&server, &QLocalServer::newConnection, &server, [&] {
      auto *socket = server.nextPendingConnection();
      connect(socket, &QLocalSocket::readyRead, socket, [&, socket] {
        if (!socket->canReadLine()) return;
        const auto request = QJsonDocument::fromJson(socket->readLine()).object();
        const auto action = request["action"].toString();
        const QJsonValue serverURL = sample["snapshot"].toObject().value("server");
        auto data = sample.value(action);
        if (action == "history") {
          data = QJsonObject{{"items", items}, {"queryID", request["queryID"]}, {"server", serverURL}};
        } else if (action == "retryHistory") {
          const QString id = request.value("id").toString();
          retried << id;
          QJsonObject record;
          for (const auto &item : items)
            if (item.toObject().value("id").toString() == id) record = item.toObject();
          settled = record;
          settled["status"] = "completed";
          // A failed retry of a finished take keeps it and says why.
          settled["error"] = id == "preview"
              ? QJsonValue("Transcribing again failed: The engine stopped. The previous transcript is kept.")
              : QJsonValue();
          record["status"] = "queued";
          data = QJsonObject{{"record", record}, {"server", serverURL}};
        } else if (action == "historyEntry") {
          data = QJsonObject{{"record", settled}, {"server", serverURL}};
        }
        socket->write(QJsonDocument(QJsonObject{{"ok",true},{"data",data}}).toJson(QJsonDocument::Compact) + '\n');
      });
    });
    Bridge bridge(false);
    QTRY_VERIFY(bridge.connected());
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false}, {"supported", false}, {"trigger", ""}, {"message", ""}});
    QSignalSpy warnings(&engine, &QQmlEngine::warnings);
    engine.load(QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/Main.qml"));
    QVERIFY(!engine.rootObjects().isEmpty());
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    QVERIFY(window);
    window->setProperty("page", 1);
    auto *page = window->findChild<QQuickItem *>("historyPage");
    QVERIFY(page);
    QTRY_COMPARE(page->property("records").toList().size(), items.size());
    QTRY_VERIFY(page->property("retrySupported").toBool());
    auto *chip = page->findChild<QQuickItem *>("historyDetailChip");
    auto *recognition = page->findChild<QQuickItem *>("historyRecognition");
    auto *banner = page->findChild<QQuickItem *>("historyBanner");
    auto *bannerText = page->findChild<QQuickItem *>("historyBannerText");
    auto *bannerRetry = page->findChild<QQuickItem *>("bannerRetryHistory");
    auto *retry = page->findChild<QQuickItem *>("retryHistory");
    auto *discard = page->findChild<QQuickItem *>("discardHistory");
    auto *remove = page->findChild<QQuickItem *>("deleteHistory");
    auto *dialog = window->findChild<QObject *>("retryHistoryDialog");
    QVERIFY(chip && recognition && banner && bannerText && bannerRetry && retry && discard && remove && dialog);
    auto label = [&] { return chip->property("status").toMap()["label"].toString(); };

    page->setProperty("selectedID", "preview");
    QCOMPARE(label(), QString("Pasted"));
    QCOMPARE(recognition->property("text").toString(), QString("Recognized with cloud · English · 0:08"));
    QVERIFY(!banner->isVisible());
    QCOMPARE(retry->property("text").toString(), QString("Transcribe again…"));
    QVERIFY(QMetaObject::invokeMethod(retry, "clicked"));
    QVERIFY(dialog->property("visible").toBool());
    QVERIFY(dialog->property("engine").toString().contains("Whisper, language Detect automatically"));
    QVERIFY(retried.isEmpty());
    auto *confirm = window->findChild<QQuickItem *>("confirmHistoryRetry");
    QVERIFY(confirm);
    QVERIFY(QMetaObject::invokeMethod(confirm, "clicked"));
    QTRY_COMPARE(retried, QStringList{"preview"});
    QTRY_VERIFY(page->property("message").toString().startsWith("Transcribing again failed"));
    QCOMPARE(page->property("retryingID").toString(), QString());
    auto *errorBanner = page->findChild<QQuickItem *>("historyErrorBanner");
    QVERIFY(errorBanner && errorBanner->property("visible").toBool());
    QCOMPARE(label(), QString("Pasted"));

    page->setProperty("selectedID", "preview-cancelled");
    QCOMPARE(label(), QString("Not pasted"));
    QCOMPARE(recognition->property("text").toString(), QString("Recognized locally (cloud unavailable) · Norwegian · 0:05"));

    page->setProperty("selectedID", "preview-test");
    QCOMPARE(label(), QString("Test (no paste)"));

    page->setProperty("selectedID", "preview-failed");
    QVERIFY(banner->isVisible());
    QVERIFY(bannerText->property("text").toString().contains("stopped responding"));
    QVERIFY(bannerRetry->isVisible());
    QVERIFY(!retry->isVisible());
    QVERIFY(QMetaObject::invokeMethod(bannerRetry, "clicked"));
    QVERIFY(!dialog->property("visible").toBool());
    QTRY_COMPARE(retried, (QStringList{"preview", "preview-failed"}));
    QTRY_VERIFY(page->property("retryingID").toString().isEmpty());
    QCOMPARE(page->property("message").toString(), QString("Transcribed again."));

    page->setProperty("selectedID", "preview-interrupted");
    QVERIFY(banner->isVisible());
    QCOMPARE(bannerText->property("text").toString(),
             QString("The recording stopped before it finished. 0:31 of audio is saved. Finish it on MacBook."));
    QVERIFY(!bannerRetry->isVisible());
    QVERIFY(!retry->isVisible());
    QVERIFY(discard->isVisible());
    QVERIFY(!remove->isVisible());
    QCOMPARE(warnings.count(), 0);
  }
  void processingDraftsSurviveConflictsAndNavigation() {
    QTemporaryDir directory;
    qputenv("XDG_RUNTIME_DIR", directory.path().toUtf8());
    QVERIFY(QDir().mkpath(directory.path() + "/sottoduo-client"));
    QLocalServer server;
    QVERIFY(server.listen(directory.path() + "/sottoduo-client/control.sock"));
    QFile fixture(":/qt/qml/SottoDuo/preview.json");
    QVERIFY(fixture.open(QIODevice::ReadOnly));
    auto sample = QJsonDocument::fromJson(fixture.readAll()).object();
    QJsonObject saved;
    connect(&server, &QLocalServer::newConnection, &server, [&] {
      auto *socket = server.nextPendingConnection();
      connect(socket, &QLocalSocket::readyRead, socket, [&, socket] {
        if (!socket->canReadLine()) return;
        const auto request = QJsonDocument::fromJson(socket->readLine()).object();
        const auto action = request["action"].toString();
        auto data = sample.value(action);
        if (action == "savePreferences") {
          QCOMPARE(request["server"], sample["snapshot"].toObject()["server"]);
          saved = request["value"].toObject();
          auto response = saved;
          response["revision"] = saved["revision"].toInt() + 1;
          sample["preferences"] = response;
          data = response;
        }
        socket->write(QJsonDocument(QJsonObject{{"ok", true}, {"data", data}})
                          .toJson(QJsonDocument::Compact) + '\n');
      });
    });
    Bridge bridge(false);
    QTRY_VERIFY(bridge.connected());
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false}, {"supported", false}, {"trigger", ""}, {"message", ""}});
    QSignalSpy warnings(&engine, &QQmlEngine::warnings);
    engine.load(QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/Main.qml"));
    QVERIFY(!engine.rootObjects().isEmpty());
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    QVERIFY(window);
    window->setProperty("page", 3);
    QVERIFY(QTest::qWaitForWindowExposed(window));
    window->requestActivate();
    QTRY_VERIFY(window->isActive());
    auto *page = window->findChild<QQuickItem *>("processingSettings");
    QVERIFY(page);
    QTRY_VERIFY(page->property("editable").toBool());
    auto *cleanup = page->findChild<QQuickItem *>("cleanupInstructions");
    auto *vocabulary = page->findChild<QQuickItem *>("recognitionVocabulary");
    auto *reset = page->findChild<QQuickItem *>("resetCleanupPrompt");
    auto *save = page->findChild<QQuickItem *>("saveProcessingSettings");
    auto *dictionary = page->findChild<QQuickItem *>("dictionaryEditor");
    auto *readiness = page->findChild<QQuickItem *>("speechModelReadiness");
    QVERIFY(cleanup && vocabulary && reset && save && dictionary && readiness);
    QTRY_COMPARE(readiness->property("status").toString(), "Ready");
    // The sample server has no Soniox key and is still loading the cleanup model.
    auto *cleanupStatus = page->findChild<QQuickItem *>("cleanupModelReadiness");
    auto *cloudStatus = page->findChild<QQuickItem *>("cloudRecognitionStatus");
    auto *mode = page->findChild<QQuickItem *>("recognitionMode");
    QVERIFY(cleanupStatus && cloudStatus && mode);
    QCOMPARE(cleanupStatus->property("status").toString(), "Loading");
    QVERIFY(cloudStatus->property("off").toBool());
    QVERIFY(!mode->property("choices").toList().at(1).toMap()["enabled"].toBool());
    QTRY_VERIFY(!page->property("defaultPrompt").toString().isEmpty());
    cleanup->forceActiveFocus();
    cleanup->setProperty("text", "Keep my wording.");
    vocabulary->forceActiveFocus();
    vocabulary->setProperty("text", "Keep my vocabulary.");
    QVERIFY(page->property("dirty").toBool());
    QVERIFY(save->isEnabled());
    // A same-revision poll leaves the editor and focus intact.
    emit bridge.reply("preferences", sample["preferences"].toObject().toVariantMap());
    QCOMPARE(cleanup->property("text").toString(), "Keep my wording.");
    QCOMPARE(vocabulary->property("text").toString(), "Keep my vocabulary.");
    QVERIFY(vocabulary->hasActiveFocus());
    window->setProperty("page", 0);
    window->setProperty("page", 3);
    QCOMPARE(window->findChild<QQuickItem *>("processingSettings"), page);
    QCOMPARE(cleanup->property("text").toString(), "Keep my wording.");
    // The shared revision advances elsewhere while these edits remain local.
    auto newer = sample["preferences"].toObject();
    newer["revision"] = 2;
    sample["preferences"] = newer;
    emit bridge.reply("preferences", newer.toVariantMap());
    QVERIFY(page->property("changedRemotely").toBool());
    QVERIFY(!save->isEnabled());
    QCOMPARE(cleanup->property("text").toString(), "Keep my wording.");
    QVERIFY(QMetaObject::invokeMethod(page, "read", Q_ARG(QVariant, true)));
    QTRY_VERIFY(!page->property("dirty").toBool());
    QTRY_VERIFY(!page->property("reading").toBool());
    QCOMPARE(vocabulary->property("text").toString(),
             newer["preferences"].toObject()["vocabulary"].toString());
    cleanup->forceActiveFocus();
    cleanup->setProperty("text", "Temporary cleanup.");
    QVERIFY(reset->isEnabled());
    QVERIFY(QMetaObject::invokeMethod(reset, "clicked"));
    QCOMPARE(cleanup->property("text"), page->property("defaultPrompt"));
    // A reset must retain the text binding for later edits and reloads.
    cleanup->forceActiveFocus();
    cleanup->setProperty("text", "Final cleanup.");
    auto findVisual = [&](const QString &name) -> QQuickItem * {
      QList<QQuickItem *> pending{window->contentItem()};
      while (!pending.isEmpty()) {
        auto *item = pending.takeLast();
        if (item->objectName() == name)
          return item;
        for (auto *child : item->childItems())
          pending.append(child);
      }
      return nullptr;
    };
    auto *firstToggle = findVisual("dictionaryListToggle_personal");
    QVERIFY(firstToggle);
    QVERIFY(QMetaObject::invokeMethod(firstToggle, "clicked"));
    auto *listName = findVisual("dictionaryListName_personal");
    QVERIFY(listName);
    QVERIFY(listName->isVisible());
    listName->forceActiveFocus();
    listName->setProperty("text", "Edited personal");
    QVERIFY(QMetaObject::invokeMethod(listName, "textEdited"));
    QVERIFY(QMetaObject::invokeMethod(dictionary, "addList"));
    const auto lists = dictionary->property("lists").value<QJSValue>().toVariant().toList();
    QCOMPARE(lists.size(), 2);
    const auto newID = lists.last().toMap()["id"].toString();
    listName = findVisual("dictionaryListName_personal");
    auto *newName = findVisual("dictionaryListName_" + newID);
    QVERIFY(listName && newName);
    QCOMPARE(listName->property("text").toString(), "Edited personal");
    QCOMPARE(newName->property("text").toString(), "New list");
    QVERIFY(listName->isVisible());
    QVERIFY(newName->isVisible());
    firstToggle = findVisual("dictionaryListToggle_personal");
    QVERIFY(firstToggle);
    QVERIFY(QMetaObject::invokeMethod(firstToggle, "clicked"));
    QVERIFY(!listName->isVisible());
    QVERIFY(newName->isVisible());
    QVERIFY(QMetaObject::invokeMethod(firstToggle, "clicked"));
    QVERIFY(listName->isVisible());
    auto *words = findVisual("dictionaryWords_personal");
    QVERIFY(words);
    auto *word = words->property("currentItem").value<QQuickItem *>();
    QVERIFY(word);
    auto *aliases = word->findChild<QQuickItem *>("dictionaryAliases");
    auto *priority = word->findChild<QQuickItem *>("dictionaryPriority");
    QVERIFY(aliases && priority);
    aliases->forceActiveFocus();
    aliases->setProperty("text", "so, too\nso toe");
    priority->setProperty("checked", false);
    QVERIFY(QMetaObject::invokeMethod(priority, "clicked"));
    QVERIFY(QMetaObject::invokeMethod(save, "clicked"));
    QTRY_VERIFY(!saved.isEmpty());
    QTRY_VERIFY(!page->property("saving").toBool());
    QCOMPARE(saved["revision"].toInt(), 2);
    QCOMPARE(saved["preferences"].toObject()["proofreadingPrompt"].toString(), "Final cleanup.");
    const auto savedDictionary = saved["preferences"].toObject()["dictionary"].toObject();
    const auto savedEntries = savedDictionary["lists"].toArray()[0].toObject()["entries"].toArray();
    QCOMPARE(savedEntries[0].toObject()["aliases"].toArray(), QJsonArray({"so, too", "so toe"}));
    QCOMPARE(savedEntries[0].toObject()["isPriority"].toBool(), false);
    QCOMPARE(savedEntries[0].toObject()["id"].toString(), "sottoduo");
    QCOMPARE(savedEntries[1], newer["preferences"].toObject()["dictionary"].toObject()["lists"].toArray()[0].toObject()["entries"].toArray()[1]);
    QCOMPARE(saved["preferences"].toObject()["vocabulary"], newer["preferences"].toObject()["vocabulary"]);
    emit bridge.reply("preferences", newer.toVariantMap());
    QCOMPARE(cleanup->property("text").toString(), "Final cleanup.");
    QVERIFY(!page->property("changedRemotely").toBool());
    QVERIFY(!page->property("dirty").toBool());
    // A failed save keeps the draft and shows its actionable error.
    cleanup->forceActiveFocus();
    cleanup->setProperty("text", "Unsaved after failure.");
    page->setProperty("saving", true);
    emit bridge.failed("savePreferences", "Check the dictionary replacement phrases.");
    QTRY_VERIFY(!page->property("reading").toBool());
    QCOMPARE(cleanup->property("text").toString(), "Unsaved after failure.");
    QVERIFY(page->property("dirty").toBool());
    QCOMPARE(page->property("message").toString(), "Check the dictionary replacement phrases.");
    const QString capture = qEnvironmentVariable("SOTTODUO_GUI_PROCESSING_CAPTURE");
    if (!capture.isEmpty()) {
      const auto expanded = dictionary->property("expandedIDs");
      dictionary->setProperty("expandedIDs", QVariantList{});
      for (auto *parent = dictionary->parentItem(); parent; parent = parent->parentItem()) {
        if (parent->property("contentY").isValid()) {
          parent->setProperty("contentY", dictionary->mapToItem(parent, QPointF()).y() + parent->property("contentY").toReal());
          break;
        }
      }
      QTest::qWait(50);
      QVERIFY(window->grabWindow().save(capture));
      dictionary->setProperty("expandedIDs", expanded);
    }
    auto legacy = newer;
    auto legacyPreferences = legacy["preferences"].toObject();
    legacyPreferences.remove("dictionary");
    legacy["preferences"] = legacyPreferences;
    QVERIFY(QMetaObject::invokeMethod(page, "load", Q_ARG(QVariant, legacy.toVariantMap())));
    QCOMPARE(dictionary->property("wordCount").toInt(), 0);
    QVERIFY(QMetaObject::invokeMethod(dictionary, "addList"));
    QCOMPARE(dictionary->property("lists").value<QJSValue>().toVariant().toList().size(), 1);
    QVERIFY(page->property("dirty").toBool());
    QCOMPARE(warnings.count(), 0);
  }
  void connectionSetupMasksSecretsAndRequiresVerifiedSave() {
    QTemporaryDir directory;
    qputenv("XDG_RUNTIME_DIR", directory.path().toUtf8());
    QVERIFY(QDir().mkpath(directory.path() + "/sottoduo-client"));
    QLocalServer server;
    QVERIFY(server.listen(directory.path() + "/sottoduo-client/control.sock"));
    QStringList actions;
    connect(&server, &QLocalServer::newConnection, &server, [&] {
      auto *socket = server.nextPendingConnection();
      connect(socket, &QLocalSocket::readyRead, socket, [&, socket] {
        if (!socket->canReadLine())
          return;
        const auto request =
            QJsonDocument::fromJson(socket->readLine()).object();
        const auto action = request["action"].toString();
        actions << action;
        QJsonObject data{{"version", 1}, {"setupRequired", true}};
        if (action == "testConnection") {
          QCOMPARE(request["accessToken"].toString(), "test-secret");
          data = {{"ticket", "verified"},
                  {"hosts", QJsonArray{"desktop"}},
                  {"hostID", "desktop"},
                  {"message", "Connected. Save to use it."}};
        }
        socket->write(QJsonDocument(QJsonObject{{"ok", true}, {"data", data}})
                          .toJson(QJsonDocument::Compact) +
                      '\n');
      });
    });
    Bridge bridge(false);
    QTRY_VERIFY(bridge.connected());
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false}, {"supported", false}, {"trigger", ""}, {"message", ""}});
    QSignalSpy warnings(&engine, &QQmlEngine::warnings);
    engine.load(QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/Main.qml"));
    QVERIFY(!engine.rootObjects().isEmpty());
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    QVERIFY(window);
    window->setProperty("page", 4);
    QTest::qWait(50);
    auto *settings = window->findChild<QQuickItem *>("connectionSettings");
    auto *address = window->findChild<QQuickItem *>("connectionServer");
    auto *token = window->findChild<QQuickItem *>("connectionToken");
    auto *check = window->findChild<QQuickItem *>("testConnectionButton");
    auto *save = window->findChild<QQuickItem *>("saveConnectionButton");
    QVERIFY(settings && address && token && check && save);
    QVERIFY(token->property("text").toString().isEmpty());
    QVERIFY(!save->isEnabled());
    address->setProperty("text", "https://speech.example.com");
    token->setProperty("text", "test-secret");
    QVERIFY(!token->property("displayText").toString().contains("test-secret"));
    QVERIFY(check->isEnabled());
    QVERIFY(QMetaObject::invokeMethod(check, "clicked"));
    QVERIFY(token->property("text").toString().isEmpty());
    QTRY_VERIFY(save->isEnabled());
    QVERIFY(!actions.contains("test"));
    window->setProperty("snapshot", QVariantMap{{"busy", true}});
    QVERIFY(!save->isEnabled());
    window->setProperty("snapshot", QVariantMap{{"busy", false}});
    QVERIFY(save->isEnabled());
    QVERIFY(QMetaObject::invokeMethod(address, "textEdited"));
    QVERIFY(!save->isEnabled());
    token->setProperty("text", "another-secret");
    window->hide();
    QVERIFY(token->property("text").toString().isEmpty());
    QCOMPARE(warnings.count(), 0);
  }
  void connectionIgnoresRepliesFromEarlierChecks() {
    Bridge bridge(true);
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false},
                                         {"supported", false},
                                         {"trigger", ""},
                                         {"message", ""}});
    QSignalSpy warnings(&engine, &QQmlEngine::warnings);
    engine.load(QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/Main.qml"));
    QVERIFY(!engine.rootObjects().isEmpty());
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    QVERIFY(window);
    window->setProperty("page", 4);
    QTRY_VERIFY(window->findChild<QQuickItem *>("connectionSettings"));
    auto *settings = window->findChild<QQuickItem *>("connectionSettings");
    settings->setProperty("pending", true);
    settings->setProperty("activeRequestID", "new-check");
    const QVariantMap older{{"ticket", "old-ticket"}, {"hosts", QStringList{"old"}}};
    emit bridge.reply("testConnection", older, "old-check");
    QVERIFY(settings->property("pending").toBool());
    QVERIFY(settings->property("ticket").toString().isEmpty());
    const QVariantMap newer{{"ticket", "new-ticket"},
                            {"hosts", QStringList{"new"}},
                            {"hostID", "new"},
                            {"message", "Connected"}};
    emit bridge.reply("testConnection", newer, "new-check");
    QCOMPARE(settings->property("ticket").toString(), "new-ticket");
    QVERIFY(!settings->property("pending").toBool());
    QCOMPARE(warnings.count(), 0);
  }
  void takeActionsSitBesideTheHeadline() {
    Bridge bridge(true);
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false}, {"supported", false}, {"trigger", ""}, {"message", ""}});
    QSignalSpy warnings(&engine, &QQmlEngine::warnings);
    engine.load(QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/Main.qml"));
    QVERIFY(!engine.rootObjects().isEmpty());
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    QVERIFY(window);
    auto item = [window](const char *name) {
      return window->findChild<QQuickItem *>(name);
    };
    auto *start = item("startDictationButton");
    auto *finish = item("finishDictationButton");
    auto *cancel = item("cancelDictationButton");
    auto *undo = item("undoDictationButton");
    auto *headline = item("dictationHeadline");
    auto *fallback = item("recognitionFallback");
    QVERIFY(start && finish && cancel && undo && headline && fallback);
    // Start waits for the server to report ready.
    QTRY_VERIFY(start->isVisible() && start->isEnabled());
    QVERIFY(!finish->isVisible() && !cancel->isVisible() && !undo->isVisible());
    QSignalSpy failed(&bridge, &Bridge::failed);
    QVERIFY(QMetaObject::invokeMethod(start, "clicked"));
    QTRY_COMPARE(failed.count(), 1);
    QCOMPARE(failed.first().at(0).toString(), "start");

    QVariantMap activity{{"phase", "recording"},
                         {"trigger", "shortcut"},
                         {"cloudUnavailable", true}};
    window->setProperty("snapshot",
                        QVariantMap{{"busy", true}, {"activity", activity}});
    QVERIFY(!start->isVisible());
    QVERIFY(finish->isVisible() && cancel->isVisible());
    QVERIFY(fallback->isVisible());
    QCOMPARE(window->property("trayStatus").toString(), "Listening · 0:00");
    QVERIFY(QMetaObject::invokeMethod(finish, "clicked"));
    QTRY_COMPARE(failed.count(), 2);
    QCOMPARE(failed.last().at(0).toString(), "stop");

    // A pairing-button take ends on the button, so only Cancel is offered.
    activity["trigger"] = "pairing";
    window->setProperty("snapshot",
                        QVariantMap{{"busy", true}, {"activity", activity}});
    QVERIFY(!finish->isVisible() && cancel->isVisible());

    activity["undoUntil"] = double(QDateTime::currentMSecsSinceEpoch()) + 3500;
    window->setProperty("snapshot",
                        QVariantMap{{"busy", true}, {"activity", activity}});
    QCOMPARE(headline->property("text").toString(), "Not pasted");
    QVERIFY(item("undoNote")->isVisible());
    QVERIFY(undo->isVisible());
    QVERIFY(!cancel->isVisible() && !fallback->isVisible());
    QCOMPARE(undo->property("text").toString(), "Undo 4s");
    QCOMPARE(window->property("trayStatus").toString(),
             "Not pasted · saved to history");
    // The countdown steps once per second and the button hides when it ends.
    QTRY_COMPARE_WITH_TIMEOUT(undo->property("text").toString(),
                              QString("Undo 3s"), 2000);
    QVERIFY(QMetaObject::invokeMethod(undo, "clicked"));
    QTRY_COMPARE(failed.count(), 3);
    QCOMPARE(failed.last().at(0).toString(), "undo");
    QTRY_VERIFY_WITH_TIMEOUT(!undo->isVisible(), 5000);
    QCOMPARE(warnings.count(), 0);
  }
  void activeMicrophoneTestCanFinishWhenServerIsBusy() {
    Bridge bridge(true);
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("bridge", &bridge);
    engine.rootContext()->setContextProperty(
        "portalShortcuts", QVariantMap{{"plasma", false}, {"supported", false}, {"trigger", ""}, {"message", ""}});
    engine.load(QUrl::fromLocalFile(QString(SOTTODUO_QML_DIR) + "/Main.qml"));
    QVERIFY(!engine.rootObjects().isEmpty());
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    QVERIFY(window);
    QTRY_VERIFY(window->property("serverReady").toBool());
    auto *button = window->findChild<QQuickItem *>("microphoneTestButton");
    auto *cancel = window->findChild<QQuickItem *>("cancelDictationButton");
    QVERIFY(button && button->isEnabled());
    QVERIFY(cancel);
    auto snapshot = [](const QString &phase, const QString &trigger) {
      return QVariantMap{
          {"busy", true},
          {"activity", QVariantMap{{"phase", phase}, {"trigger", trigger}}}};
    };
    window->setProperty("snapshot", snapshot("recording", "test"));
    QVERIFY(cancel->isVisible());
    emit bridge.reply(
        "connection",
        QVariantMap{{"ready", false},
                    {"message", "Server is handling a recording."}});
    QVERIFY(!window->property("serverReady").toBool());
    QCOMPARE(window->property("connection").toString(),
             "Server is handling a recording.");
    QVERIFY(button->isEnabled());
    QCOMPARE(button->property("text").toString(), "Finish test");
    QSignalSpy failed(&bridge, &Bridge::failed);
    // The button's text changed; click its settled screen geometry.
    QTest::qWait(50);
    const auto center =
        button->mapToScene(QPointF(button->width() / 2, button->height() / 2));
    QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, center.toPoint());
    QTRY_COMPARE(failed.count(), 1);
    // Preview refuses mutations, but the actual click must issue stop, not
    // start.
    QCOMPARE(failed.first().at(0).toString(), "stop");
    window->setProperty("snapshot", snapshot("processing", "test"));
    QVERIFY(cancel->isVisible());
    QVERIFY(!button->isEnabled());
    QCOMPARE(button->property("text").toString(), "Transcribing…");
    window->setProperty("snapshot", snapshot("recording", "shortcut"));
    QVERIFY(!button->isEnabled());
    QCOMPARE(button->property("text").toString(), "Test microphone");
    window->setProperty("snapshot", snapshot("delivering", "shortcut"));
    QVERIFY(!cancel->isVisible());
    window->setProperty("snapshot", snapshot("completed", "shortcut"));
    QVERIFY(!cancel->isVisible());
    window->setProperty(
        "snapshot",
        QVariantMap{{"busy", false},
                    {"activity", QVariantMap{{"phase", "completed"}}}});
    QTRY_VERIFY(window->property("serverReady").toBool());
    QVERIFY(button->isEnabled());
    emit bridge.reply(
        "connection",
        QVariantMap{{"ready", false},
                    {"message", "Server models are unavailable."}});
    QVERIFY(!button->isEnabled());
    QCOMPARE(window->property("connection").toString(),
             "Server models are unavailable.");
  }
};
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
  BridgeTest test;
  return QTest::qExec(&test, argc, argv);
}
#include "BridgeTest.moc"
