#include "../DesktopIntegration.h"
#include "../GuiInstance.h"
#include <QDBusConnection>
#include <QDBusConnectionInterface>
#include <QDBusReply>
#include <QDir>
#include <QFile>
#include <QProcess>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>

class DesktopTest : public QObject {
  Q_OBJECT
private slots:
  void buildTreeClientIsFoundBesideGuiBuild() {
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    const QString gui = directory.path() + "/build/linux-gui";
    const QString client = directory.path() + "/build/linux-client";
    QVERIFY(QDir().mkpath(gui));
    QVERIFY(QDir().mkpath(client));
    QFile builtClient(client + "/dictaduo");
    QVERIFY(builtClient.open(QIODevice::WriteOnly));
    builtClient.write("#!/bin/sh\n");
    builtClient.close();
    QVERIFY(builtClient.setPermissions(QFile::ReadOwner | QFile::WriteOwner |
                                       QFile::ExeOwner));
    QCOMPARE(defaultClientExecutable(gui), client + "/dictaduo");
    QFile installedClient(gui + "/dictaduo");
    QVERIFY(installedClient.open(QIODevice::WriteOnly));
    installedClient.write("#!/bin/sh\n");
    installedClient.close();
    QVERIFY(installedClient.setPermissions(
        QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner));
    QCOMPARE(defaultClientExecutable(gui), gui + "/dictaduo");
  }
  void loginEntryPersistsAndPreviewCannotChangeIt() {
    QTemporaryDir config;
    QVERIFY(config.isValid());
    qputenv("XDG_CONFIG_HOME", config.path().toUtf8());
    DesktopIntegration desktop(false);
    QVERIFY(!desktop.launchAtLogin());
    desktop.setLaunchAtLogin(true);
    QVERIFY2(desktop.error().isEmpty(), qPrintable(desktop.error()));
    QVERIFY(desktop.launchAtLogin());
    DesktopIntegration reopened(false);
    QVERIFY(reopened.launchAtLogin());
    QFile entry(config.path() + "/autostart/org.dictaduo.Gui.desktop");
    QVERIFY(entry.open(QIODevice::ReadOnly));
    const auto enabled = entry.readAll();
    entry.close();
    QVERIFY(enabled.contains(" --background\n"));
    DesktopIntegration preview(true);
    preview.setLaunchAtLogin(false);
    QVERIFY(!preview.error().isEmpty());
    QVERIFY(reopened.launchAtLogin());
    desktop.setLaunchAtLogin(false);
    QVERIFY(desktop.error().isEmpty());
    QVERIFY(!reopened.launchAtLogin());
    QVERIFY(entry.open(QIODevice::ReadOnly));
    QVERIFY(entry.readAll().contains("Hidden=true\n"));
  }
  void externalLoginEntryAndWriteFailuresRemainVisible() {
    QTemporaryDir config;
    qputenv("XDG_CONFIG_HOME", config.path().toUtf8());
    QVERIFY(QDir().mkpath(config.path() + "/autostart"));
    QFile entry(config.path() + "/autostart/org.dictaduo.Gui.desktop");
    QVERIFY(entry.open(QIODevice::WriteOnly));
    const QByteArray custom = "[Desktop Entry]\nExec=my-own-dictaduo-wrapper\n";
    QCOMPARE(entry.write(custom), custom.size());
    entry.close();
    DesktopIntegration desktop(false);
    desktop.setLaunchAtLogin(true);
    QVERIFY(!desktop.error().isEmpty());
    QVERIFY(!desktop.launchAtLogin());
    QVERIFY(entry.open(QIODevice::ReadOnly));
    QCOMPARE(entry.readAll(), custom);
    entry.close();
    QVERIFY(entry.remove());
    QVERIFY(QDir(config.path()).rmdir("autostart"));
    QFile obstruction(config.path() + "/autostart");
    QVERIFY(obstruction.open(QIODevice::WriteOnly));
    obstruction.close();
    desktop.setLaunchAtLogin(true);
    QVERIFY(!desktop.error().isEmpty());
    QVERIFY(!desktop.launchAtLogin());
  }
  void backgroundClientSetupInstallsAUserServiceAndStartsIt() {
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    const auto oldPath = qgetenv("PATH");
    const auto oldConfig = qgetenv("XDG_CONFIG_HOME");
    qputenv("XDG_CONFIG_HOME", directory.path().toUtf8());
    qputenv("PATH", directory.path().toUtf8() + ':' + oldPath);
    qputenv("DICTADUO_TEST_ACTIVE", (directory.path() + "/active").toUtf8());
    QFile fakeSystemctl(directory.path() + "/systemctl");
    QVERIFY(fakeSystemctl.open(QIODevice::WriteOnly));
    fakeSystemctl.write(
        "#!/bin/sh\ncase \"$2\" in\n"
        "is-active) test -f \"$DICTADUO_TEST_ACTIVE\" && echo active;;\n"
        "show) printf "
        "'LoadState=%s\\nFragmentPath=%s\\n' "
        "\"${DICTADUO_TEST_LOAD_STATE:-not-found}\" "
        "\"${DICTADUO_TEST_FRAGMENT:-}\";;\n"
        "daemon-reload) exit 0;;\n"
        "enable) case \" $* \" in *\" --now \"*) touch "
        "\"$DICTADUO_TEST_ACTIVE\";; esac;;\n"
        "restart) touch \"$DICTADUO_TEST_ACTIVE.restarted\";;\n"
        "start) touch \"$DICTADUO_TEST_ACTIVE\";;\n"
        "esac\n");
    fakeSystemctl.close();
    QVERIFY(fakeSystemctl.setPermissions(QFile::ReadOwner | QFile::WriteOwner |
                                         QFile::ExeOwner));
    QFile client(directory.path() + "/dictaduo");
    QVERIFY(client.open(QIODevice::WriteOnly));
    client.write("#!/bin/sh\nexit 0\n");
    client.close();
    QVERIFY(client.setPermissions(QFile::ReadOwner | QFile::WriteOwner |
                                  QFile::ExeOwner));
    DesktopIntegration desktop(false, nullptr, client.fileName());
    desktop.setUpClientService();
    QTRY_VERIFY_WITH_TIMEOUT(!desktop.clientServiceBusy(), 3000);
    QTRY_COMPARE_WITH_TIMEOUT(desktop.clientService(), "Running", 3000);
    desktop.restartClientService();
    QTRY_VERIFY_WITH_TIMEOUT(!desktop.clientServiceBusy(), 3000);
    QVERIFY(desktop.error().isEmpty());
    QVERIFY(QFile::exists(directory.path() + "/active.restarted"));
    QVERIFY(QFile::remove(directory.path() + "/active.restarted"));
    QFile unit(directory.path() + "/systemd/user/dictaduo-client.service");
    QVERIFY(unit.open(QIODevice::ReadOnly));
    const auto installed = unit.readAll();
    QVERIFY(installed.startsWith("# Managed by DictaDuo Linux GUI\n"));
    QVERIFY(installed.contains("ExecStart=\"" + client.fileName().toUtf8() +
                               "\" daemon\n"));
    QFile movedClient(directory.path() + "/moved-dictaduo");
    QVERIFY(movedClient.open(QIODevice::WriteOnly));
    movedClient.write("#!/bin/sh\nexit 0\n");
    movedClient.close();
    QVERIFY(movedClient.setPermissions(QFile::ReadOwner | QFile::WriteOwner |
                                       QFile::ExeOwner));
    DesktopIntegration moved(false, nullptr, movedClient.fileName());
    moved.setUpClientService();
    QTRY_VERIFY_WITH_TIMEOUT(!moved.clientServiceBusy(), 3000);
    QVERIFY(moved.error().isEmpty());
    QVERIFY(QFile::exists(directory.path() + "/active"));
    QVERIFY(QFile::exists(directory.path() + "/active.restarted"));
    unit.close();
    QVERIFY(unit.open(QIODevice::ReadOnly));
    QVERIFY(unit.readAll().contains(
        "ExecStart=\"" + movedClient.fileName().toUtf8() + "\" daemon\n"));
    unit.close();
    QVERIFY(unit.remove());
    QVERIFY(QFile::remove(directory.path() + "/active"));
    qputenv("DICTADUO_TEST_LOAD_STATE", "loaded");
    qputenv("DICTADUO_TEST_FRAGMENT",
            "/usr/lib/systemd/user/dictaduo-client.service");
    DesktopIntegration external(false, nullptr, client.fileName());
    external.setUpClientService();
    QTRY_VERIFY_WITH_TIMEOUT(!external.clientServiceBusy(), 3000);
    QVERIFY(!external.error().isEmpty());
    QVERIFY(!unit.exists());
    qunsetenv("DICTADUO_TEST_LOAD_STATE");
    qunsetenv("DICTADUO_TEST_FRAGMENT");
    qputenv("PATH", oldPath);
    qputenv("XDG_CONFIG_HOME", oldConfig);
    qunsetenv("DICTADUO_TEST_ACTIVE");
  }
  void repeatedLaunchForwardsOnlyExplicitOpen() {
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert("XDG_CONFIG_HOME", directory.path());
    env.insert("XDG_RUNTIME_DIR", directory.path());
    GuiInstance instance;
    QCOMPARE(instance.acquire(true), GuiInstance::Result::Primary);
    QSignalSpy shown(&instance, &GuiInstance::showRequested);
    QProcess background;
    background.setProcessEnvironment(env);
    background.start(QString(DICTADUO_GUI_EXECUTABLE), {"--background"});
    QVERIFY(background.waitForFinished(7000));
    QCOMPARE(background.exitCode(), 0);
    QCOMPARE(shown.count(), 0);
    QProcess foreground;
    foreground.setProcessEnvironment(env);
    foreground.start(QString(DICTADUO_GUI_EXECUTABLE));
    QTRY_COMPARE_WITH_TIMEOUT(shown.count(), 1, 7000);
    QTRY_COMPARE_WITH_TIMEOUT(foreground.state(), QProcess::NotRunning, 7000);
    QCOMPARE(foreground.exitCode(), 0);
  }
  void primaryBackgroundLaunchAndMissingBus() {
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert("QT_FORCE_STDERR_LOGGING", "1");
    env.insert("XDG_CONFIG_HOME", directory.path());
    env.insert("XDG_RUNTIME_DIR", directory.path());
    QProcess primary;
    primary.setProcessEnvironment(env);
    primary.start(QString(DICTADUO_GUI_EXECUTABLE), {"--background"});
    QVERIFY(primary.waitForStarted());
    auto registered = [] {
      return QDBusConnection::sessionBus()
          .interface()
          ->isServiceRegistered("org.dictaduo.Gui")
          .value();
    };
    QTRY_VERIFY_WITH_TIMEOUT(registered(), 5000);
    QTest::qWait(200);
    QCOMPARE(primary.state(), QProcess::Running);
    primary.terminate();
    QVERIFY(primary.waitForFinished());
    QTRY_VERIFY(!registered());
    QVERIFY(
        !primary.readAllStandardError().contains("failed to load component"));
    env.insert("DBUS_SESSION_BUS_ADDRESS",
               "unix:path=" + directory.path() + "/absent");
    QProcess missingBus;
    missingBus.setProcessEnvironment(env);
    missingBus.start(QString(DICTADUO_GUI_EXECUTABLE), {"--background"});
    QVERIFY(missingBus.waitForFinished());
    QCOMPARE(missingBus.exitCode(), 1);
    QVERIFY(missingBus.readAllStandardError().contains("desktop session bus"));
  }
};
QTEST_GUILESS_MAIN(DesktopTest)
#include "DesktopTest.moc"
