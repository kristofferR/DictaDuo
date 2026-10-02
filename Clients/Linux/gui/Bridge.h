#pragma once
#include "DesktopIntegration.h"
#include <QObject>
#include <QPair>
#include <QQueue>
#include <QSet>
#include <QSettings>
#include <QTimer>
#include <QVariantMap>
#include <functional>

class Bridge : public QObject {
  Q_OBJECT
  Q_PROPERTY(QVariantMap snapshot READ snapshot NOTIFY snapshotChanged)
  Q_PROPERTY(bool connected READ connected NOTIFY snapshotChanged)
  Q_PROPERTY(
      QString connectionStatus READ connectionStatus NOTIFY snapshotChanged)
  Q_PROPERTY(bool preview READ preview CONSTANT)
  Q_PROPERTY(QString theme READ theme WRITE setTheme NOTIFY themeChanged)
  Q_PROPERTY(QVariantMap colors READ colors NOTIFY themeChanged)
  Q_PROPERTY(QString themeNote READ themeNote NOTIFY themeChanged)
  Q_PROPERTY(QObject *desktop READ desktop CONSTANT)
public:
  explicit Bridge(bool preview, QObject *parent = nullptr);
  QVariantMap snapshot() const { return m_snapshot; }
  bool connected() const { return m_connected; }
  QString connectionStatus() const;
  bool preview() const { return m_preview; }
  QString theme() const { return m_theme; }
  QVariantMap colors() const { return m_colors; }
  QString themeNote() const { return m_themeNote; }
  DesktopIntegration *desktop() { return &m_desktop; }
  void setTheme(const QString &theme);
  Q_INVOKABLE void request(const QString &action,
                           const QVariantMap &arguments = {},
                           const QString &requestID = {});
  void requestShortcutEdge(const QString &action);
  Q_INVOKABLE void copy(const QString &text);
  Q_INVOKABLE void previewPhase(const QString &phase);
  int previewStateCount() const;
  QString applyPreviewState(int index);
signals:
  void snapshotChanged();
  void themeChanged();
  void reply(const QString &action, const QVariant &data,
             const QString &requestID = {});
  void failed(const QString &action, const QString &message,
              const QString &requestID = {});

private:
  void disconnected();
  void updateColors();
  void receive(const QString &action, const QByteArray &bytes,
               const QString &requestID);
  void sendRequest(const QString &action, const QVariantMap &arguments,
                   const QString &requestID, std::function<void()> complete);
  void sendNextShortcutEdge();
  bool m_preview = false;
  DesktopIntegration m_desktop;
  bool m_connected = false;
  bool m_connectionChecked = false;
  bool m_hasConnected = false;
  QString m_theme;
  QString m_themeNote;
  QVariantMap m_snapshot;
  QVariantMap m_colors;
  QVariantMap m_fixture;
  QSet<QString> m_pending;
  /** Each edge keeps the monotonic time it fired, since sends are serialized. */
  QQueue<QPair<QString, double>> m_shortcutEdges;
  bool m_shortcutEdgeInFlight = false;
  QTimer m_poll;
  QTimer m_themePoll;
  QSettings m_settings;
};
