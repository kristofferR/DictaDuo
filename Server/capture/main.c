#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <libusb.h>
#include <pipewire/pipewire.h>
#include <signal.h>
#include <spa/param/audio/format-utils.h>
#include <sys/prctl.h>
#include <time.h>
#include <unistd.h>
#include "audio.h"

#define CAPTURE_STARTUP_TIMEOUT_SECONDS 5

/* stdout is a bounded, nonblocking pipe. A slow consumer fails the take instead
 * of blocking PipeWire or silently discarding samples. Never print PCM/errors. */
static bool output(const void *bytes, size_t size) {
    while (size) {
        ssize_t n = write(STDOUT_FILENO, bytes, size);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return false;
        bytes = (const char *)bytes + n;
        size -= n;
    }
    return true;
}
static bool packet(void *unused, unsigned type, const void *bytes, unsigned size) {
    (void)unused;
    uint32_t header[] = { htole32(type), htole32(size) };
    return output(header, sizeof(header)) && output(bytes, size);
}
static double boot_time(void) {
    struct timespec time;
    clock_gettime(CLOCK_BOOTTIME, &time);
    return time.tv_sec + time.tv_nsec / 1e9;
}
static uint64_t number(const char *s, uint64_t max) {
    char *end;
    unsigned long long n = strtoull(s, &end, 10);
    if (!*s || *end || !n || n > max) exit(2);
    return n;
}

struct capture {
    struct pw_main_loop *loop;
    struct pw_stream *stream;
    struct audio_converter audio;
    uint64_t serial;
    uint32_t target;
    bool found, ready, retain, stopped, failed, formatted;
    double started, tick, last_audio;
};
static void fail(struct capture *c) {
    c->failed = true;
    pw_main_loop_quit(c->loop);
}
static void state_changed(void *context, enum pw_stream_state old, enum pw_stream_state state, const char *error) {
    (void)old; (void)error;
    struct capture *c = context;
    if (state == PW_STREAM_STATE_ERROR || (c->ready && state != PW_STREAM_STATE_STREAMING)) fail(c);
}
static void format_changed(void *context, uint32_t id, const struct spa_pod *param) {
    struct capture *c = context;
    if (id != SPA_PARAM_Format) return;
    struct spa_audio_info_raw format = {0};
    if (!param || spa_format_audio_raw_parse(param, &format) < 0 ||
        format.format != SPA_AUDIO_FORMAT_F32_LE || format.rate != c->audio.rate ||
        format.channels != c->audio.channels) { fail(c); return; }
    c->formatted = true;
}
static void process(void *context) {
    struct capture *c = context;
    struct pw_buffer *p = pw_stream_dequeue_buffer(c->stream);
    if (!p) return;
    struct spa_buffer *b = p->buffer;
    struct spa_data *d = b->n_datas == 1 ? &b->datas[0] : NULL;
    unsigned stride = c->audio.channels * 4;
    struct spa_meta_header *h = spa_buffer_find_meta_data(b, SPA_META_Header, sizeof(*h));
    bool valid = c->found && c->formatted && d && d->data && d->chunk &&
        d->chunk->offset <= d->maxsize && d->chunk->size <= d->maxsize - d->chunk->offset &&
        d->chunk->stride == (int)stride && d->chunk->size % stride == 0 &&
        !(d->chunk->flags & SPA_CHUNK_FLAG_CORRUPTED) &&
        !(h && (h->flags & (SPA_META_HEADER_FLAG_CORRUPTED | (c->ready ? SPA_META_HEADER_FLAG_DISCONT : 0))));
    if (!valid) fail(c);
    else if (d->chunk->size) {
        c->last_audio = boot_time();
        if (!c->ready) {
            c->ready = true;
            if (!packet(NULL, 3, NULL, 0)) fail(c);
        }
        const float *samples = SPA_PTROFF(d->data, d->chunk->offset, const float);
        unsigned frames = d->chunk->size / stride;
        while (frames && !c->failed) {
            unsigned n = SPA_MIN(frames, AUDIO_BLOCK);
            if (!audio_push(&c->audio, samples, n, c->retain)) fail(c);
            frames -= n;
            samples += n * c->audio.channels;
        }
    }
    pw_stream_queue_buffer(c->stream, p);
}
static const struct pw_stream_events stream_events = {
    PW_VERSION_STREAM_EVENTS, .state_changed = state_changed,
    .param_changed = format_changed, .process = process,
};
static void global(void *context, uint32_t id, uint32_t permissions, const char *type, uint32_t version, const struct spa_dict *props) {
    (void)permissions; (void)version;
    struct capture *c = context;
    if (!props) return;
    if (!strcmp(type, PW_TYPE_INTERFACE_Node)) {
        const char *serial = spa_dict_lookup(props, PW_KEY_OBJECT_SERIAL);
        const char *media = spa_dict_lookup(props, PW_KEY_MEDIA_CLASS);
        if (serial && strtoull(serial, NULL, 10) == c->serial && media && !strcmp(media, "Audio/Source")) {
            c->target = id;
            c->found = true;
        }
    } else if (!strcmp(type, PW_TYPE_INTERFACE_Link)) {
        const char *input = spa_dict_lookup(props, PW_KEY_LINK_INPUT_NODE);
        const char *out = spa_dict_lookup(props, PW_KEY_LINK_OUTPUT_NODE);
        if (input && out && c->stream && strtoul(input, NULL, 10) == pw_stream_get_node_id(c->stream) &&
            (!c->found || strtoul(out, NULL, 10) != c->target)) fail(c);
    }
}
static void removed(void *context, uint32_t id) {
    struct capture *c = context;
    if (c->found && id == c->target) fail(c);
}
static const struct pw_registry_events registry_events = {
    PW_VERSION_REGISTRY_EVENTS, .global = global, .global_remove = removed,
};
static void core_error(void *context, uint32_t id, int seq, int res, const char *message) {
    (void)id; (void)seq; (void)res; (void)message;
    fail(context);
}
static const struct pw_core_events core_events = { PW_VERSION_CORE_EVENTS, .error = core_error };
static void control(void *context, int fd, uint32_t mask) {
    (void)mask;
    struct capture *c = context;
    char command;
    if (read(fd, &command, 1) == 1 && command == 's' && c->ready) {
        c->stopped = true;
        pw_main_loop_quit(c->loop);
    } else fail(c);
}
static void watchdog(void *context, uint64_t expirations) {
    (void)expirations;
    struct capture *c = context;
    double now = boot_time();
    if (now - c->tick > 2 ||
        (!c->ready && now - c->started > CAPTURE_STARTUP_TIMEOUT_SECONDS) ||
        (c->ready && now - c->last_audio > 1)) fail(c);
    c->tick = now;
}
static int capture(char **args) {
    struct capture c = { .serial = number(args[0], UINT64_MAX),
        .retain = !strcmp(args[3], "1"), .audio = {
            .rate = number(args[1], 192000), .channels = number(args[2], 8), .emit = packet } };
    if (c.audio.rate < 8000 || (strcmp(args[3], "0") && strcmp(args[3], "1"))) return 2;
    int error;
    c.audio.state = src_new(SRC_SINC_FASTEST, 1, &error);
    if (!c.audio.state) return 1;
    pw_init(NULL, NULL);
    c.loop = pw_main_loop_new(NULL);
    if (!c.loop) return 1;
    struct pw_loop *loop = pw_main_loop_get_loop(c.loop);
    struct pw_context *context = pw_context_new(loop, NULL, 0);
    struct pw_core *core = context ? pw_context_connect(context, NULL, 0) : NULL;
    if (!core) return 1;
    struct spa_hook core_listener, registry_listener, stream_listener;
    pw_core_add_listener(core, &core_listener, &core_events, &c);
    struct pw_registry *registry = pw_core_get_registry(core, PW_VERSION_REGISTRY, 0);
    pw_registry_add_listener(registry, &registry_listener, &registry_events, &c);
    c.stream = pw_stream_new(core, "SottoDuo capture", pw_properties_new(
        PW_KEY_MEDIA_TYPE, "Audio", PW_KEY_MEDIA_CATEGORY, "Capture", PW_KEY_MEDIA_ROLE, "Communication",
        PW_KEY_TARGET_OBJECT, args[0], PW_KEY_NODE_DONT_RECONNECT, "true",
        "node.dont-fallback", "true", "node.dont-move", "true", "resample.disable", "true",
        "stream.dont-remix", "true", PW_KEY_NODE_LATENCY, "480/48000", NULL));
    if (!c.stream) return 1;
    pw_stream_add_listener(c.stream, &stream_listener, &stream_events, &c);
    uint8_t buffer[1024];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    struct spa_audio_info_raw format = { .format = SPA_AUDIO_FORMAT_F32_LE,
        .rate = c.audio.rate, .channels = c.audio.channels };
    if (format.channels == 1) format.position[0] = SPA_AUDIO_CHANNEL_MONO;
    else if (format.channels == 2) { format.position[0] = SPA_AUDIO_CHANNEL_FL; format.position[1] = SPA_AUDIO_CHANNEL_FR; }
    else format.flags = SPA_AUDIO_FLAG_UNPOSITIONED;
    const struct spa_pod *params[] = { spa_format_audio_raw_build(&builder, SPA_PARAM_EnumFormat, &format) };
    if (pw_stream_connect(c.stream, PW_DIRECTION_INPUT, PW_ID_ANY,
        PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS | PW_STREAM_FLAG_DONT_RECONNECT,
        params, 1) < 0) return 1;
    struct spa_source *input = pw_loop_add_io(loop, STDIN_FILENO, SPA_IO_IN | SPA_IO_HUP, false, control, &c);
    struct spa_source *timer = pw_loop_add_timer(loop, watchdog, &c);
    struct timespec interval = { .tv_nsec = 100000000 };
    pw_loop_update_timer(loop, timer, &interval, &interval, false);
    c.started = c.tick = boot_time();
    pw_main_loop_run(c.loop);
    /* Close hardware before draining the converter. No new audio can enter. */
    spa_hook_remove(&stream_listener);
    pw_stream_destroy(c.stream);
    pw_loop_destroy_source(loop, input);
    pw_loop_destroy_source(loop, timer);
    bool success = c.stopped && !c.failed && audio_flush(&c.audio, true) && packet(NULL, 4, NULL, 0);
    src_delete(c.audio.state);
    pw_proxy_destroy((struct pw_proxy *)registry);
    pw_core_disconnect(core);
    pw_context_destroy(context);
    pw_main_loop_destroy(c.loop);
    pw_deinit();
    return success ? 0 : 1;
}
static int status(char **args) {
    unsigned bus = number(args[0], 255), address = number(args[1], 127);
    libusb_context *context = NULL;
    libusb_device **devices = NULL;
    libusb_device_handle *handle = NULL;
    if (libusb_init(&context)) return 1;
    ssize_t count = libusb_get_device_list(context, &devices);
    for (ssize_t i = 0; i < count; i++) {
        struct libusb_device_descriptor d;
        if (libusb_get_bus_number(devices[i]) == bus && libusb_get_device_address(devices[i]) == address &&
            !libusb_get_device_descriptor(devices[i], &d) && d.idVendor == 0x2ca3 && d.idProduct == 0x4011)
            libusb_open(devices[i], &handle);
    }
    if (devices) libusb_free_device_list(devices, 1);
    int result = 1;
    if (handle && !libusb_claim_interface(handle, 6)) {
        /* Spontaneous bulk-IN only: no USB writes, driver detach, pairing or resets. */
        double previous = boot_time();
        for (;;) {
            unsigned char bytes[512];
            int received = 0;
            int error = libusb_bulk_transfer(handle, 0x86, bytes, sizeof(bytes), &received, 500);
            double now = boot_time();
            if (now - previous > 2 || (error && error != LIBUSB_ERROR_TIMEOUT) ||
                (received && !output(bytes, received))) break;
            previous = now;
        }
        libusb_release_interface(handle, 6);
    }
    if (handle) libusb_close(handle);
    libusb_exit(context);
    return result;
}
int main(int argc, char **argv) {
    pid_t parent = getppid();
    const char *expected = getenv("SOTTODUO_CAPTURE_PARENT_PID");
    if (expected && number(expected, INT32_MAX) != (uint64_t)parent) return 1;
    if (parent <= 1 || prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) return 1;
    unsetenv("PIPEWIRE_PROPS");
    unsetenv("PIPEWIRE_NODE");
    unsetenv("PIPEWIRE_AUTOCONNECT");
    signal(SIGPIPE, SIG_IGN);
    if (fcntl(STDOUT_FILENO, F_SETFL, fcntl(STDOUT_FILENO, F_GETFL) | O_NONBLOCK) < 0) return 1;
    if (argc == 6 && !strcmp(argv[1], "capture")) return capture(argv + 2);
    if (argc == 4 && !strcmp(argv[1], "status")) return status(argv + 2);
    fputs("Usage: sottoduo-capture capture SERIAL RATE CHANNELS RETAIN | status USB_BUS USB_ADDRESS\n", stderr);
    return 2;
}
