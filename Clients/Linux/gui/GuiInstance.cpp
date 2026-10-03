#include "GuiInstance.h"
#include <QDBusConnection>
#include <QDBusConnectionInterface>
#include <QDBusMessage>
#include <QDBusReply>

GuiInstance::~GuiInstance() {
  if (m_primary) {
    auto bus = QDBusConnection::sessionBus();
    bus.unregisterService("org.dictaduo.Gui");
    bus.unregisterObject("/DictaDuo");
  }
}

GuiInstance::Result GuiInstance::acquire(bool background) {
  auto bus = QDBusConnection::sessionBus();
  if (!bus.isConnected() ||
      !bus.registerObject("/DictaDuo", this,
                          QDBusConnection::ExportScriptableSlots)) {
    m_error = "Couldn’t connect DictaDuo to the desktop session bus.";
    return Result::Failed;
  }
  if (bus.registerService("org.dictaduo.Gui")) {
    m_primary = true;
    return Result::Primary;
  }
  const QDBusReply<bool> registered =
      bus.interface()->isServiceRegistered("org.dictaduo.Gui");
  if (!registered.isValid() || !registered.value()) {
    m_error = "Couldn’t register DictaDuo in this desktop session.";
    return Result::Failed;
  }
  if (!background) {
    const auto request = QDBusMessage::createMethodCall(
        "org.dictaduo.Gui", "/DictaDuo", "org.dictaduo.Gui", "Show");
    if (bus.call(request, QDBus::Block, 5000).type() ==
        QDBusMessage::ErrorMessage) {
      m_error =
          "DictaDuo is already running but didn’t respond. Try opening it again.";
      return Result::Failed;
    }
  }
  return Result::Forwarded;
}
