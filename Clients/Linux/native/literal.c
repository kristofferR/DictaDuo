/* Commit UTF-8 through the compositor's input method, without action keys or
 * clipboard changes. Never displace an already registered input method. */
#define _GNU_SOURCE
#include <glib-unix.h>
#include <json-glib/json-glib.h>
#include <wayland-client.h>
#include "input-method.h"
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <signal.h>
#include <unistd.h>
static struct wl_display *display;
static struct wl_seat *seat;
static struct zwp_input_method_manager_v2 *manager;
static struct zwp_input_method_v2 *method;
static gboolean active, pending_active, unavailable, protected;
static guint serial;
static GMainLoop *loop;
static void activate(void *data, struct zwp_input_method_v2 *obj) { (void)data; (void)obj; pending_active = TRUE; protected = FALSE; }
static void deactivate(void *data, struct zwp_input_method_v2 *obj) { (void)data; (void)obj; pending_active = FALSE; }
static void surrounding(void *data, struct zwp_input_method_v2 *obj, const char *text, uint32_t cursor, uint32_t anchor) {
  (void)data; (void)obj; (void)text; (void)cursor; (void)anchor;
}
static void cause(void *data, struct zwp_input_method_v2 *obj, uint32_t value) { (void)data; (void)obj; (void)value; }
static void content(void *data, struct zwp_input_method_v2 *obj, uint32_t hint, uint32_t purpose) {
  (void)data; (void)obj;
  // text-input-v3: hidden/sensitive hints and password/PIN purposes.
  protected = (hint & (64 | 128)) || purpose == 8 || purpose == 9;
}
static void done(void *data, struct zwp_input_method_v2 *obj) { (void)data; (void)obj; serial++; active = pending_active; }
static void lost(void *data, struct zwp_input_method_v2 *obj) { (void)data; (void)obj; unavailable = TRUE; active = FALSE; if (loop) g_main_loop_quit(loop); }
static const struct zwp_input_method_v2_listener method_listener = { activate, deactivate, surrounding, cause, content, done, lost };
static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
  (void)data; (void)version;
  if (!seat && strcmp(interface, "wl_seat") == 0) seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
  if (!manager && strcmp(interface, "zwp_input_method_manager_v2") == 0)
    manager = wl_registry_bind(registry, name, &zwp_input_method_manager_v2_interface, 1);
}
static void removed(void *data, struct wl_registry *registry, uint32_t name) { (void)data; (void)registry; (void)name; }
static const struct wl_registry_listener registry_listener = { global, removed };
static void reply(const char *status) { puts(status); fflush(stdout); }
static gboolean wayland_ready(gint fd, GIOCondition condition, gpointer data) {
  (void)fd; (void)data;
  if ((condition & (G_IO_HUP | G_IO_ERR)) || wl_display_dispatch(display) < 0) { g_main_loop_quit(loop); return G_SOURCE_REMOVE; }
  return G_SOURCE_CONTINUE;
}
static gboolean input(GIOChannel *channel, GIOCondition condition, gpointer data) {
  (void)data; gchar *line = NULL; gsize length;
  if (!(condition & G_IO_IN)) { g_main_loop_quit(loop); return G_SOURCE_REMOVE; }
  GIOStatus status = g_io_channel_read_line(channel, &line, &length, NULL, NULL);
  if (status == G_IO_STATUS_AGAIN) return G_SOURCE_CONTINUE;
  if (status != G_IO_STATUS_NORMAL) { g_free(line); g_main_loop_quit(loop); return G_SOURCE_REMOVE; }
  JsonParser *parser = json_parser_new(); gboolean valid = length <= 8192 && json_parser_load_from_data(parser, line, length, NULL);
  JsonNode *node = valid ? json_parser_get_root(parser) : NULL;
  const gchar *text = node && JSON_NODE_HOLDS_VALUE(node) && json_node_get_value_type(node) == G_TYPE_STRING ? json_node_get_string(node) : NULL;
  valid = text && *text && strlen(text) <= 4000 && g_utf8_validate(text, -1, NULL);
  if (valid) for (const gchar *p = text; *p; p = g_utf8_next_char(p)) {
    gunichar c = g_utf8_get_char(p); if ((c < 32 && c != 10 && c != 9) || c == 127) { valid = FALSE; break; }
  }
  if (valid && wl_display_roundtrip(display) >= 0 && active && !protected && !unavailable) {
    zwp_input_method_v2_commit_string(method, text);
    zwp_input_method_v2_commit(method, serial);
    reply(wl_display_roundtrip(display) >= 0 ? "sent" : "uncertain");
  } else reply("unavailable");
  g_object_unref(parser); g_free(line); return G_SOURCE_CONTINUE;
}
int main(void) {
  pid_t parent = getppid(); if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) return 1;
  display = wl_display_connect(NULL); if (!display) { reply("unavailable"); return 1; }
  struct wl_registry *registry = wl_display_get_registry(display); wl_registry_add_listener(registry, &registry_listener, NULL);
  if (wl_display_roundtrip(display) < 0 || !seat || !manager) { reply("unavailable"); return 1; }
  method = zwp_input_method_manager_v2_get_input_method(manager, seat); zwp_input_method_v2_add_listener(method, &method_listener, NULL);
  if (wl_display_roundtrip(display) < 0 || unavailable || !active || protected) { reply("unavailable"); return 1; }
  loop = g_main_loop_new(NULL, FALSE);
  g_unix_fd_add(wl_display_get_fd(display), G_IO_IN | G_IO_HUP | G_IO_ERR, wayland_ready, NULL);
  GIOChannel *channel = g_io_channel_unix_new(STDIN_FILENO); g_io_channel_set_flags(channel, G_IO_FLAG_NONBLOCK, NULL);
  g_io_add_watch(channel, G_IO_IN | G_IO_HUP | G_IO_ERR, input, NULL);
  reply("ready"); g_main_loop_run(loop); zwp_input_method_v2_destroy(method); wl_display_disconnect(display); return 0;
}
