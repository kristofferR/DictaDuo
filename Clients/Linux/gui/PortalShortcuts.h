#pragma once
#include <QObject>
#include <condition_variable>
#include <mutex>
#include <thread>

class PortalShortcuts : public QObject {
  Q_OBJECT
  Q_PROPERTY(bool plasma READ plasma CONSTANT)
  Q_PROPERTY(bool supported READ supported CONSTANT)
  Q_PROPERTY(bool available READ available NOTIFY changed)
  Q_PROPERTY(QString trigger READ trigger NOTIFY changed)
  Q_PROPERTY(QString message READ message NOTIFY changed)
public:
  explicit PortalShortcuts(bool enabled, QObject *parent = nullptr);
  ~PortalShortcuts() override;
  bool plasma() const { return m_plasma; }
  bool supported() const { return m_supported; }
  bool available() const { return m_available; }
  QString trigger() const { return m_trigger; }
  QString message() const { return m_message; }
  Q_INVOKABLE void configure();
signals:
  void changed();
  void pressed();
  void released();
  /** One-shot shortcuts: cancel the take, copy the last result, or paste a cancelled take. */
  void action(const QString &name);
private:
  void run();
  void created(void *source, void *result);
  void bound(void *result);
  void listed(void *result);
  void configured(void *result);
  void updateAssignments(void *assignments);
  void setStatus(bool available, const QString &trigger,
                 const QString &message);
  bool m_plasma = false;
  bool m_supported = false;
  bool m_available = false;
  QString m_trigger;
  QString m_message;
  std::thread m_thread;
  std::mutex m_mutex;
  std::condition_variable m_ready;
  void *m_context = nullptr;
  void *m_loop = nullptr;
  void *m_portal = nullptr;
  void *m_session = nullptr;
  void *m_shortcuts = nullptr;
};
