/* Unicode virtual keyboard with printable physical keycodes. Some Chromium
 * paths interpret action keycodes even when a custom keymap gives them text. */
#define _GNU_SOURCE
#include <glib.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>
#include "virtual-keyboard.h"
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <signal.h>
#include <time.h>
#include <unistd.h>

static struct wl_seat *seat;
static struct zwp_virtual_keyboard_manager_v1 *manager;
static void global(void *data, struct wl_registry *registry, uint32_t name,
                   const char *interface, uint32_t version) {
  (void)data; (void)version;
  if (!seat && strcmp(interface, "wl_seat") == 0)
    seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
  if (!manager && strcmp(interface, "zwp_virtual_keyboard_manager_v1") == 0)
    manager = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
}
static void removed(void *data, struct wl_registry *registry, uint32_t name) {
  (void)data; (void)registry; (void)name;
}
static const struct wl_registry_listener listener = { global, removed };

int main(int argc, char **argv) {
  gboolean probe = argc == 2 && strcmp(argv[1], "--probe") == 0;
  if (argc != 1 && !probe) return 2;
  pid_t parent = getppid();
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) return 2;
  alarm(2);
  gchar text[257] = {0};
  if (!probe) {
    gsize length = fread(text, 1, sizeof(text) - 1, stdin);
    if (ferror(stdin) || !feof(stdin) || !length || strlen(text) != length ||
        !g_utf8_validate(text, length, NULL) || g_utf8_strlen(text, -1) > 16) return 2;
    for (const gchar *p = text; *p; p = g_utf8_next_char(p))
      if (g_utf8_get_char(p) < 32 || g_utf8_get_char(p) == 127) return 2;
  }
  struct wl_display *display = wl_display_connect(NULL);
  if (!display) return 1;
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &listener, NULL);
  if (wl_display_roundtrip(display) < 0 || !manager || !seat) return 1;
  if (probe) { wl_display_disconnect(display); return 0; }
  /* A–P physical keys, rather than Escape/Tab/Enter/Backspace positions. Each
   * scalar gets an unmodified symbol; no user's keyboard layout is assumed. */
  const uint32_t codes[] = {30,48,46,32,18,33,34,35,23,36,37,38,50,49,24,25};
  GString *map = g_string_new("xkb_keymap { xkb_keycodes { minimum=8; maximum=256;");
  guint count = 0;
  for (const gchar *p = text; *p; p = g_utf8_next_char(p), count++)
    g_string_append_printf(map, "<D%u>=%u;", count, codes[count] + 8);
  g_string_append(map, "}; xkb_types { include \"complete\" }; xkb_compatibility { include \"complete\" }; xkb_symbols {");
  guint index = 0;
  for (const gchar *p = text; *p; p = g_utf8_next_char(p), index++) {
    gchar name[128];
    if (xkb_keysym_get_name(xkb_utf32_to_keysym(g_utf8_get_char(p)), name, sizeof(name)) <= 0) return 2;
    g_string_append_printf(map, "key <D%u> { [ %s ] };", index, name);
  }
  g_string_append(map, "}; };");
  struct xkb_context *context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
  struct xkb_keymap *keymap = xkb_keymap_new_from_string(context, map->str, XKB_KEYMAP_FORMAT_TEXT_V1, XKB_KEYMAP_COMPILE_NO_FLAGS);
  if (!keymap) return 2;
  xkb_keymap_unref(keymap); xkb_context_unref(context);
  int fd = memfd_create("dictaduo-keymap", MFD_CLOEXEC);
  if (fd < 0 || write(fd, map->str, map->len + 1) != (ssize_t)(map->len + 1)) return 1;
  struct zwp_virtual_keyboard_v1 *keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(manager, seat);
  zwp_virtual_keyboard_v1_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, map->len + 1);
  close(fd); g_string_free(map, TRUE);
  zwp_virtual_keyboard_v1_modifiers(keyboard, 0, 0, 0, 0);
  if (wl_display_roundtrip(display) < 0) return 1;
  for (guint i = 0; i < count; i++) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    uint32_t time = (uint32_t)(now.tv_sec * 1000 + now.tv_nsec / 1000000);
    /* Keep down/up together so cancellation cannot strand a pressed key. */
    zwp_virtual_keyboard_v1_key(keyboard, time, codes[i], WL_KEYBOARD_KEY_STATE_PRESSED);
    zwp_virtual_keyboard_v1_key(keyboard, time, codes[i], WL_KEYBOARD_KEY_STATE_RELEASED);
    if (wl_display_roundtrip(display) < 0) return 1;
    g_usleep(1000);
  }
  zwp_virtual_keyboard_v1_destroy(keyboard);
  wl_display_roundtrip(display);
  wl_display_disconnect(display);
  return 0;
}
