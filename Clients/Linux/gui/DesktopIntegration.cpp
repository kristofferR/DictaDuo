#include "DesktopIntegration.h"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QProcess>
#include <QSaveFile>
#include <QStandardPaths>
#include <QTimer>
#include <functional>

namespace {
const QByteArray marker = "# Managed by DictaDuo\n";
const QByteArray serviceMarker = "# Managed by DictaDuo Linux GUI\n";

struct ServiceUnit {
  bool available = false;
  QString loadState;
  QString fragment;
};

struct ProcessResult {
  bool available = false;
  int exitCode = -1;
  QByteArray output;
};

void runSystemctl(QObject *owner, const QStringList &arguments,
                  std::function<void(ProcessResult)> done,
                  int timeoutMs = 2500) {
  auto *process = new QProcess(owner);
  auto complete = [process, done](ProcessResult result) {
    if (process->property("completed").toBool())
      return;
    process->setProperty("completed", true);
    done(result);
    process->deleteLater();
  };
  QObject::connect(process, &QProcess::errorOccurred, owner,
                   [complete](QProcess::ProcessError) { complete({}); });
  QObject::connect(process, &QProcess::finished, owner,
                   [process, complete](int code, QProcess::ExitStatus status) {
                     complete({status == QProcess::NormalExit, code,
                               process->readAllStandardOutput()});
                   });
  QTimer::singleShot(timeoutMs, process, [process, complete] {
    process->kill();
    complete({});
  });
  process->start("systemctl", arguments);
}

void serviceUnit(QObject *owner, const QString &name,
                 std::function<void(ServiceUnit)> done) {
  runSystemctl(owner,
               {"--user", "show", "--property=LoadState",
                "--property=FragmentPath", name},
               [done](ProcessResult result) {
                 if (!result.available || result.exitCode != 0) {
                   done({});
                   return;
                 }
                 ServiceUnit unit;
                 unit.available = true;
                 for (const auto &line : result.output.split('\n')) {
                   if (line.startsWith("LoadState="))
                     unit.loadState = QString::fromUtf8(line.mid(10));
                   else if (line.startsWith("FragmentPath="))
                     unit.fragment = QString::fromUtf8(line.mid(13));
                 }
                 done(unit);
               });
}

QString quotedExecutable(QString path) {
  // Desktop Exec quoting, followed by the desktop-entry string escaping.
  path.replace('%', "%%");
  path.replace('\\', "\\\\");
  path.replace('"', "\\\"");
  path.replace('`', "\\`");
  path.replace('$', "\\$");
  path.replace('\\', "\\\\");
  return '"' + path + '"';
}
QString quotedServiceExecutable(QString path) {
  path.replace('%', "%%");
  path.replace('$', "$$");
  path.replace('\\', "\\\\");
  path.replace('"', "\\\"");
  return '"' + path + '"';
}
} // namespace

QString defaultClientExecutable(const QString &guiDirectory) {
  const QDir guiDir(guiDirectory);
  const QString besideGui = guiDir.filePath("dictaduo");
  if (QFileInfo(besideGui).isExecutable() || guiDir.dirName() != "linux-gui")
    return besideGui;
  const QString buildOutput = QDir::cleanPath(guiDir.filePath("../linux-client/dictaduo"));
  return QFileInfo(buildOutput).isExecutable() ? buildOutput : besideGui;
}

DesktopIntegration::DesktopIntegration(bool preview, QObject *parent,
                                       const QString &clientExecutable)
    : QObject(parent), m_preview(preview),
      m_clientExecutable(clientExecutable.isEmpty()
                             ? defaultClientExecutable(QCoreApplication::applicationDirPath())
                             : clientExecutable) {}

QString DesktopIntegration::entryPath() const {
  return QStandardPaths::writableLocation(
             QStandardPaths::GenericConfigLocation) +
         "/autostart/org.dictaduo.Gui.desktop";
}

QString DesktopIntegration::servicePath() const {
  return QStandardPaths::writableLocation(
             QStandardPaths::GenericConfigLocation) +
         "/systemd/user/dictaduo-client.service";
}

void DesktopIntegration::refreshClientService() {
  if (m_preview || m_clientServiceBusy)
    return;
  const auto refresh = ++m_serviceRefresh;
  runSystemctl(this, {"--user", "is-active", "dictaduo-client.service"},
               [this, refresh](ProcessResult result) {
                 if (refresh != m_serviceRefresh || m_clientServiceBusy)
                   return;
                 if (!result.available) {
                   m_clientService = "Systemd user service unavailable";
                   emit changed();
                 } else if (result.exitCode == 0 &&
                            result.output.trimmed() == "active") {
                   m_clientService = "Running";
                   emit changed();
                 } else {
                   serviceUnit(this, "dictaduo-client.service",
                               [this, refresh](ServiceUnit unit) {
                     if (refresh != m_serviceRefresh || m_clientServiceBusy)
                       return;
                     m_clientService =
                         !unit.available ? "Systemd user service unavailable"
                         : unit.loadState == "not-found" ? "Not installed"
                                                         : "Stopped";
                     emit changed();
                   });
                 }
               });
}

void DesktopIntegration::setUpClientService() {
  configureClientService(false);
}

void DesktopIntegration::restartClientService() {
  configureClientService(true);
}

void DesktopIntegration::configureClientService(bool restartRunning) {
  if (m_preview || m_clientServiceBusy)
    return;
  ++m_serviceRefresh;
  m_clientServiceBusy = true;
  m_clientService = "Starting…";
  m_error.clear();
  emit changed();
  auto fail = [this](const QString &message) {
    m_error = message;
    m_clientServiceBusy = false;
    emit changed();
    refreshClientService();
  };
  serviceUnit(this, "dictaduo-client.service",
              [this, fail, restartRunning](ServiceUnit loaded) {
    const QString path = servicePath();
    QFileInfo unit(path);
    if (!loaded.available) {
      fail("Couldn’t inspect the background service. Check your user service "
           "manager.");
      return;
    }
    if (loaded.loadState != "not-found" &&
        (loaded.fragment.isEmpty() ||
         QFileInfo(loaded.fragment).absoluteFilePath() !=
             unit.absoluteFilePath())) {
      fail("An existing background service is managed outside DictaDuo. Update it "
           "through your desktop setup.");
      return;
    }
    bool created = false;
    const bool updated = unit.exists();
    if (unit.isSymLink()) {
      fail("The background service is a symlink. Manage it through your "
           "desktop setup.");
      return;
    }
    {
      QFile existing(path);
      QByteArray previous;
      if (unit.exists()) {
        if (!existing.open(QIODevice::ReadOnly) ||
            !(previous = existing.readAll()).startsWith(serviceMarker)) {
          fail("An existing background service is managed outside DictaDuo. "
               "Update it through your desktop setup.");
          return;
        }
      }
      const QFileInfo executable(m_clientExecutable);
      if (!executable.isFile() || !executable.isExecutable() ||
          m_clientExecutable.contains(QChar('\n')) ||
          m_clientExecutable.contains(QChar('\r'))) {
        fail("Install the DictaDuo background client beside this GUI, then try "
             "again.");
        return;
      }
      const QByteArray data =
          serviceMarker +
          ("[Unit]\nDescription=DictaDuo desktop dictation client\n"
           "PartOf=graphical-session.target\nAfter=graphical-session.target\n\n"
           "[Service]\nType=simple\nExecStart=" +
           quotedServiceExecutable(executable.absoluteFilePath()) +
           " daemon\nRestart=on-failure\nRestartSec=3\nUMask=0077\n"
           "NoNewPrivileges=yes\n\n[Install]\n"
           "WantedBy=graphical-session.target\n")
              .toUtf8();
      if (previous != data) {
        if (!QDir().mkpath(unit.absolutePath())) {
          fail("Couldn’t create the background-service folder.");
          return;
        }
        QSaveFile output(path);
        if (!output.open(QIODevice::WriteOnly) ||
            output.write(data) != data.size() || !output.commit()) {
          fail("Couldn’t install the background service. Check the folder "
               "permissions.");
          return;
        }
        created = true;
      }
    }
    auto complete = [this, fail](ProcessResult result) {
      if (!result.available || result.exitCode != 0) {
        fail("Couldn’t start background dictation. Check your user service "
             "status.");
        return;
      }
      m_clientServiceBusy = false;
      refreshClientService();
    };
    auto enable = [this, complete, updated, created, restartRunning] {
      runSystemctl(
          this, {"--user", "enable", "--now", "dictaduo-client.service"},
          [this, complete, updated, created, restartRunning](ProcessResult result) {
            if (result.available && result.exitCode == 0 &&
                (restartRunning || (created && updated))) {
              runSystemctl(this, {"--user", "restart", "dictaduo-client.service"},
                           complete, 10000);
            } else {
              complete(result);
            }
          },
          10000);
    };
    if (created)
      runSystemctl(
          this, {"--user", "daemon-reload"},
          [enable, complete](ProcessResult result) {
            if (result.available && result.exitCode == 0)
              enable();
            else
              complete(result);
          },
          10000);
    else
      enable();
  });
}

bool DesktopIntegration::launchAtLogin() const {
  if (m_preview)
    return false;
  QFile entry(entryPath());
  if (!entry.open(QIODevice::ReadOnly))
    return false;
  const auto data = entry.readAll();
  return data.startsWith(marker) && data.contains("\nHidden=false\n");
}

void DesktopIntegration::setLaunchAtLogin(bool enabled) {
  m_error.clear();
  auto fail = [this](const QString &message) {
    m_error = message;
    emit changed();
  };
  if (m_preview) {
    fail("Login startup cannot be changed in preview mode.");
    return;
  }
  QFile existing(entryPath());
  if (existing.exists() && (!existing.open(QIODevice::ReadOnly) ||
                            !existing.readAll().startsWith(marker))) {
    fail("An existing login entry is managed outside DictaDuo. Update it in your "
         "desktop’s startup settings.");
    return;
  }
  existing.close();

  // Preserve a launcher's stable symlink path across application updates.
  const QString argument = QCoreApplication::arguments().first();
  const QString executable = argument.contains('/')
                                 ? QFileInfo(argument).absoluteFilePath()
                                 : QStandardPaths::findExecutable(argument);
  if (enabled &&
      (executable.isEmpty() || executable.contains(QChar('\n')) ||
       executable.contains(QChar('\r')) || executable.contains(QChar('\t')) ||
       executable.contains('=') || !QFileInfo(executable).isExecutable())) {
    fail("Launch DictaDuo from its installed application before enabling login "
         "startup.");
    return;
  }
  const QByteArray data =
      marker + "[Desktop Entry]\n" +
      (enabled
           ? QByteArray(
                 "Type=Application\nName=DictaDuo\n"
                 "Comment=Keep dictation feedback available\nIcon=dictaduo\n"
                 "Terminal=false\nHidden=false\n") +
                 ("Exec=" + quotedExecutable(executable) + " --background\n")
                     .toUtf8()
           : QByteArray("Hidden=true\n"));
  if (!QDir().mkpath(QFileInfo(entryPath()).absolutePath())) {
    fail("Couldn’t create the login startup folder. Check its permissions.");
    return;
  }
  QSaveFile output(entryPath());
  if (!output.open(QIODevice::WriteOnly) || output.write(data) != data.size() ||
      !output.commit()) {
    fail("Couldn’t save login startup. Check the permissions of your startup "
         "folder.");
    return;
  }
  emit changed();
}
