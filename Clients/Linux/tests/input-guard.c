/* Exercise physical and synthetic event discrimination without input access. */
#define _GNU_SOURCE
#define main destination_main
#include "../native/destination.c"
#undef main
#include <assert.h>
int main(void) {
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
  struct input_event event = {.type=EV_KEY,.code=KEY_A,.value=1};
  guarding_input=TRUE; assert(write(fds[1],&event,sizeof(event))==sizeof(event));
  physical_event(fds[0],G_IO_IN,NULL); assert(invalidated);
  invalidated=FALSE; event.type=EV_SYN;event.code=SYN_DROPPED;
  assert(write(fds[1],&event,sizeof(event))==sizeof(event));physical_event(fds[0],G_IO_IN,NULL);assert(invalidated);
  close(fds[0]);close(fds[1]);g_free(own_text);return 0;
}
