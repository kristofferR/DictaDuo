/* A private D-Bus portal: grant, deny, revoke and record keyboard calls without
 * operating the desktop. Responses are emitted immediately after method replies. */
#include <gio/gio.h>
#include <glib-unix.h>
#include <stdio.h>
#include <string.h>
static GDBusConnection *bus;
static GMainLoop *loop;
static GString *keys;
static gboolean deny, restored, closed;
static guint requests, types;
static const char *session = "/org/freedesktop/portal/desktop/session/test/session";
static void call(GDBusConnection *connection, const gchar *sender, const gchar *path,
                 const gchar *interface, const gchar *method, GVariant *parameters,
                 GDBusMethodInvocation *invocation, gpointer data) {
  (void)connection; (void)sender; (void)path; (void)interface; (void)data;
  if (!strcmp(method, "NotifyKeyboardKeysym")) {
    const char *handle; GVariant *options; gint symbol; guint state;
    g_variant_get(parameters, "(&o@a{sv}iu)", &handle, &options, &symbol, &state);
    if (keys->len) g_string_append_c(keys, ',');
    g_string_append_printf(keys, "[%d,%u]", symbol, state);
    g_variant_unref(options); g_dbus_method_invocation_return_value(invocation, NULL); return;
  }
  if (!strcmp(method, "Close")) { closed = TRUE; g_dbus_method_invocation_return_value(invocation, NULL); return; }
  if (!strcmp(method, "SelectDevices")) {
    GVariant *options = g_variant_get_child_value(parameters, 1); const char *token;
    restored = g_variant_lookup(options, "restore_token", "&s", &token);
    g_variant_lookup(options, "types", "u", &types); g_variant_unref(options);
  }
  gchar *request = g_strdup_printf("/org/freedesktop/portal/desktop/request/test/%u", ++requests);
  g_dbus_method_invocation_return_value(invocation, g_variant_new("(o)", request));
  GVariantBuilder results; g_variant_builder_init(&results, G_VARIANT_TYPE_VARDICT);
  if (!strcmp(method, "CreateSession")) g_variant_builder_add(&results, "{sv}", "session_handle", g_variant_new_object_path(session));
  if (!strcmp(method, "Start")) {
    g_variant_builder_add(&results, "{sv}", "devices", g_variant_new_uint32(1));
    g_variant_builder_add(&results, "{sv}", "restore_token", g_variant_new_string("private-test-token"));
  }
  g_dbus_connection_emit_signal(bus, NULL, request, "org.freedesktop.portal.Request", "Response",
    g_variant_new("(ua{sv})", deny ? 1 : 0, &results), NULL); g_free(request);
}
static const GDBusInterfaceVTable vtable = { .method_call = call };
static gboolean input(GIOChannel *channel, GIOCondition condition, gpointer data) {
  (void)data; gchar *line = NULL;
  if (!(condition & G_IO_IN) || g_io_channel_read_line(channel, &line, NULL, NULL, NULL) != G_IO_STATUS_NORMAL) {
    g_main_loop_quit(loop); g_free(line); return G_SOURCE_REMOVE;
  }
  if (g_str_has_prefix(line, "revoke")) g_dbus_connection_emit_signal(bus, NULL, session,
    "org.freedesktop.portal.Session", "Closed", g_variant_new("(a{sv})", NULL), NULL);
  else { printf("{\"keys\":[%s],\"types\":%u,\"restored\":%s,\"closed\":%s}\n", keys->str, types, restored ? "true" : "false", closed ? "true" : "false"); fflush(stdout); }
  g_free(line); return G_SOURCE_CONTINUE;
}
int main(int argc, char **argv) {
  deny = argc > 1 && !strcmp(argv[1], "deny"); keys = g_string_new("");
  bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, NULL); if (!bus) return 1;
  const char *xml = "<node><interface name='org.freedesktop.portal.RemoteDesktop'>"
    "<method name='CreateSession'><arg type='a{sv}' direction='in'/><arg type='o' direction='out'/></method>"
    "<method name='SelectDevices'><arg type='o' direction='in'/><arg type='a{sv}' direction='in'/><arg type='o' direction='out'/></method>"
    "<method name='Start'><arg type='o' direction='in'/><arg type='s' direction='in'/><arg type='a{sv}' direction='in'/><arg type='o' direction='out'/></method>"
    "<method name='NotifyKeyboardKeysym'><arg type='o' direction='in'/><arg type='a{sv}' direction='in'/><arg type='i' direction='in'/><arg type='u' direction='in'/></method>"
    "</interface><interface name='org.freedesktop.portal.Session'><method name='Close'/></interface></node>";
  GDBusNodeInfo *info = g_dbus_node_info_new_for_xml(xml, NULL);
  g_dbus_connection_register_object(bus, "/org/freedesktop/portal/desktop", info->interfaces[0], &vtable, NULL, NULL, NULL);
  g_dbus_connection_register_object(bus, session, info->interfaces[1], &vtable, NULL, NULL, NULL);
  GVariant *name = g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
    "org.freedesktop.DBus", "RequestName", g_variant_new("(su)", "org.freedesktop.portal.Desktop", 0), NULL, 0, 1000, NULL, NULL);
  if (!name) return 1;
  g_variant_unref(name);
  loop = g_main_loop_new(NULL, FALSE); GIOChannel *channel = g_io_channel_unix_new(0);
  g_io_add_watch(channel, G_IO_IN | G_IO_HUP, input, NULL);
  puts("ready"); fflush(stdout); g_main_loop_run(loop); return 0;
}
