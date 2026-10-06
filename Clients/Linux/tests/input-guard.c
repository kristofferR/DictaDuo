/* Exercise physical and synthetic event discrimination without input access. */
#define _GNU_SOURCE
#include <sys/ioctl.h>
static int input_ioctl(int fd, unsigned long request, ...);
#define ioctl input_ioctl
#define main destination_main
#include "../native/destination.c"
#undef main
#undef ioctl
#include <assert.h>
#include <stdarg.h>
static int keyboard_fd = -1;
static gboolean query_fails;
static guint supported_key = KEY_LEFTCTRL;
static guint held_key;
static int input_ioctl(int fd, unsigned long request, ...) {
  va_list args; va_start(args, request); void *value = va_arg(args, void *); va_end(args);
  if (fd != keyboard_fd) return ioctl(fd, request, value);
  if (query_fails) { errno = EIO; return -1; }
  unsigned long *bits = value;
  memset(bits, 0, _IOC_SIZE(request));
  guint key = _IOC_NR(request) == _IOC_NR(EVIOCGKEY(0)) ? held_key : supported_key;
  if (key) bits[key / (8 * sizeof(long))] |= 1UL << (key % (8 * sizeof(long)));
  return 0;
}
int main(void) {
  // No readable evdev keyboard and no callback: pre-existing modifiers are unknown.
  assert(!arm_input() && !input_state_known && !guarding_input);
  const guint modifiers[] = {ATSPI_MODIFIER_SHIFT, ATSPI_MODIFIER_CONTROL, ATSPI_MODIFIER_ALT, ATSPI_MODIFIER_META3};
  for (guint i = 0; i < G_N_ELEMENTS(modifiers); i++) {
    modifiers_known = FALSE; observed_modifiers = 0;
    // Releasing the dictation key must reveal a modifier held before startup.
    key_event(NULL,FALSE,139,0xff67,1U << modifiers[i],NULL,NULL);
    assert(!arm_input() && input_state_known && !guarding_input);
  }
  key_event(NULL,FALSE,139,0xff67,0,NULL,NULL);
  assert(arm_input());
  guarding_input = FALSE;
  key_event(NULL,TRUE,29,0xffe3,0,NULL,NULL);
  assert(!arm_input());
  key_event(NULL,FALSE,29,0xffe3,1U << ATSPI_MODIFIER_CONTROL,NULL,NULL);
  assert(arm_input());
  guarding_input = FALSE;
  key_event(NULL,TRUE,125,0xffeb,0,NULL,NULL);
  assert(!arm_input());
  key_event(NULL,FALSE,125,0xffeb,1U << ATSPI_MODIFIER_META3,NULL,NULL);
  assert(arm_input());
  own_text = g_strdup("æ👋"); typing_pending = TRUE;
  key_event(NULL,TRUE,30,0xe6,0,NULL,NULL); key_event(NULL,FALSE,30,0xe6,0,NULL,NULL);
  key_event(NULL,TRUE,48,0x0101f44b,0,NULL,NULL); key_event(NULL,FALSE,48,0x0101f44b,0,NULL,NULL);
  assert(!invalidated && own_key_index == 2);
  assert(arm_input()); portal_pending = TRUE;
  key_event(NULL,TRUE,900,0xe6,0,NULL,NULL); key_event(NULL,FALSE,900,0xe6,0,NULL,NULL);
  assert(!invalidated && own_key_index == 1);
  typing_pending = FALSE;
  key_event(NULL,TRUE,42,'x',0,NULL,NULL); assert(invalidated);
  invalidated = FALSE; guarding_input = FALSE;
  key_event(NULL,TRUE,42,'x',0,NULL,NULL); assert(!invalidated);
  int fds[2]; assert(!pipe2(fds,O_NONBLOCK|O_CLOEXEC));
  keyboard_fd = fds[0];
  input_fds = g_array_new(FALSE,FALSE,sizeof(int)); g_array_append_val(input_fds,keyboard_fd);
  modifiers_known = FALSE; observed_modifiers = 0;
  supported_key = BTN_LEFT; assert(!arm_input() && !input_state_known);
  supported_key = KEY_LEFTCTRL; assert(arm_input() && input_state_known);
  held_key = KEY_LEFTCTRL; assert(!arm_input() && !guarding_input);
  held_key = 0; query_fails = TRUE; assert(!arm_input() && !input_state_known);
  query_fails = FALSE; assert(arm_input());
  g_array_unref(input_fds); input_fds = NULL;
  struct input_event event = {.type=EV_KEY,.code=KEY_A,.value=1};
  guarding_input=TRUE; assert(write(fds[1],&event,sizeof(event))==sizeof(event));
  physical_event(fds[0],G_IO_IN,NULL); assert(invalidated);
  invalidated=FALSE; event.type=EV_SYN;event.code=SYN_DROPPED;
  assert(write(fds[1],&event,sizeof(event))==sizeof(event));physical_event(fds[0],G_IO_IN,NULL);assert(invalidated);
  close(fds[0]);close(fds[1]);g_free(own_text);return 0;
}
