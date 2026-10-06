/* Keyboard-only RemoteDesktop session for compositors without virtual-keyboard.
 * Permission is requested explicitly; restore tokens never appear in IPC/logs. */
#define _GNU_SOURCE
#include <gio/gio.h>
#include <glib-unix.h>
#include <json-glib/json-glib.h>
#include <xkbcommon/xkbcommon.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <unistd.h>
static const char *service = "org.freedesktop.portal.Desktop";
static const char *path = "/org/freedesktop/portal/desktop";
static const char *interface = "org.freedesktop.portal.RemoteDesktop";
static GDBusConnection *bus;
static gchar *session, *request_path, *token_path;
static GVariant *response;
static gboolean responded, denied;
static volatile sig_atomic_t stopping;
static GMainLoop *loop;
static guint pending_keys;
static gboolean keys_ok;
static void reply(const char *value) { puts(value); fflush(stdout); }
static void stop(int signal) { (void)signal; stopping = 1; }
static void session_closed(GDBusConnection *connection, const gchar *sender, const gchar *object,
                           const gchar *iface, const gchar *name, GVariant *parameters, gpointer data) {
  (void)connection; (void)sender; (void)iface; (void)name; (void)parameters; (void)data;
  if (!g_strcmp0(object, session)) stopping = 1;
}
static void response_signal(GDBusConnection *connection, const gchar *sender, const gchar *object,
                            const gchar *iface, const gchar *name, GVariant *parameters, gpointer data) {
  (void)connection; (void)sender; (void)iface; (void)name; (void)data;
  if (g_strcmp0(object, request_path)) return;
  guint code; GVariant *results; g_variant_get(parameters, "(u@a{sv})", &code, &results);
  responded = TRUE; denied = code != 0; response = results;
}
static GVariant *request(const char *method, GVariant *arguments) {
  responded = denied = FALSE; g_clear_pointer(&response, g_variant_unref);
  GVariant *result = g_dbus_connection_call_sync(bus, service, path, interface, method, arguments,
    G_VARIANT_TYPE("(o)"), G_DBUS_CALL_FLAGS_NONE, 2000, NULL, NULL);
  if (!result) return NULL;
  const char *handle; g_variant_get(result, "(&o)", &handle); g_free(request_path); request_path = g_strdup(handle); g_variant_unref(result);
  gint64 deadline = g_get_monotonic_time() + 120000000;
  while (!responded && !stopping && g_get_monotonic_time() < deadline) {
    while (g_main_context_pending(NULL)) g_main_context_iteration(NULL, FALSE);
    g_usleep(1000);
  }
  if (!responded && request_path) {
    g_dbus_connection_call_sync(bus, service, request_path, "org.freedesktop.portal.Request", "Close", NULL, NULL, G_DBUS_CALL_FLAGS_NONE, 500, NULL, NULL);
  }
  return responded && !denied && !stopping ? response : NULL;
}
static gchar *token(void) {
  int fd = open(token_path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW); if (fd < 0) return NULL;
  struct stat info = {0}; gchar data[4097] = {0};
  gboolean private = !fstat(fd, &info) && S_ISREG(info.st_mode) && info.st_uid == getuid() && !(info.st_mode & 077) && info.st_size > 0 && info.st_size <= 4096;
  ssize_t n = private ? read(fd, data, sizeof(data) - 1) : -1; close(fd);
  return n == info.st_size && n > 0 && g_utf8_validate(data, n, NULL) ? g_strndup(data, n) : NULL;
}
static gboolean authorize(gboolean restore) {
  gchar *saved = restore ? token() : NULL; if (restore && !saved) return FALSE;
  GVariantBuilder options; g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
  GVariant *result = request("CreateSession", g_variant_new("(a{sv})", &options));
  const char *handle = NULL;
  if (!result || !g_variant_lookup(result, "session_handle", "&o", &handle)) { g_free(saved); return FALSE; }
  session = g_strdup(handle);
  g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&options, "{sv}", "types", g_variant_new_uint32(1));
  g_variant_builder_add(&options, "{sv}", "persist_mode", g_variant_new_uint32(2));
  if (saved) g_variant_builder_add(&options, "{sv}", "restore_token", g_variant_new_string(saved));
  result = request("SelectDevices", g_variant_new("(oa{sv})", session, &options)); g_free(saved);
  if (!result) return FALSE;
  g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
  result = request("Start", g_variant_new("(osa{sv})", session, "", &options));
  guint devices = 0;
  if (!result || !g_variant_lookup(result, "devices", "u", &devices) || !(devices & 1)) return FALSE;
  const char *next = NULL;
  if (g_variant_lookup(result, "restore_token", "&s", &next)) {
    gchar *directory = g_path_get_dirname(token_path);
    if (!g_mkdir_with_parents(directory, 0700))
      g_file_set_contents_full(token_path, next, -1, G_FILE_SET_CONTENTS_CONSISTENT | G_FILE_SET_CONTENTS_DURABLE, 0600, NULL);
    g_free(directory);
  }
  return TRUE;
}
static void key_complete(GObject *object, GAsyncResult *result, gpointer data) {
  (void)data; GVariant *reply = g_dbus_connection_call_finish(G_DBUS_CONNECTION(object), result, NULL);
  if (!reply) keys_ok = FALSE; else g_variant_unref(reply);
  pending_keys--;
}
static void key(guint keysym, guint state) {
  GVariantBuilder options; g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT); pending_keys++;
  g_dbus_connection_call(bus, service, path, interface, "NotifyKeyboardKeysym",
    g_variant_new("(oa{sv}iu)", session, &options, (gint)keysym, state), NULL,
    G_DBUS_CALL_FLAGS_NONE, 1000, NULL, key_complete, NULL);
}
static gboolean drain_keys(void) {
  gint64 deadline = g_get_monotonic_time() + 1500000;
  while (pending_keys && g_get_monotonic_time() < deadline) {
    while (g_main_context_pending(NULL)) g_main_context_iteration(NULL, FALSE);
    g_usleep(1000);
  }
  return !pending_keys && keys_ok;
}
static gboolean input(GIOChannel *channel, GIOCondition condition, gpointer data) {
  (void)data; gchar *line = NULL; gsize length;
  if (!(condition & G_IO_IN)) { g_main_loop_quit(loop); return G_SOURCE_REMOVE; }
  GIOStatus status = g_io_channel_read_line(channel, &line, &length, NULL, NULL);
  if (status == G_IO_STATUS_AGAIN) return G_SOURCE_CONTINUE;
  if (status != G_IO_STATUS_NORMAL) { g_free(line); g_main_loop_quit(loop); return G_SOURCE_REMOVE; }
  JsonParser *parser = json_parser_new(); gboolean valid = length <= 4096 && json_parser_load_from_data(parser, line, length, NULL);
  JsonNode *root = valid ? json_parser_get_root(parser) : NULL;
  JsonObject *object = root && JSON_NODE_HOLDS_OBJECT(root) ? json_node_get_object(root) : NULL;
  JsonNode *value = object ? json_object_get_member(object, "text") : NULL;
  const gchar *text = value && JSON_NODE_HOLDS_VALUE(value) && json_node_get_value_type(value) == G_TYPE_STRING ? json_node_get_string(value) : NULL;
  JsonNode *paste_node = object ? json_object_get_member(object, "paste") : NULL;
  gboolean paste = paste_node && JSON_NODE_HOLDS_VALUE(paste_node) && json_node_get_value_type(paste_node) == G_TYPE_BOOLEAN && json_node_get_boolean(paste_node);
  valid = paste || (text && *text && g_utf8_validate(text, -1, NULL) && g_utf8_strlen(text, -1) <= 16);
  if (valid && !paste) for (const gchar *p = text; *p; p = g_utf8_next_char(p))
    if (g_utf8_get_char(p) < 32 || g_utf8_get_char(p) == 127) valid = FALSE;
  keys_ok = TRUE;
  if (valid && !stopping) {
    if (paste) {
      // Queue the complete chord without yielding while Control is down.
      key(0xffe3, 1); key('v', 1); key('v', 0); key(0xffe3, 0);
      valid = drain_keys();
    } else for (const gchar *p = text; *p && valid && !stopping; p = g_utf8_next_char(p)) {
      guint symbol = xkb_utf32_to_keysym(g_utf8_get_char(p)); key(symbol, 1); key(symbol, 0); valid = drain_keys();
    }
    reply(valid && !stopping ? "sent" : "uncertain");
  } else reply("unavailable");
  g_object_unref(parser); g_free(line); return G_SOURCE_CONTINUE;
}
static gboolean check_stop(gpointer data) { (void)data; if (stopping) { g_main_loop_quit(loop); return G_SOURCE_REMOVE; } return G_SOURCE_CONTINUE; }
int main(int argc, char **argv) {
  if (argc != 2 || (strcmp(argv[1], "--authorize") && strcmp(argv[1], "--restore"))) return 2;
  pid_t parent = getppid(); if (prctl(PR_SET_PDEATHSIG, SIGTERM) || getppid() != parent) return 1;
  signal(SIGTERM, stop); signal(SIGINT, stop); signal(SIGPIPE, SIG_IGN);
  bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, NULL); if (!bus) { reply("unavailable"); return 1; }
  token_path = g_build_filename(g_get_user_state_dir(), "dictaduo", "keyboard-portal-token", NULL);
  g_dbus_connection_signal_subscribe(bus, service, "org.freedesktop.portal.Request", "Response", NULL, NULL, G_DBUS_SIGNAL_FLAGS_NONE, response_signal, NULL, NULL);
  g_dbus_connection_signal_subscribe(bus, service, "org.freedesktop.portal.Session", "Closed", NULL, NULL, G_DBUS_SIGNAL_FLAGS_NONE, session_closed, NULL, NULL);
  if (!authorize(!strcmp(argv[1], "--restore"))) { reply("unavailable"); return 1; }
  loop = g_main_loop_new(NULL, FALSE); g_timeout_add(10, check_stop, NULL);
  GIOChannel *channel = g_io_channel_unix_new(STDIN_FILENO); g_io_channel_set_flags(channel, G_IO_FLAG_NONBLOCK, NULL);
  g_io_add_watch(channel, G_IO_IN | G_IO_HUP | G_IO_ERR, input, NULL);
  reply("ready"); g_main_loop_run(loop);
  if (session) g_dbus_connection_call_sync(bus, service, session, "org.freedesktop.portal.Session", "Close", NULL, NULL, G_DBUS_CALL_FLAGS_NONE, 500, NULL, NULL);
  g_object_unref(bus); return 0;
}
