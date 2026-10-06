/* A clipboard lease preserves every advertised MIME representation. It restores
 * only while its own source still owns the selection, never a newer owner. */
#define _GNU_SOURCE
#include <glib-unix.h>
#include <gio/gio.h>
#include <json-glib/json-glib.h>
#include <wayland-client.h>
#ifdef DICTADUO_EXT_DATA_CONTROL
#include "ext-data-control.h"
#define zwlr_data_control_manager_v1 ext_data_control_manager_v1
#define zwlr_data_control_manager_v1_interface ext_data_control_manager_v1_interface
#define zwlr_data_control_manager_v1_create_data_source ext_data_control_manager_v1_create_data_source
#define zwlr_data_control_manager_v1_get_data_device ext_data_control_manager_v1_get_data_device
#define zwlr_data_control_device_v1 ext_data_control_device_v1
#define zwlr_data_control_device_v1_listener ext_data_control_device_v1_listener
#define zwlr_data_control_device_v1_add_listener ext_data_control_device_v1_add_listener
#define zwlr_data_control_device_v1_set_selection ext_data_control_device_v1_set_selection
#define zwlr_data_control_offer_v1 ext_data_control_offer_v1
#define zwlr_data_control_offer_v1_listener ext_data_control_offer_v1_listener
#define zwlr_data_control_offer_v1_add_listener ext_data_control_offer_v1_add_listener
#define zwlr_data_control_offer_v1_destroy ext_data_control_offer_v1_destroy
#define zwlr_data_control_offer_v1_receive ext_data_control_offer_v1_receive
#define zwlr_data_control_source_v1 ext_data_control_source_v1
#define zwlr_data_control_source_v1_listener ext_data_control_source_v1_listener
#define zwlr_data_control_source_v1_add_listener ext_data_control_source_v1_add_listener
#define zwlr_data_control_source_v1_destroy ext_data_control_source_v1_destroy
#define zwlr_data_control_source_v1_offer ext_data_control_source_v1_offer
#define MANAGER_NAME "ext_data_control_manager_v1"
#else
#include "data-control.h"
#define MANAGER_NAME "zwlr_data_control_manager_v1"
#endif
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

typedef struct { struct zwlr_data_control_offer_v1 *proxy; GPtrArray *types; gboolean invalid; } Offer;
typedef struct { struct zwlr_data_control_source_v1 *proxy; GHashTable *data; gboolean cancelled; } Source;
typedef struct { int fd; GBytes *bytes; gsize offset; guint watch, timeout; } Transfer;
static struct wl_display *display;
static struct wl_seat *seat;
static struct zwlr_data_control_manager_v1 *manager;
static struct zwlr_data_control_device_v1 *device;
static Offer *selection;
static guint64 revision, owned_revision;
static Source *source;
static GHashTable *backup;
static gchar *marker;
static gboolean orphaned;
static GMainLoop *loop;

static GHashTable *payloads(void) { return g_hash_table_new_full(g_str_hash, g_str_equal, g_free, (GDestroyNotify)g_bytes_unref); }
static void reply(const char *value) { puts(value); fflush(stdout); }
static void drop_transfer(Transfer *t) { close(t->fd); g_bytes_unref(t->bytes); g_free(t); }
static gboolean expire_transfer(gpointer data) {
  Transfer *t = data; g_source_remove(t->watch); drop_transfer(t); return G_SOURCE_REMOVE;
}
static gboolean write_transfer(gint fd, GIOCondition condition, gpointer data) {
  Transfer *t = data; gsize size; const guint8 *bytes = g_bytes_get_data(t->bytes, &size);
  if (!(condition & (G_IO_ERR | G_IO_HUP))) {
    ssize_t n = write(fd, bytes + t->offset, size - t->offset);
    if (n > 0) t->offset += n;
    else if (n < 0 && (errno == EAGAIN || errno == EINTR)) return G_SOURCE_CONTINUE;
    else condition |= G_IO_ERR;
  }
  if (t->offset < size && !(condition & (G_IO_ERR | G_IO_HUP))) return G_SOURCE_CONTINUE;
  g_source_remove(t->timeout); drop_transfer(t); return G_SOURCE_REMOVE;
}
static void send_data(void *data, struct zwlr_data_control_source_v1 *proxy, const char *type, int32_t fd) {
  (void)proxy; Source *s = data; GBytes *bytes = g_hash_table_lookup(s->data, type);
  if (!bytes) { close(fd); return; }
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
  Transfer *t = g_new0(Transfer, 1); t->fd = fd; t->bytes = g_bytes_ref(bytes);
  t->watch = g_unix_fd_add(fd, G_IO_OUT | G_IO_HUP | G_IO_ERR, write_transfer, t);
  t->timeout = g_timeout_add(3000, expire_transfer, t);
}
static void cancelled(void *data, struct zwlr_data_control_source_v1 *proxy) {
  (void)proxy; Source *s = data; s->cancelled = TRUE;
  if (orphaned && s == source) g_main_loop_quit(loop);
}
static const struct zwlr_data_control_source_v1_listener source_listener = { send_data, cancelled };
static void free_source(Source *s) {
  if (!s) return;
  zwlr_data_control_source_v1_destroy(s->proxy); g_hash_table_unref(s->data); g_free(s);
}
static Source *publish(GHashTable *data) {
  Source *next = NULL;
  if (g_hash_table_size(data)) {
    next = g_new0(Source, 1); next->data = g_hash_table_ref(data);
    next->proxy = zwlr_data_control_manager_v1_create_data_source(manager);
    zwlr_data_control_source_v1_add_listener(next->proxy, &source_listener, next);
    GHashTableIter iter; gpointer type; g_hash_table_iter_init(&iter, data);
    while (g_hash_table_iter_next(&iter, &type, NULL)) zwlr_data_control_source_v1_offer(next->proxy, type);
  }
  zwlr_data_control_device_v1_set_selection(device, next ? next->proxy : NULL);
  wl_display_flush(display);
  return next;
}
static void offered(void *data, struct zwlr_data_control_offer_v1 *proxy, const char *type) {
  (void)proxy; Offer *offer = data;
  if (offer->types->len < 128 && strlen(type) < 1024) g_ptr_array_add(offer->types, g_strdup(type));
  else offer->invalid = TRUE;
}
static const struct zwlr_data_control_offer_v1_listener offer_listener = { offered };
static void free_offer(Offer *offer) {
  if (!offer) return;
  zwlr_data_control_offer_v1_destroy(offer->proxy); g_ptr_array_unref(offer->types); g_free(offer);
}
static void new_offer(void *data, struct zwlr_data_control_device_v1 *proxy, struct zwlr_data_control_offer_v1 *value) {
  (void)data; (void)proxy; Offer *offer = g_new0(Offer, 1); offer->proxy = value;
  offer->types = g_ptr_array_new_with_free_func(g_free);
  zwlr_data_control_offer_v1_add_listener(value, &offer_listener, offer);
}
static void new_selection(void *data, struct zwlr_data_control_device_v1 *proxy, struct zwlr_data_control_offer_v1 *value) {
  (void)data; (void)proxy; Offer *next = value ? wl_proxy_get_user_data((struct wl_proxy *)value) : NULL;
  if (selection != next) free_offer(selection);
  selection = next; revision++;
}
static void finished(void *data, struct zwlr_data_control_device_v1 *proxy) {
  (void)data; (void)proxy; g_main_loop_quit(loop);
}
static void primary(void *data, struct zwlr_data_control_device_v1 *proxy, struct zwlr_data_control_offer_v1 *value) {
  (void)data; (void)proxy; if (value) free_offer(wl_proxy_get_user_data((struct wl_proxy *)value));
}
static const struct zwlr_data_control_device_v1_listener device_listener = { new_offer, new_selection, finished, primary };
static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
  (void)data; (void)version;
  if (!seat && strcmp(interface, "wl_seat") == 0) seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
  if (!manager && strcmp(interface, MANAGER_NAME) == 0)
    manager = wl_registry_bind(registry, name, &zwlr_data_control_manager_v1_interface, 1);
}
static void removed(void *data, struct wl_registry *registry, uint32_t name) { (void)data; (void)registry; (void)name; }
static const struct wl_registry_listener registry_listener = { global, removed };
static gboolean wayland_ready(gint fd, GIOCondition condition, gpointer data) {
  (void)fd; (void)data;
  if ((condition & (G_IO_HUP | G_IO_ERR)) || wl_display_dispatch(display) < 0) { g_main_loop_quit(loop); return G_SOURCE_REMOVE; }
  wl_display_flush(display); return G_SOURCE_CONTINUE;
}
static gboolean owns(void) {
  if (wl_display_roundtrip(display) < 0 || !source || source->cancelled || revision != owned_revision || !selection) return FALSE;
  for (guint i = 0; i < selection->types->len; i++) if (g_strcmp0(g_ptr_array_index(selection->types, i), marker) == 0) return TRUE;
  return FALSE;
}
static GBytes *read_data(Offer *offer, const char *type, guint64 captured, gint64 deadline, gsize *total) {
  int fds[2]; if (pipe2(fds, O_CLOEXEC | O_NONBLOCK)) return NULL;
  zwlr_data_control_offer_v1_receive(offer->proxy, type, fds[1]); close(fds[1]); wl_display_flush(display);
  GByteArray *bytes = g_byte_array_new(); gboolean complete = FALSE;
  while (revision == captured && g_get_monotonic_time() < deadline) {
    for (guint i = 0; i < 64 && g_main_context_pending(NULL); i++) g_main_context_iteration(NULL, FALSE);
    guint8 buffer[65536]; ssize_t n = read(fds[0], buffer, sizeof(buffer));
    if (!n) { complete = TRUE; break; }
    if (n > 0) {
      *total += n; if (*total > 32 * 1024 * 1024) break;
      g_byte_array_append(bytes, buffer, n);
    } else if (errno != EAGAIN && errno != EINTR) break;
    else g_usleep(1000);
  }
  close(fds[0]);
  if (complete && revision == captured) return g_byte_array_free_to_bytes(bytes);
  g_byte_array_unref(bytes); return NULL;
}
static gboolean stage(const gchar *text) {
  if (backup || wl_display_roundtrip(display) < 0) return FALSE;
  guint64 captured = revision; Offer *offer = selection; GHashTable *saved = payloads(); gsize total = 0;
  gint64 deadline = g_get_monotonic_time() + 1500000;
  GPtrArray *types = g_ptr_array_new_with_free_func(g_free);
  if (offer && offer->invalid) goto failed;
  if (offer) for (guint i = 0; i < offer->types->len; i++) g_ptr_array_add(types, g_strdup(g_ptr_array_index(offer->types, i)));
  for (guint i = 0; i < types->len; i++) {
    if (revision != captured || i >= 128) goto failed;
    const gchar *type = g_ptr_array_index(types, i); if (!type) goto failed;
    GBytes *bytes = read_data(offer, type, captured, deadline, &total); if (!bytes) goto failed;
    g_hash_table_insert(saved, g_strdup(type), bytes);
  }
  if (orphaned || wl_display_roundtrip(display) < 0 || revision != captured) goto failed;
  GHashTable *data = payloads(); const char *text_types[] = { "text/plain;charset=utf-8", "text/plain", "UTF8_STRING" };
  for (guint i = 0; i < G_N_ELEMENTS(text_types); i++) g_hash_table_insert(data, g_strdup(text_types[i]), g_bytes_new(text, strlen(text)));
  gchar *id = g_uuid_string_random(); g_free(marker); marker = g_strconcat("application/x-dictaduo-lease-", id, NULL); g_free(id);
  g_hash_table_insert(data, g_strdup(marker), g_bytes_new_static("", 0));
  g_hash_table_insert(data, g_strdup("x-kde-passwordManagerHint"), g_bytes_new_static("secret", 6));
  Source *previous = source; source = publish(data); g_hash_table_unref(data);
  backup = saved;
  g_ptr_array_unref(types);
  if (wl_display_roundtrip(display) < 0) return FALSE;
  owned_revision = revision; free_source(previous);
  return owns();
failed:
  g_ptr_array_unref(types); g_hash_table_unref(saved); return FALSE;
}
static void restore(void) {
  if (!backup) return;
  if (owns()) {
    Source *previous = source; source = publish(backup);
    wl_display_roundtrip(display); free_source(previous);
  }
  g_clear_pointer(&backup, g_hash_table_unref);
}
static gboolean input(GIOChannel *channel, GIOCondition condition, gpointer data) {
  (void)data;
  if (!(condition & G_IO_IN)) {
    orphaned = TRUE; restore();
    if (!source || source->cancelled) g_main_loop_quit(loop);
    return G_SOURCE_REMOVE;
  }
  gchar *line = NULL; gsize length; GIOStatus status = g_io_channel_read_line(channel, &line, &length, NULL, NULL);
  if (status == G_IO_STATUS_AGAIN) return G_SOURCE_CONTINUE;
  if (status != G_IO_STATUS_NORMAL) { g_free(line); orphaned = TRUE; restore(); if (!source || source->cancelled) g_main_loop_quit(loop); return G_SOURCE_REMOVE; }
  JsonParser *parser = json_parser_new(); gboolean ok = length <= 262144 && json_parser_load_from_data(parser, line, length, NULL);
  JsonNode *node = ok ? json_parser_get_root(parser) : NULL;
  JsonObject *object = node && JSON_NODE_HOLDS_OBJECT(node) ? json_node_get_object(node) : NULL;
  JsonNode *value = object ? json_object_get_member(object, "stage") : NULL;
  if (value && JSON_NODE_HOLDS_VALUE(value) && json_node_get_value_type(value) == G_TYPE_STRING) {
    const gchar *text = json_node_get_string(value);
    reply(g_utf8_validate(text, -1, NULL) && stage(text) ? "staged" : "unavailable");
  } else if (object && json_object_has_member(object, "restore")) { restore(); reply("restored"); }
  else if (object && json_object_has_member(object, "check")) reply(owns() ? "owned" : "changed");
  else reply("unavailable");
  g_object_unref(parser); g_free(line); return G_SOURCE_CONTINUE;
}
static gboolean independent_scope(void) {
  /* Restored clipboard ownership must survive a background-client restart.
   * A user scope contains only this helper and ends when the next owner replaces it. */
  GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, NULL); if (!bus) return FALSE;
  GVariantBuilder props, pids, aux; g_variant_builder_init(&props, G_VARIANT_TYPE("a(sv)"));
  g_variant_builder_init(&pids, G_VARIANT_TYPE("au")); g_variant_builder_add(&pids, "u", (guint)getpid());
  g_variant_builder_add(&props, "(sv)", "PIDs", g_variant_builder_end(&pids));
  g_variant_builder_add(&props, "(sv)", "Description", g_variant_new_string("DictaDuo clipboard restoration"));
  g_variant_builder_add(&props, "(sv)", "CollectMode", g_variant_new_string("inactive-or-failed"));
  g_variant_builder_init(&aux, G_VARIANT_TYPE("a(sa(sv))"));
  gchar *name = g_strdup_printf("dictaduo-clipboard-%d.scope", getpid());
  GVariant *result = g_dbus_connection_call_sync(bus, "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager", "StartTransientUnit", g_variant_new("(ssa(sv)a(sa(sv)))", name, "fail", &props, &aux),
    NULL, G_DBUS_CALL_FLAGS_NONE, 1000, NULL, NULL);
  gboolean ok = FALSE;
  if (result) {
    g_variant_unref(result);
    gint64 until = g_get_monotonic_time() + 300000;
    do {
      gchar *group = NULL;
      if (g_file_get_contents("/proc/self/cgroup", &group, NULL, NULL)) ok = strstr(group, name) != NULL;
      g_free(group); if (ok) break;
      g_usleep(1000);
    } while (g_get_monotonic_time() < until);
  }
  g_free(name); g_object_unref(bus); return ok;
}
int main(void) {
  signal(SIGPIPE, SIG_IGN); loop = g_main_loop_new(NULL, FALSE);
  if (!independent_scope() || !(display = wl_display_connect(NULL))) { reply("unavailable"); return 1; }
  struct wl_registry *registry = wl_display_get_registry(display); wl_registry_add_listener(registry, &registry_listener, NULL);
  if (wl_display_roundtrip(display) < 0 || !manager || !seat) { reply("unavailable"); return 1; }
  device = zwlr_data_control_manager_v1_get_data_device(manager, seat); zwlr_data_control_device_v1_add_listener(device, &device_listener, NULL);
  if (wl_display_roundtrip(display) < 0) { reply("unavailable"); return 1; }
  g_unix_fd_add(wl_display_get_fd(display), G_IO_IN | G_IO_ERR | G_IO_HUP, wayland_ready, NULL);
  GIOChannel *channel = g_io_channel_unix_new(STDIN_FILENO); g_io_channel_set_flags(channel, G_IO_FLAG_NONBLOCK, NULL);
  g_io_add_watch(channel, G_IO_IN | G_IO_HUP | G_IO_ERR, input, NULL);
  reply("ready"); g_main_loop_run(loop); restore(); wl_display_disconnect(display); return 0;
}
