#pragma once
#include <QObject>

class GuiInstance : public QObject {
  Q_OBJECT
  Q_CLASSINFO("D-Bus Interface", "org.dictaduo.Gui")
public:
  enum class Result { Primary, Forwarded, Failed };
  explicit GuiInstance(QObject *parent = nullptr) : QObject(parent) {}
  ~GuiInstance() override;
  Result acquire(bool background);
  QString error() const { return m_error; }
public slots:
  Q_SCRIPTABLE void Show() { emit showRequested(); }
signals:
  void showRequested();

private:
  QString m_error;
  bool m_primary = false;
};
