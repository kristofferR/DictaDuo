/* Queued takes retain one guarded accessible. Every write needs text/caret readback. */
#include <atspi/atspi.h>
#include <atspi/atspi-device.h>
#include <xkbcommon/xkbcommon.h>
#include <json-glib/json-glib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <signal.h>
#include <unistd.h>
#include <glib-unix.h>
#include <fcntl.h>
#include <linux/input.h>
#include <sys/ioctl.h>

static AtspiAccessible *target;
static gchar *original;
static gint caret;
static gint selection_start = -1, selection_end = -1;
static gboolean invalidated;
static gint64 deadline;
static guint visited;
static gboolean queued;
static gchar *own_text;
static gint own_caret;
static gboolean own_insert_seen, own_caret_seen;
static gboolean typing_pending;
static gint own_inserted, own_last_caret;
static gchar *expected;
static gchar *own_deleted;
static gboolean own_delete_seen, own_selection_seen;
static gint own_start;
static gboolean chromium;
static gboolean paste_pending;
static gboolean literal_pending;
static gboolean portal_pending;
static gboolean guarding_input;
static guint own_key_index;
static gboolean own_key_down;
static GArray *input_fds;
static AtspiDevice *input_device;
static guint observed_modifiers;
static gboolean modifiers_known;
static gboolean input_state_known;
static const guint modifier_mask = (1U << ATSPI_MODIFIER_SHIFT) | (1U << ATSPI_MODIFIER_CONTROL) |
  (1U << ATSPI_MODIFIER_ALT) | (1U << ATSPI_MODIFIER_META3);
static const guint keycodes[] = {30,48,46,32,18,33,34,35,23,36,37,38,50,49,24,25};

static void interrupt_input(void) {
  invalidated = TRUE;
  if (typing_pending) atspi_event_quit();
}
static void key_event(AtspiDevice *device, gboolean pressed, guint keycode, guint keysym,
                      guint modifiers, const gchar *text, void *data) {
  (void)device; (void)text; (void)data;
  // The first callback supplies a modifier snapshot, including keys held
  // before the watcher started. A zero-initialized mask is not such a snapshot.
  modifiers_known = TRUE;
  observed_modifiers = modifiers & modifier_mask;
  guint modifier = 0;
  if (keysym == 0xffe1 || keysym == 0xffe2) modifier = 1U << ATSPI_MODIFIER_SHIFT;
  else if (keysym == 0xffe3 || keysym == 0xffe4) modifier = 1U << ATSPI_MODIFIER_CONTROL;
  else if (keysym == 0xffe9 || keysym == 0xffea) modifier = 1U << ATSPI_MODIFIER_ALT;
  else if (keysym == 0xffeb || keysym == 0xffec || keysym == 0xffe7 || keysym == 0xffe8) modifier = 1U << ATSPI_MODIFIER_META3;
  if (pressed) observed_modifiers |= modifier; else observed_modifiers &= ~modifier;
  if (!guarding_input) return;
  if (typing_pending && paste_pending) {
    const guint keys[] = {0xffe3, 'v', 'v', 0xffe3};
    const gboolean states[] = {TRUE, TRUE, FALSE, FALSE};
    if (own_key_index < 4 && keysym == keys[own_key_index] && pressed == states[own_key_index]) { own_key_index++; return; }
  } else if (typing_pending && !literal_pending && own_text && own_key_index < (guint)g_utf8_strlen(own_text, -1) && own_key_index < 16) {
    gunichar c = g_utf8_get_char(g_utf8_offset_to_pointer(own_text, own_key_index));
    guint expected = xkb_utf32_to_keysym(c);
    if ((portal_pending || keycode == keycodes[own_key_index] || keycode == keycodes[own_key_index] + 8) &&
        keysym == expected && pressed != own_key_down) {
      own_key_down = pressed; if (!pressed) own_key_index++; return;
    }
  }
  if (pressed) interrupt_input();
}
static gboolean physical_event(gint fd, GIOCondition condition, gpointer data) {
  (void)data;
  if (condition & (G_IO_ERR | G_IO_HUP)) { if (guarding_input) interrupt_input(); return G_SOURCE_REMOVE; }
  struct input_event events[32]; ssize_t bytes;
  while ((bytes = read(fd, events, sizeof(events))) > 0) {
    for (guint i = 0; i < (guint)bytes / sizeof(events[0]); i++) {
      if (!guarding_input) continue;
      if ((events[i].type == EV_KEY && events[i].value > 0) ||
          (events[i].type == EV_REL && (events[i].code == REL_WHEEL || events[i].code == REL_HWHEEL)) ||
          (events[i].type == EV_SYN && events[i].code == SYN_DROPPED)) interrupt_input();
    }
  }
  if (bytes < 0 && errno != EAGAIN && errno != EINTR && guarding_input) interrupt_input();
  return G_SOURCE_CONTINUE;
}
static void monitor_input(void) {
  /* Listen without grabbing input or changing device permissions. AT-SPI uses
   * the compositor/backend available to it; readable evdev devices distinguish
   * physical input from our Wayland and portal events. No keys are stored. */
  input_device = atspi_device_new();
  if (input_device) atspi_device_add_key_watcher(input_device, key_event, NULL, NULL);
  input_fds = g_array_new(FALSE, FALSE, sizeof(int));
  GDir *directory = g_dir_open("/dev/input", 0, NULL); if (!directory) return;
  const gchar *name;
  while ((name = g_dir_read_name(directory))) {
    if (!g_str_has_prefix(name, "event")) continue;
    gchar *path = g_build_filename("/dev/input", name, NULL);
    int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC); g_free(path);
    if (fd < 0) continue;
    unsigned long types[(EV_MAX + 8 * sizeof(long)) / (8 * sizeof(long))] = {0};
    if (ioctl(fd, EVIOCGBIT(0, sizeof(types)), types) < 0 || !(types[0] & (1UL << EV_KEY))) { close(fd); continue; }
    g_array_append_val(input_fds, fd);
    g_unix_fd_add(fd, G_IO_IN | G_IO_ERR | G_IO_HUP, physical_event, NULL);
  }
  g_dir_close(directory);
}
static gboolean arm_input(void) {
  guarding_input = FALSE;
  input_state_known = modifiers_known;
  if (observed_modifiers) return FALSE;
  // Discard events before this write, including the dictation shortcut release.
  for (guint i = 0; input_fds && i < input_fds->len; i++) {
    int fd = g_array_index(input_fds, int, i); struct input_event events[32];
    while (read(fd, events, sizeof(events)) > 0) {}
    unsigned long keys[(KEY_MAX + 8 * sizeof(long)) / (8 * sizeof(long))] = {0};
    if (ioctl(fd, EVIOCGKEY(sizeof(keys)), keys) < 0) { input_state_known = FALSE; return FALSE; }
    const guint held[] = {KEY_LEFTCTRL, KEY_RIGHTCTRL, KEY_LEFTSHIFT, KEY_RIGHTSHIFT,
      KEY_LEFTALT, KEY_RIGHTALT, KEY_LEFTMETA, KEY_RIGHTMETA, BTN_LEFT, BTN_RIGHT, BTN_MIDDLE};
    unsigned long supported[G_N_ELEMENTS(keys)] = {0};
    if (ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(supported)), supported) < 0) { input_state_known = FALSE; return FALSE; }
    // A readable mouse or media-button device cannot establish keyboard state.
    for (guint key = 0; key < 8; key++)
      if (supported[held[key] / (8 * sizeof(long))] & (1UL << (held[key] % (8 * sizeof(long))))) input_state_known = TRUE;
    for (guint key = 0; key < G_N_ELEMENTS(held); key++)
      if (keys[held[key] / (8 * sizeof(long))] & (1UL << (held[key] % (8 * sizeof(long))))) return FALSE;
  }
  if (!input_state_known) return FALSE;
  own_key_index = 0; own_key_down = FALSE; guarding_input = TRUE; return TRUE;
}

static void reply(const char *status) { puts(status); fflush(stdout); }

static void enable_accessibility(void) {
  GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, NULL);
  if (!bus) return;
  GVariant *status = g_dbus_connection_call_sync(bus, "org.a11y.Bus", "/org/a11y/bus",
    "org.freedesktop.DBus.Properties", "Get",
    g_variant_new("(ss)", "org.a11y.Status", "IsEnabled"), NULL,
    G_DBUS_CALL_FLAGS_NONE, 500, NULL, NULL);
  if (status) {
    GVariant *value = NULL;
    g_variant_get(status, "(v)", &value);
    if (g_variant_is_of_type(value, G_VARIANT_TYPE_BOOLEAN) && !g_variant_get_boolean(value)) {
      GVariant *updated = g_dbus_connection_call_sync(bus, "org.a11y.Bus", "/org/a11y/bus",
        "org.freedesktop.DBus.Properties", "Set",
        g_variant_new("(ssv)", "org.a11y.Status", "IsEnabled", g_variant_new_boolean(TRUE)),
        NULL, G_DBUS_CALL_FLAGS_NONE, 500, NULL, NULL);
      if (updated) g_variant_unref(updated);
    }
    g_variant_unref(value); g_variant_unref(status);
  }
  g_object_unref(bus);
}

static void prepare_accessibility(AtspiAccessible *obj) {
  /* Chromium enables its web tree when assistive clients use extended ATK
   * properties. Query metadata, without pretending a screen reader is running. */
  GHashTable *attributes = atspi_accessible_get_attributes(obj, NULL);
  if (attributes) g_hash_table_unref(attributes);
  GArray *relations = atspi_accessible_get_relation_set(obj, NULL);
  if (relations) g_array_unref(relations);
}

static gboolean ordinary_ancestors(AtspiAccessible *obj) {
  AtspiAccessible *current = g_object_ref(obj);
  for (guint depth = 0; current && depth < 32; depth++) {
    atspi_accessible_clear_cache_single(current);
    GError *error = NULL;
    AtspiRole role = atspi_accessible_get_role(current, &error);
    if (error || role == ATSPI_ROLE_PASSWORD_TEXT || role == ATSPI_ROLE_TERMINAL) {
      g_clear_error(&error); g_object_unref(current); return FALSE;
    }
    if (role == ATSPI_ROLE_APPLICATION) { g_object_unref(current); return TRUE; }
    AtspiAccessible *parent = atspi_accessible_get_parent(current, &error);
    g_object_unref(current);
    if (error) { g_clear_error(&error); g_clear_object(&parent); return FALSE; }
    current = parent;
  }
  g_clear_object(&current);
  return FALSE;
}

static gboolean safe(AtspiAccessible *obj) {
  atspi_accessible_clear_cache(obj);
  GError *error = NULL;
  AtspiRole role = atspi_accessible_get_role(obj, &error);
  if (error) { g_error_free(error); return FALSE; }
  /* Web editors can expose an editable document/container instead of Entry.
   * A role alone never qualifies: focused/editable states and Text are required. */
  if (role != ATSPI_ROLE_ENTRY && role != ATSPI_ROLE_TEXT &&
      role != ATSPI_ROLE_DOCUMENT_WEB && role != ATSPI_ROLE_DOCUMENT_TEXT &&
      role != ATSPI_ROLE_DOCUMENT_FRAME && role != ATSPI_ROLE_PARAGRAPH &&
      role != ATSPI_ROLE_SECTION && role != ATSPI_ROLE_PANEL) return FALSE;
  AtspiStateSet *states = atspi_accessible_get_state_set(obj);
  if (!states) return FALSE;
  gboolean valid = atspi_state_set_contains(states, ATSPI_STATE_FOCUSED) &&
    atspi_state_set_contains(states, ATSPI_STATE_EDITABLE) &&
    atspi_state_set_contains(states, ATSPI_STATE_ENABLED) &&
    atspi_state_set_contains(states, ATSPI_STATE_SHOWING) &&
    !atspi_state_set_contains(states, ATSPI_STATE_DEFUNCT);
  g_object_unref(states);
  return valid;
}

static AtspiAccessible *find(AtspiAccessible *obj, guint depth) {
  if (++visited > 512 || depth > 32 || g_get_monotonic_time() > deadline) return NULL;
  if (safe(obj)) return g_object_ref(obj);
  if (depth <= 2) prepare_accessibility(obj);
  GError *error = NULL;
  gint count = atspi_accessible_get_child_count(obj, &error);
  if (error) { g_error_free(error); return NULL; }
  for (gint i = 0; i < count && visited <= 512 && g_get_monotonic_time() <= deadline; i++) {
    AtspiAccessible *child = atspi_accessible_get_child_at_index(obj, i, &error);
    if (error) { g_clear_error(&error); continue; }
    if (!child) continue;
    AtspiAccessible *found = find(child, depth + 1);
    g_object_unref(child);
    if (found) return found;
  }
  return NULL;
}

static gchar *snapshot(gint *position, gchar **content, gint *start, gint *end) {
  if (!safe(target) || !ordinary_ancestors(target)) return NULL;
  AtspiText *text = atspi_accessible_get_text_iface(target);
  /* Text/caret readback is sufficient for guarded keyboard input. Requiring
   * EditableText here wrongly discards editors whose native writes are absent. */
  if (!text) return NULL;
  GError *error = NULL;
  gint count = atspi_text_get_character_count(text, &error);
  gint selection_count = error ? -1 : atspi_text_get_n_selections(text, &error);
  *position = error ? -1 : atspi_text_get_caret_offset(text, &error);
  *start = *end = -1;
  if (!error && selection_count == 1) {
    AtspiRange *range = atspi_text_get_selection(text, 0, &error);
    if (range) { *start = range->start_offset; *end = range->end_offset; g_free(range); }
  }
  gboolean selection_valid = selection_count == 0 ||
    (selection_count == 1 && *start >= 0 && *end > *start && *end <= count &&
     (*position == *start || *position == *end));
  gchar *value = NULL;
  if (!error && count >= 0 && count <= 65536 && selection_valid && *position >= 0 && *position <= count)
    value = atspi_text_get_text(text, 0, count, &error);
  if (error) { g_clear_pointer(&value, g_free); g_error_free(error); }
  g_object_unref(text);
  if (!value) return NULL;
  gchar *hash = g_compute_checksum_for_string(G_CHECKSUM_SHA256, value, -1);
  if (content) *content = value;
  else g_free(value);
  return hash;
}

static void changed(AtspiEvent *event, void *unused) {
  (void)unused;
  /* An accessibility tree becoming ready can reaffirm the retained focus.
   * A preceding blur or any other invalidation remains terminal. */
  if (!invalidated && event->source == target && event->detail1 &&
      g_strcmp0(event->type, "object:state-changed:focused") == 0 && safe(target)) return;
  /* Exempt only this helper's exact insertion and resulting caret event. All
   * other edits and focus/selection changes still invalidate every queued take. */
  if (own_text && event->source == target) {
    if (typing_pending && own_deleted && !own_delete_seen &&
        g_str_has_prefix(event->type, "object:text-changed:delete") &&
        event->detail1 == own_start && event->detail2 == g_utf8_strlen(own_deleted, -1) &&
        G_VALUE_HOLDS_STRING(&event->any_data) &&
        g_strcmp0(g_value_get_string(&event->any_data), own_deleted) == 0) {
      own_delete_seen = TRUE;
      return;
    }
    if (typing_pending && own_deleted && own_delete_seen && !own_selection_seen &&
        g_strcmp0(event->type, "object:text-selection-changed") == 0) {
      AtspiText *text = atspi_accessible_get_text_iface(target);
      GError *error = NULL;
      gint count = text ? atspi_text_get_n_selections(text, &error) : -1;
      g_clear_object(&text);
      gboolean collapsed = !error && count == 0;
      g_clear_error(&error);
      if (collapsed) { own_selection_seen = TRUE; return; }
    }
    if (typing_pending && g_str_has_prefix(event->type, "object:text-changed:insert") &&
        (!own_deleted || own_delete_seen) && event->detail1 == own_start + own_inserted &&
        event->detail2 > 0 && own_inserted + event->detail2 <= g_utf8_strlen(own_text, -1) &&
        G_VALUE_HOLDS_STRING(&event->any_data)) {
      const gchar *start = g_utf8_offset_to_pointer(own_text, own_inserted);
      const gchar *end = g_utf8_offset_to_pointer(start, event->detail2);
      const gchar *actual = g_value_get_string(&event->any_data);
      if (actual && strlen(actual) == (gsize)(end - start) && memcmp(actual, start, end - start) == 0) {
        own_inserted += event->detail2;
        return;
      }
    }
    if (typing_pending && g_strcmp0(event->type, "object:text-caret-moved") == 0 &&
        event->detail1 >= own_last_caret && event->detail1 <= own_caret &&
        event->detail1 <= own_start + own_inserted) {
      own_last_caret = event->detail1;
      return;
    }
    if (!typing_pending && !own_insert_seen && g_str_has_prefix(event->type, "object:text-changed:insert") &&
        event->detail1 == own_caret - g_utf8_strlen(own_text, -1) &&
        event->detail2 == g_utf8_strlen(own_text, -1) &&
        G_VALUE_HOLDS_STRING(&event->any_data) &&
        g_strcmp0(g_value_get_string(&event->any_data), own_text) == 0) {
      own_insert_seen = TRUE;
      return;
    }
    if (!typing_pending && !own_caret_seen && g_strcmp0(event->type, "object:text-caret-moved") == 0 &&
        event->detail1 == own_caret) {
      own_caret_seen = TRUE;
      return;
    }
  }
  if (target && (event->source == target ||
      (g_str_has_prefix(event->type, "object:state-changed:focused") && event->detail1))) {
    invalidated = TRUE;
    /* Closing stdout makes the parent stop an in-flight keyboard process too. */
    if (typing_pending) atspi_event_quit();
  }
}

static void prepare(const gchar *content, const gchar *value, gboolean typing) {
  own_start = selection_start >= 0 ? selection_start : caret;
  const gchar *split = g_utf8_offset_to_pointer(content, own_start);
  const gchar *suffix = g_utf8_offset_to_pointer(content, selection_end >= 0 ? selection_end : caret);
  g_free(own_deleted);
  own_deleted = selection_start >= 0 ? g_strndup(split, suffix - split) : NULL;
  own_delete_seen = own_selection_seen = FALSE;
  gchar *after = g_strdup_printf("%.*s%s%s", (int)(split - content), content, value, suffix);
  g_free(expected);
  expected = g_compute_checksum_for_string(G_CHECKSUM_SHA256, after, -1);
  g_free(after);
  g_free(own_text);
  own_text = g_strdup(value);
  own_caret = own_start + g_utf8_strlen(value, -1);
  own_insert_seen = own_caret_seen = FALSE;
  own_inserted = 0;
  own_last_caret = own_start;
  typing_pending = typing;
}

static gboolean confirm(void) {
  /* Providers may publish asynchronously. Pump their events and bound the wait;
   * a failed/partial write never becomes permission to repeat the payload. */
  gint64 until = g_get_monotonic_time() + 250000;
  while (!invalidated) {
    for (guint event = 0; event < 64 && g_main_context_pending(NULL); event++)
      g_main_context_iteration(NULL, FALSE);
    if (invalidated) break;
    gint position = -1;
    gint start = -1, end = -1;
    gchar *current = snapshot(&position, NULL, &start, &end);
    gboolean matches = current && g_strcmp0(current, expected) == 0 && position == own_caret && start == -1;
    g_free(current);
    if (matches && !invalidated) {
      guarding_input = FALSE;
      g_free(original);
      original = g_strdup(expected);
      caret = position;
      selection_start = selection_end = -1;
      return TRUE;
    }
    if (g_get_monotonic_time() >= until) break;
    g_usleep(5000);
  }
  invalidated = TRUE;
  guarding_input = FALSE;
  return FALSE;
}

static gboolean input(GIOChannel *channel, GIOCondition condition, gpointer unused) {
  (void)unused;
  if (!(condition & G_IO_IN)) { atspi_event_quit(); return G_SOURCE_REMOVE; }
  gchar *line = NULL;
  gsize length = 0;
  GIOStatus status = g_io_channel_read_line(channel, &line, &length, NULL, NULL);
  if (status == G_IO_STATUS_AGAIN) return G_SOURCE_CONTINUE;
  if (status != G_IO_STATUS_NORMAL || length > 262144) goto preview;
  JsonParser *parser = json_parser_new();
  gboolean parsed = json_parser_load_from_data(parser, line, length, NULL);
  JsonNode *node = parsed ? json_parser_get_root(parser) : NULL;
  const gchar *value = node && JSON_NODE_HOLDS_VALUE(node) && json_node_get_value_type(node) == G_TYPE_STRING ? json_node_get_string(node) : NULL;
  gboolean type_request = FALSE;
  gboolean paste_request = FALSE;
  if (node && JSON_NODE_HOLDS_OBJECT(node)) {
    JsonObject *object = json_node_get_object(node);
    if (json_object_has_member(object, "type") || json_object_has_member(object, "text"))
      paste_pending = literal_pending = portal_pending = FALSE;
    JsonNode *transport = json_object_get_member(object, "transport");
    if (transport && JSON_NODE_HOLDS_VALUE(transport) && json_node_get_value_type(transport) == G_TYPE_STRING) {
      const char *name = json_node_get_string(transport);
      paste_request = g_strcmp0(name, "paste") == 0 || g_strcmp0(name, "literal") == 0;
      paste_pending = g_strcmp0(name, "paste") == 0;
      literal_pending = g_strcmp0(name, "literal") == 0;
      portal_pending = g_strcmp0(name, "portal") == 0;
    }
    JsonNode *payload = json_object_get_member(object, "type");
    type_request = payload != NULL;
    if (!payload) payload = json_object_get_member(object, "text");
    if (payload && JSON_NODE_HOLDS_VALUE(payload) && json_node_get_value_type(payload) == G_TYPE_STRING)
      value = json_node_get_string(payload);
  }
  if (typing_pending && node && JSON_NODE_HOLDS_VALUE(node) &&
      json_node_get_value_type(node) == G_TYPE_BOOLEAN && !json_node_get_boolean(node)) {
    gboolean inserted = confirm();
    g_object_unref(parser); g_free(line);
    reply(inserted ? "inserted" : "uncertain");
    if (queued && inserted) return G_SOURCE_CONTINUE;
    atspi_event_quit();
    return G_SOURCE_REMOVE;
  }
  gint position = -1;
  gint start = -1, end = -1;
  gchar *content = NULL;
  gchar *current = invalidated ? NULL : snapshot(&position, &content, &start, &end);
  gboolean unchanged = !invalidated && current && g_strcmp0(original, current) == 0 &&
    position == caret && start == selection_start && end == selection_end;
  if (node && JSON_NODE_HOLDS_OBJECT(node) && json_object_has_member(json_node_get_object(node), "disarm")) {
    guarding_input = typing_pending = paste_pending = literal_pending = portal_pending = FALSE;
    g_free(own_text); own_text = NULL;
    g_free(current); g_free(content); g_object_unref(parser); g_free(line);
    reply(unchanged ? "ready" : "preview:changed");
    if (unchanged) return G_SOURCE_CONTINUE;
    atspi_event_quit(); return G_SOURCE_REMOVE;
  }
  /* A new take may join only the still-valid field retained by this helper. */
  if (queued && node && JSON_NODE_HOLDS_VALUE(node) &&
      json_node_get_value_type(node) == G_TYPE_BOOLEAN && json_node_get_boolean(node)) {
    g_free(current); g_free(content); g_object_unref(parser); g_free(line);
    reply(unchanged ? "ready" : "preview:changed");
    if (unchanged) return G_SOURCE_CONTINUE;
    atspi_event_quit();
    return G_SOURCE_REMOVE;
  }
  gboolean valid = unchanged && value &&
    strlen(value) <= 131072 && g_utf8_validate(value, -1, NULL) && !strchr(value, '\r') &&
    g_utf8_strlen(content, -1) + g_utf8_strlen(value, -1) -
      (selection_start >= 0 ? selection_end - selection_start : 0) <= 65536;
  gboolean multiline_rejected = FALSE;
  if (valid && strchr(value, '\n')) {
    AtspiStateSet *states = atspi_accessible_get_state_set(target);
    valid = states && atspi_state_set_contains(states, ATSPI_STATE_MULTI_LINE);
    multiline_rejected = !valid;
    g_clear_object(&states);
  }
  g_free(current);
  if (valid) {
    if (type_request) {
      gboolean printable = *value && (paste_request || g_utf8_strlen(value, -1) <= 16);
      for (const gchar *p = value; printable && *p; p = g_utf8_next_char(p))
        if ((g_utf8_get_char(p) < 32 && !(paste_request && (g_utf8_get_char(p) == 10 || g_utf8_get_char(p) == 9))) || g_utf8_get_char(p) == 127) printable = FALSE;
      gboolean armed = printable && arm_input();
      if (armed) { prepare(content, value, TRUE); reply("ready"); }
      else { valid = FALSE; reply(printable ? (input_state_known ? "preview:modifiers" : "preview:input") : "preview"); }
      g_object_unref(parser); g_free(content); g_free(line);
      if (queued && valid) return G_SOURCE_CONTINUE;
      atspi_event_quit();
      return G_SOURCE_REMOVE;
    }
    /* AT-SPI has no atomic range replacement. Let one keyboard transaction
     * replace the retained selection; never delete then risk a failed insert. */
    AtspiEditableText *editable = selection_start < 0 ? atspi_accessible_get_editable_text_iface(target) : NULL;
    if (editable) {
      GError *error = NULL;
      if (!arm_input()) {
        reply(input_state_known ? "preview:modifiers" : "preview:input"); g_object_unref(editable); g_object_unref(parser); g_free(content); g_free(line);
        atspi_event_quit(); return G_SOURCE_REMOVE;
      }
      prepare(content, value, FALSE);
      gboolean inserted = atspi_editable_text_insert_text(editable, caret, value, (gint)strlen(value), &error);
      if (!inserted || error || !confirm()) invalidated = TRUE;
      /* Even a false reply may follow partial application. Never retry. */
      reply(inserted && !error && !invalidated ? "inserted" : "uncertain");
      g_clear_error(&error);
      g_object_unref(editable);
    } else { reply("typing"); }
  } else reply(multiline_rejected ? "preview:multiline" : "preview:changed");
  g_object_unref(parser);
  g_free(content);
  g_free(line);
  if (queued && valid && !invalidated) return G_SOURCE_CONTINUE;
  atspi_event_quit();
  return G_SOURCE_REMOVE;
preview:
  reply("preview");
  g_free(line);
  atspi_event_quit();
  return G_SOURCE_REMOVE;
}

int main(int argc, char **argv) {
  if ((argc == 2 || argc == 3) && g_strcmp0(argv[1], "--warm") == 0) {
    char *end = NULL;
    guint64 pid = argc == 3 ? g_ascii_strtoull(argv[2], &end, 10) : 0;
    if (argc == 3 && (!pid || pid > G_MAXUINT || *end)) return 2;
    enable_accessibility();
    if (atspi_init()) return 1;
    AtspiAccessible *desktop = atspi_get_desktop(0);
    gboolean available = desktop != NULL;
    gint count = desktop ? atspi_accessible_get_child_count(desktop, NULL) : 0;
    atspi_set_timeout(100, 100);
    for (gint i = 0; i < count; i++) {
      AtspiAccessible *app = atspi_accessible_get_child_at_index(desktop, i, NULL);
      if (app) {
        if (!pid || atspi_accessible_get_process_id(app, NULL) == pid) {
          prepare_accessibility(app);
          gint windows = atspi_accessible_get_child_count(app, NULL);
          for (gint window = 0; window < windows && window < 4; window++) {
            AtspiAccessible *frame = atspi_accessible_get_child_at_index(app, window, NULL);
            if (frame) { prepare_accessibility(frame); g_object_unref(frame); }
          }
        }
        g_object_unref(app);
      }
    }
    g_clear_object(&desktop);
    atspi_exit();
    return available ? 0 : 1;
  }
  if (argc != 2 && !(argc == 3 && g_strcmp0(argv[2], "queue") == 0)) return 2;
  queued = argc == 3;
  char *end = NULL;
  gboolean focused_mode = g_strcmp0(argv[1], "focused") == 0;
  guint64 pid = focused_mode ? 0 : g_ascii_strtoull(argv[1], &end, 10);
  if (!focused_mode && (!pid || pid > G_MAXUINT || *end)) return 2;
  pid_t parent = getppid();
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) return 2;
  /* Server queue wait has no deadline, so a queued helper lives until its parent
   * closes it or dies. */
  if (!queued) alarm(600);
  if (atspi_init()) { reply("preview:service"); return 0; }
  atspi_set_timeout(100, 100);
  monitor_input();
  deadline = g_get_monotonic_time() + 1000000;
  AtspiEventListener *listener = atspi_event_listener_new(changed, NULL, NULL);
  const char *events[] = { "object:state-changed:focused", "object:text-changed", "object:text-caret-moved", "object:text-selection-changed", "object:state-changed:defunct" };
  for (guint i = 0; i < G_N_ELEMENTS(events); i++) {
    if (!atspi_event_listener_register(listener, events[i], NULL)) { reply("preview"); return 0; }
  }
  AtspiAccessible *desktop = atspi_get_desktop(0);
  gint count = desktop ? atspi_accessible_get_child_count(desktop, NULL) : 0;
  gboolean ambiguous = FALSE;
  for (gint i = 0; i < count && g_get_monotonic_time() <= deadline; i++) {
    AtspiAccessible *app = atspi_accessible_get_child_at_index(desktop, i, NULL);
    if (!app) continue;
    if (focused_mode || atspi_accessible_get_process_id(app, NULL) == pid) {
      gchar *toolkit = atspi_accessible_get_toolkit_name(app, NULL);
      gboolean candidate_chromium = toolkit && g_strcmp0(toolkit, "Chromium") == 0;
      g_free(toolkit);
      visited = 0;
      AtspiAccessible *candidate = find(app, 0);
      while (!candidate && !focused_mode && g_get_monotonic_time() < deadline) {
        while (g_main_context_pending(NULL)) g_main_context_iteration(NULL, FALSE);
        g_usleep(20000);
        visited = 0;
        candidate = find(app, 0);
      }
      if (candidate && target) {
        ambiguous = TRUE;
        g_object_unref(candidate);
        g_object_unref(app);
        break;
      }
      if (candidate) { target = candidate; chromium = candidate_chromium; }
    }
    g_object_unref(app);
    if (target && !focused_mode) break;
  }
  g_clear_object(&desktop);
  if (focused_mode && g_get_monotonic_time() > deadline) ambiguous = TRUE;
  /* Tree activation can queue focus events predating the captured field. Drain
   * those before establishing the initial text/caret snapshot, then revalidate. */
  AtspiAccessible *selected = target;
  target = NULL;
  for (guint pass = 0; selected && pass < 3; pass++) {
    for (guint event = 0; event < 64 && g_main_context_pending(NULL); event++)
      g_main_context_iteration(NULL, FALSE);
    g_usleep(20000);
  }
  target = selected;
  invalidated = FALSE;
  if (ambiguous || !target || !(original = snapshot(&caret, NULL, &selection_start, &selection_end))) {
    g_clear_object(&target);
    reply("preview:field"); atspi_exit(); return 0;
  }
  AtspiAccessible *ancestor = g_object_ref(target);
  gboolean web = FALSE;
  for (guint depth = 0; ancestor && depth < 32; depth++) {
    AtspiRole role = atspi_accessible_get_role(ancestor, NULL);
    if (role == ATSPI_ROLE_DOCUMENT_WEB) web = TRUE;
    if (role == ATSPI_ROLE_APPLICATION) break;
    AtspiAccessible *parent_obj = atspi_accessible_get_parent(ancestor, NULL);
    g_object_unref(ancestor);
    ancestor = parent_obj;
  }
  g_clear_object(&ancestor);
  reply(web && chromium ? "ready:chromium" : web ? "ready:web" : "ready");
  GIOChannel *channel = g_io_channel_unix_new(STDIN_FILENO);
  g_io_channel_set_flags(channel, G_IO_FLAG_NONBLOCK, NULL);
  g_io_add_watch(channel, G_IO_IN | G_IO_HUP | G_IO_ERR, input, NULL);
  atspi_event_main();
  g_io_channel_unref(channel);
  g_free(original);
  g_free(own_text);
  g_free(expected);
  g_free(own_deleted);
  g_object_unref(target);
  g_object_unref(listener);
  g_clear_object(&input_device);
  for (guint i = 0; input_fds && i < input_fds->len; i++) close(g_array_index(input_fds, int, i));
  if (input_fds) g_array_unref(input_fds);
  atspi_exit();
  return 0;
}
