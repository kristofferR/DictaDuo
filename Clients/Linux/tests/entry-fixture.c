#include <gtk/gtk.h>
#include <stdio.h>
#include <string.h>
static GtkWidget *entry, *other, *view;
static gboolean multiline;
static gboolean input(GIOChannel *channel, GIOCondition condition, gpointer unused) {
  (void)unused;
  if (!(condition & G_IO_IN)) { gtk_main_quit(); return G_SOURCE_REMOVE; }
  gchar *line = NULL;
  GIOStatus status = g_io_channel_read_line(channel, &line, NULL, NULL, NULL);
  if (status == G_IO_STATUS_EOF || status == G_IO_STATUS_ERROR) {
    g_free(line); gtk_main_quit(); return G_SOURCE_REMOVE;
  }
  if (status != G_IO_STATUS_NORMAL) { g_free(line); return G_SOURCE_CONTINUE; }
  if (g_str_has_prefix(line, "get")) {
    if (multiline) {
      GtkTextBuffer *buffer = gtk_text_view_get_buffer(GTK_TEXT_VIEW(view));
      GtkTextIter start, end;
      gtk_text_buffer_get_bounds(buffer, &start, &end);
      gchar *text = gtk_text_buffer_get_text(buffer, &start, &end, FALSE);
      puts(text); g_free(text);
    } else puts(gtk_entry_get_text(GTK_ENTRY(entry)));
    fflush(stdout);
  }
  else if (g_str_has_prefix(line, "change")) gtk_entry_set_text(GTK_ENTRY(entry), "changed");
  else if (g_str_has_prefix(line, "select")) gtk_editable_select_region(GTK_EDITABLE(entry), 0, 2);
  else if (g_str_has_prefix(line, "caret")) gtk_editable_set_position(GTK_EDITABLE(entry), 0);
  else if (g_str_has_prefix(line, "other")) gtk_widget_grab_focus(other);
  else if (g_str_has_prefix(line, "password")) gtk_entry_set_visibility(GTK_ENTRY(entry), FALSE);
  else if (g_str_has_prefix(line, "web")) atk_object_set_role(gtk_widget_get_accessible(entry), ATK_ROLE_DOCUMENT_WEB);
  else if (g_str_has_prefix(line, "textarea")) {
    multiline = TRUE;
    GtkTextBuffer *buffer = gtk_text_view_get_buffer(GTK_TEXT_VIEW(view));
    gtk_text_buffer_set_text(buffer, "start ", -1);
    gtk_widget_grab_focus(view);
    GtkTextIter end;
    gtk_text_buffer_get_end_iter(buffer, &end);
    gtk_text_buffer_place_cursor(buffer, &end);
  }
  else if (g_str_has_prefix(line, "reset")) {
    multiline = FALSE;
    gtk_entry_set_visibility(GTK_ENTRY(entry), TRUE);
    atk_object_set_role(gtk_widget_get_accessible(entry), ATK_ROLE_ENTRY);
    gtk_entry_set_text(GTK_ENTRY(entry), "start ");
    gtk_widget_grab_focus(entry);
    gtk_editable_select_region(GTK_EDITABLE(entry), 6, 6);
    gtk_editable_set_position(GTK_EDITABLE(entry), 6);
  } else if (g_str_has_prefix(line, "quit")) gtk_main_quit();
  g_free(line);
  return G_SOURCE_CONTINUE;
}
int main(int argc, char **argv) {
  gtk_init(&argc, &argv);
  GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_title(GTK_WINDOW(window), "DictaDuo insertion safety test");
  gtk_window_set_default_size(GTK_WINDOW(window), 440, 160);
  GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
  gtk_container_add(GTK_CONTAINER(window), box);
  gtk_box_pack_start(GTK_BOX(box), gtk_label_new("Temporary DictaDuo test fields. No microphone is open."), FALSE, FALSE, 0);
  entry = gtk_entry_new(); other = gtk_entry_new();
  view = gtk_text_view_new();
  gtk_widget_set_size_request(view, -1, 80);
  gtk_box_pack_start(GTK_BOX(box), entry, FALSE, FALSE, 0);
  gtk_box_pack_start(GTK_BOX(box), other, FALSE, FALSE, 0);
  gtk_box_pack_start(GTK_BOX(box), view, FALSE, FALSE, 0);
  gtk_entry_set_text(GTK_ENTRY(entry), "start ");
  gtk_widget_show_all(window);
  gtk_window_present(GTK_WINDOW(window));
  gtk_widget_grab_focus(entry);
  gtk_editable_select_region(GTK_EDITABLE(entry), 6, 6);
  gtk_editable_set_position(GTK_EDITABLE(entry), 6);
  GIOChannel *channel = g_io_channel_unix_new(0);
  g_io_channel_set_flags(channel, G_IO_FLAG_NONBLOCK, NULL);
  g_io_add_watch(channel, G_IO_IN | G_IO_HUP, input, NULL);
  puts("ready"); fflush(stdout);
  gtk_main();
  g_io_channel_unref(channel);
  return 0;
}
