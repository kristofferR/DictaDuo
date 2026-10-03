#ifdef DICTADUO_HAS_LIBPORTAL
#include <libportal/portal.h>
#endif
#include "PortalShortcuts.h"
#include <QMetaObject>
#include <QStringList>
#include <QTimer>

PortalShortcuts::PortalShortcuts(bool enabled, QObject *parent) : QObject(parent) {
  const QString desktops = qEnvironmentVariable("XDG_CURRENT_DESKTOP") + ':' +
                           qEnvironmentVariable("XDG_SESSION_DESKTOP") + ':' +
                           qEnvironmentVariable("DESKTOP_SESSION");
  const QStringList names = desktops.split(':', Qt::SkipEmptyParts);
  m_plasma = enabled && qEnvironmentVariable("XDG_SESSION_TYPE") == "wayland" &&
             (names.contains("KDE", Qt::CaseInsensitive) ||
              names.contains("plasma", Qt::CaseInsensitive));
  if (!m_plasma)
    return;
#ifdef DICTADUO_HAS_LIBPORTAL
  m_supported = true;
  m_message = "Checking Plasma shortcuts…";
  m_thread = std::thread([this] { run(); });
#else
  m_message = "Install libportal to use Plasma global shortcuts.";
#endif
}

PortalShortcuts::~PortalShortcuts() {
#ifdef DICTADUO_HAS_LIBPORTAL
  if (m_thread.joinable()) {
    std::unique_lock lock(m_mutex);
    m_ready.wait(lock, [this] { return m_context != nullptr; });
    auto *context = static_cast<GMainContext *>(m_context);
    lock.unlock();
    g_main_context_invoke(
        context,
        [](gpointer data) -> gboolean {
          auto *self = static_cast<PortalShortcuts *>(data);
          g_main_loop_quit(static_cast<GMainLoop *>(self->m_loop));
          return G_SOURCE_REMOVE;
        },
        this);
    m_thread.join();
  }
#endif
}

void PortalShortcuts::setStatus(bool available, const QString &trigger,
                                const QString &message) {
  QMetaObject::invokeMethod(
      this,
      [this, available, trigger, message] {
        m_available = available;
        m_trigger = trigger;
        m_message = message;
        emit changed();
      },
      Qt::QueuedConnection);
}

void PortalShortcuts::configure() {
#ifdef DICTADUO_HAS_LIBPORTAL
  if (!m_plasma)
    return;
  std::lock_guard lock(m_mutex);
  if (!m_context)
    return;
  g_main_context_invoke(
      static_cast<GMainContext *>(m_context),
      [](gpointer data) -> gboolean {
        auto *self = static_cast<PortalShortcuts *>(data);
        if (!self->m_session)
          return G_SOURCE_REMOVE;
        xdp_global_shortcuts_session_configure_shortcuts(
            static_cast<XdpGlobalShortcutsSession *>(self->m_session), nullptr,
            nullptr, nullptr,
            [](GObject *, GAsyncResult *result, gpointer user) {
              static_cast<PortalShortcuts *>(user)->configured(result);
            },
            self);
        return G_SOURCE_REMOVE;
      },
      this);
#endif
}

void PortalShortcuts::run() {
#ifdef DICTADUO_HAS_LIBPORTAL
  auto *context = g_main_context_new();
  g_main_context_push_thread_default(context);
  auto *loop = g_main_loop_new(context, FALSE);
  {
    std::lock_guard lock(m_mutex);
    m_context = context;
    m_loop = loop;
  }
  m_ready.notify_all();
  auto *portal = xdp_portal_new();
  m_portal = portal;
  xdp_portal_create_global_shortcuts_session(
      portal, nullptr,
      [](GObject *source, GAsyncResult *result, gpointer user) {
        static_cast<PortalShortcuts *>(user)->created(source, result);
      },
      this);
  g_main_loop_run(loop);
  if (m_session)
    xdp_global_shortcuts_session_close(
        static_cast<XdpGlobalShortcutsSession *>(m_session));
  if (m_shortcuts)
    g_ptr_array_unref(static_cast<GPtrArray *>(m_shortcuts));
  if (m_session)
    g_object_unref(static_cast<XdpGlobalShortcutsSession *>(m_session));
  g_object_unref(portal);
  g_main_loop_unref(loop);
  g_main_context_pop_thread_default(context);
  g_main_context_unref(context);
#endif
}

void PortalShortcuts::created(void *source, void *result) {
#ifdef DICTADUO_HAS_LIBPORTAL
  GError *error = nullptr;
  auto *session = xdp_portal_create_global_shortcuts_session_finish(
      XDP_PORTAL(source), static_cast<GAsyncResult *>(result), &error);
  if (!session) {
    g_clear_error(&error);
    setStatus(false, {}, "Plasma shortcuts are unavailable. Check the desktop portal and launch DictaDuo from its installed app entry.");
    return;
  }
  m_session = session;
  g_signal_connect(
      session, "activated",
      G_CALLBACK(+[](XdpGlobalShortcutsSession *, char *id, guint64, GVariant *,
                     gpointer user) {
        auto *self = static_cast<PortalShortcuts *>(user);
        if (g_strcmp0(id, "dictate") == 0)
          QMetaObject::invokeMethod(self, [self] { emit self->pressed(); },
                                    Qt::QueuedConnection);
        else if (g_strcmp0(id, "cancel") == 0 || g_strcmp0(id, "copy") == 0 ||
                 g_strcmp0(id, "undo") == 0)
          QMetaObject::invokeMethod(
              self, [self, name = QString::fromUtf8(id)] { emit self->action(name); },
              Qt::QueuedConnection);
      }),
      this);
  g_signal_connect(
      session, "deactivated",
      G_CALLBACK(+[](XdpGlobalShortcutsSession *, char *id, guint64, GVariant *,
                     gpointer user) {
        if (g_strcmp0(id, "dictate") == 0)
          QMetaObject::invokeMethod(static_cast<PortalShortcuts *>(user),
                                    [self = static_cast<PortalShortcuts *>(user)] {
                                      emit self->released();
                                    },
                                    Qt::QueuedConnection);
      }),
      this);
  g_signal_connect(
      session, "shortcuts-changed",
      G_CALLBACK(+[](XdpGlobalShortcutsSession *changed, GPtrArray *,
                     gpointer user) {
        xdp_global_shortcuts_session_list_shortcuts(
            changed, nullptr,
            [](GObject *, GAsyncResult *reply, gpointer data) {
              static_cast<PortalShortcuts *>(data)->listed(reply);
            },
            user);
      }),
      this);
  auto *shortcuts = g_ptr_array_new_with_free_func(
      reinterpret_cast<GDestroyNotify>(xdp_global_shortcut_free));
  g_ptr_array_add(shortcuts, xdp_global_shortcut_new(
                                  "dictate", "Hold to dictate with DictaDuo", "F8"));
  g_ptr_array_add(shortcuts, xdp_global_shortcut_new(
                                  "cancel", "Cancel DictaDuo dictation", ""));
  g_ptr_array_add(shortcuts, xdp_global_shortcut_new(
                                  "copy", "Copy the last DictaDuo dictation", ""));
  g_ptr_array_add(shortcuts, xdp_global_shortcut_new(
                                  "undo", "Paste a cancelled DictaDuo dictation", ""));
  m_shortcuts = shortcuts;
  xdp_global_shortcuts_session_bind_shortcuts(
      session, shortcuts, nullptr, nullptr,
      [](GObject *, GAsyncResult *reply, gpointer user) {
        static_cast<PortalShortcuts *>(user)->bound(reply);
      },
      this);
#else
  (void)source;
  (void)result;
#endif
}

void PortalShortcuts::updateAssignments(void *value) {
#ifdef DICTADUO_HAS_LIBPORTAL
  auto *assignments = static_cast<GPtrArray *>(value);
  QString trigger;
  for (guint i = 0; assignments && i < assignments->len; ++i) {
    auto *item = static_cast<XdpGlobalShortcutAssigned *>(
        g_ptr_array_index(assignments, i));
    if (g_strcmp0(xdp_global_shortcut_assigned_get_shortcut_id(item),
                  "dictate") == 0)
      trigger = QString::fromUtf8(
          xdp_global_shortcut_assigned_get_trigger_description(item));
  }
  setStatus(!trigger.isEmpty(), trigger,
            trigger.isEmpty() ? "Choose a hold key in Plasma's shortcut dialog."
                              : "Hold to dictate; release to transcribe.");
#else
  (void)value;
#endif
}

void PortalShortcuts::bound(void *result) {
#ifdef DICTADUO_HAS_LIBPORTAL
  GError *error = nullptr;
  auto *assignments = xdp_global_shortcuts_session_bind_shortcuts_finish(
      static_cast<XdpGlobalShortcutsSession *>(m_session),
      static_cast<GAsyncResult *>(result), &error);
  if (!assignments) {
    g_clear_error(&error);
    setStatus(false, {}, "Plasma did not grant DictaDuo a global shortcut.");
    return;
  }
  updateAssignments(assignments);
  g_ptr_array_unref(assignments);
#else
  (void)result;
#endif
}

void PortalShortcuts::listed(void *result) {
#ifdef DICTADUO_HAS_LIBPORTAL
  GError *error = nullptr;
  auto *assignments = xdp_global_shortcuts_session_list_shortcuts_finish(
      static_cast<XdpGlobalShortcutsSession *>(m_session),
      static_cast<GAsyncResult *>(result), &error);
  if (assignments) {
    updateAssignments(assignments);
    g_ptr_array_unref(assignments);
  } else {
    g_clear_error(&error);
    setStatus(false, {}, "Couldn’t read Plasma’s current DictaDuo shortcut.");
  }
#else
  (void)result;
#endif
}

void PortalShortcuts::configured(void *result) {
#ifdef DICTADUO_HAS_LIBPORTAL
  GError *error = nullptr;
  if (!xdp_global_shortcuts_session_configure_shortcuts_finish(
          static_cast<XdpGlobalShortcutsSession *>(m_session),
          static_cast<GAsyncResult *>(result), &error)) {
    g_clear_error(&error);
    QMetaObject::invokeMethod(
        this,
        [this] {
          m_message = "Plasma shortcut configuration was cancelled or unavailable.";
          emit changed();
        },
        Qt::QueuedConnection);
  }
#else
  (void)result;
#endif
}
