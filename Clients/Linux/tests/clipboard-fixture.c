/* Minimal private Wayland server. No host clipboard is read or changed. */
#define _GNU_SOURCE
#include <wayland-server.h>
#include <glib-unix.h>
#include <json-glib/json-glib.h>
#include "data-control-server.h"
#include "input-method-server.h"
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
#include <errno.h>
typedef struct { struct wl_resource *resource; GPtrArray *types; } Source;
static struct wl_display *display;
static struct wl_resource *device;
static Source *selected;
static GMainLoop *loop;
static struct wl_resource *input_method;
static GString *literal;
static gchar *pending_literal;
static guint done_count;
static gboolean sensitive, inactive;
static const char *formats[] = {"text/plain;charset=utf-8", "text/html", "image/png", "application/x-empty"};
static const char *contents[] = {"original æøå", "<b>original</b>", "\x89PNG\x00\xff", ""};
static const gsize sizes[] = {15,15,6,0};
static void destroy(struct wl_client *client, struct wl_resource *resource) { (void)client; wl_resource_destroy(resource); }
static void commit_string(struct wl_client *client, struct wl_resource *resource, const char *text) {
  (void)client;(void)resource;g_free(pending_literal);pending_literal=g_strdup(text);
}
static void commit(struct wl_client *client,struct wl_resource *resource,uint32_t serial) {
  (void)client;(void)resource;
  if(serial==done_count&&!sensitive&&!inactive&&pending_literal)g_string_append(literal,pending_literal);
  g_clear_pointer(&pending_literal,g_free);
}
static const struct zwp_input_method_v2_interface method_impl = {.commit_string=commit_string,.commit=commit,.destroy=destroy};
static void method_destroyed(struct wl_resource *resource) {if(input_method==resource)input_method=NULL;}
static void get_method(struct wl_client *client,struct wl_resource *resource,struct wl_resource *seat,uint32_t id) {
  (void)resource;(void)seat;struct wl_resource *method=wl_resource_create(client,&zwp_input_method_v2_interface,1,id);
  wl_resource_set_implementation(method,&method_impl,NULL,method_destroyed);
  if(input_method){zwp_input_method_v2_send_unavailable(method);return;}
  input_method=method;done_count=1;zwp_input_method_v2_send_activate(method);
  zwp_input_method_v2_send_content_type(method,sensitive?64:0,sensitive?8:0);zwp_input_method_v2_send_done(method);
}
static const struct zwp_input_method_manager_v2_interface im_manager_impl = {.get_input_method=get_method,.destroy=destroy};
static void bind_im(struct wl_client *client,void *data,uint32_t version,uint32_t id) {
  (void)data;(void)version;struct wl_resource *resource=wl_resource_create(client,&zwp_input_method_manager_v2_interface,1,id);
  wl_resource_set_implementation(resource,&im_manager_impl,NULL,NULL);
}
static void receive(struct wl_client *client, struct wl_resource *resource, const char *type, int32_t fd) {
  (void)client; Source *source = wl_resource_get_user_data(resource);
  if (source && source->resource) zwlr_data_control_source_v1_send_send(source->resource, type, fd);
  else if (!source) for (guint i=0;i<G_N_ELEMENTS(formats);i++) if (!strcmp(type,formats[i])) { ssize_t n=write(fd,contents[i],sizes[i]); (void)n; }
  close(fd); wl_display_flush_clients(display);
}
static const struct zwlr_data_control_offer_v1_interface offer_impl = { receive, destroy };
static void selection(void) {
  if (!device) return;
  struct wl_resource *offer = wl_resource_create(wl_resource_get_client(device), &zwlr_data_control_offer_v1_interface,1,0);
  wl_resource_set_implementation(offer,&offer_impl,selected,NULL);
  zwlr_data_control_device_v1_send_data_offer(device,offer);
  if (selected) for(guint i=0;i<selected->types->len;i++) zwlr_data_control_offer_v1_send_offer(offer,g_ptr_array_index(selected->types,i));
  else for(guint i=0;i<G_N_ELEMENTS(formats);i++) zwlr_data_control_offer_v1_send_offer(offer,formats[i]);
  zwlr_data_control_device_v1_send_selection(device,offer); wl_display_flush_clients(display);
}
static void source_destroyed(struct wl_resource *resource) { Source *source=wl_resource_get_user_data(resource); source->resource=NULL; }
static void offer_type(struct wl_client *client, struct wl_resource *resource, const char *type) {
  (void)client; Source *source=wl_resource_get_user_data(resource); g_ptr_array_add(source->types,g_strdup(type));
}
static const struct zwlr_data_control_source_v1_interface source_impl = {offer_type,destroy};
static void create_source(struct wl_client *client,struct wl_resource *resource,uint32_t id) {
  (void)resource; Source *source=g_new0(Source,1); source->types=g_ptr_array_new_with_free_func(g_free);
  source->resource=wl_resource_create(client,&zwlr_data_control_source_v1_interface,1,id);
  wl_resource_set_implementation(source->resource,&source_impl,source,source_destroyed);
}
static void set_selection(struct wl_client *client,struct wl_resource *resource,struct wl_resource *value) {
  (void)client;(void)resource;
  if(selected && selected->resource) zwlr_data_control_source_v1_send_cancelled(selected->resource);
  selected=value?wl_resource_get_user_data(value):NULL; selection();
}
static const struct zwlr_data_control_device_v1_interface device_impl = {set_selection,destroy,NULL};
static void device_destroyed(struct wl_resource *resource) { if(device==resource)device=NULL; }
static void get_device(struct wl_client *client,struct wl_resource *resource,uint32_t id,struct wl_resource *seat) {
  (void)resource;(void)seat;device=wl_resource_create(client,&zwlr_data_control_device_v1_interface,1,id);
  wl_resource_set_implementation(device,&device_impl,NULL,device_destroyed);selection();
}
static const struct zwlr_data_control_manager_v1_interface manager_impl = {create_source,get_device,destroy};
static void bind_manager(struct wl_client *client,void *data,uint32_t version,uint32_t id) {
  (void)data;(void)version;struct wl_resource *resource=wl_resource_create(client,&zwlr_data_control_manager_v1_interface,1,id);
  wl_resource_set_implementation(resource,&manager_impl,NULL,NULL);
}
static void bind_seat(struct wl_client *client,void *data,uint32_t version,uint32_t id) {
  (void)data;(void)version;wl_resource_create(client,&wl_seat_interface,1,id);
}
static gboolean dispatch(gint fd,GIOCondition condition,gpointer data) {
  (void)fd;(void)condition;(void)data;wl_event_loop_dispatch(wl_display_get_event_loop(display),0);wl_display_flush_clients(display);return G_SOURCE_CONTINUE;
}
static gboolean input(GIOChannel *channel,GIOCondition condition,gpointer data) {
  (void)data;gchar *line=NULL;
  if(!(condition&G_IO_IN)||g_io_channel_read_line(channel,&line,NULL,NULL,NULL)!=G_IO_STATUS_NORMAL) {g_free(line);g_main_loop_quit(loop);return G_SOURCE_REMOVE;}
  if(g_str_has_prefix(line,"literal")) {gchar *encoded=g_base64_encode((const guchar *)literal->str,literal->len);puts(encoded);g_free(encoded);}
  else if(g_str_has_prefix(line,"protected")) {
    sensitive=TRUE;if(input_method){zwp_input_method_v2_send_content_type(input_method,64,8);zwp_input_method_v2_send_done(input_method);done_count++;}puts("protected");
  } else if(g_str_has_prefix(line,"inactive")) {
    inactive=TRUE;if(input_method){zwp_input_method_v2_send_deactivate(input_method);zwp_input_method_v2_send_done(input_method);done_count++;}puts("inactive");
  } else if(g_str_has_prefix(line,"external")) {
    if(selected&&selected->resource)zwlr_data_control_source_v1_send_cancelled(selected->resource);
    selected=NULL;selection();puts("external");
  } else {
    g_strchomp(line);int fds[2];pipe2(fds,O_NONBLOCK|O_CLOEXEC);
    if(selected&&selected->resource)zwlr_data_control_source_v1_send_send(selected->resource,line,fds[1]);
    else for(guint i=0;i<G_N_ELEMENTS(formats);i++)if(!strcmp(line,formats[i])) {ssize_t n=write(fds[1],contents[i],sizes[i]);(void)n;}
    close(fds[1]);wl_display_flush_clients(display);
    GByteArray *bytes=g_byte_array_new();gint64 until=g_get_monotonic_time()+2000000;
    while(g_get_monotonic_time()<until) {
      guint8 block[4096];ssize_t n=read(fds[0],block,sizeof(block));if(n==0)break;
      if(n>0)g_byte_array_append(bytes,block,n);
      else if(errno!=EAGAIN&&errno!=EINTR)break;
      wl_event_loop_dispatch(wl_display_get_event_loop(display),1);wl_display_flush_clients(display);
    }
    close(fds[0]);gchar *encoded=g_base64_encode(bytes->data,bytes->len);puts(encoded);g_free(encoded);g_byte_array_unref(bytes);
  }
  fflush(stdout);g_free(line);return G_SOURCE_CONTINUE;
}
int main(void) {
  literal=g_string_new("");
  display=wl_display_create();wl_global_create(display,&wl_seat_interface,1,NULL,bind_seat);
  wl_global_create(display,&zwlr_data_control_manager_v1_interface,1,NULL,bind_manager);
  wl_global_create(display,&zwp_input_method_manager_v2_interface,1,NULL,bind_im);
  const char *socket=wl_display_add_socket_auto(display);if(!socket)return 1;
  loop=g_main_loop_new(NULL,FALSE);g_unix_fd_add(wl_event_loop_get_fd(wl_display_get_event_loop(display)),G_IO_IN,dispatch,NULL);
  GIOChannel *channel=g_io_channel_unix_new(0);g_io_add_watch(channel,G_IO_IN|G_IO_HUP,input,NULL);
  puts(socket);fflush(stdout);g_main_loop_run(loop);wl_display_destroy_clients(display);wl_display_destroy(display);return 0;
}
