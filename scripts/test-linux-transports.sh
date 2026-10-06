#!/usr/bin/env bash
# Private Wayland/D-Bus fixtures never read or operate the user's desktop.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p .local
read -r -a destination_flags <<< "$(pkg-config --cflags --libs atspi-2 json-glib-1.0 xkbcommon)"
cc -O2 -Wall -Wextra -Werror Clients/Linux/tests/input-guard.c "${destination_flags[@]}" -o .local/input-guard
.local/input-guard
wayland-scanner server-header Clients/Linux/native/wlr-data-control-unstable-v1.xml build/linux-client/data-control-server.h
wayland-scanner server-header Clients/Linux/native/input-method-unstable-v2.xml build/linux-client/input-method-server.h
read -r -a clipboard_flags <<< "$(pkg-config --cflags --libs wayland-server gio-unix-2.0 json-glib-1.0)"
cc -O2 -Wall -Wextra -Werror -I build/linux-client Clients/Linux/tests/clipboard-fixture.c \
  build/linux-client/data-control.c build/linux-client/input-method.c "${clipboard_flags[@]}" -o .local/clipboard-fixture
wayland-scanner server-header Clients/Linux/native/ext-data-control-v1.xml build/linux-client/ext-data-control-server.h
sed 's/zwlr_data_control/ext_data_control/g;s/data-control-server.h/ext-data-control-server.h/g' \
  Clients/Linux/tests/clipboard-fixture.c > .local/clipboard-ext-fixture.c
cc -O2 -Wall -Wextra -Werror -I build/linux-client .local/clipboard-ext-fixture.c \
  build/linux-client/ext-data-control.c build/linux-client/input-method.c "${clipboard_flags[@]}" -o .local/clipboard-ext-fixture
read -r -a portal_flags <<< "$(pkg-config --cflags --libs gio-unix-2.0)"
cc -O2 -Wall -Wextra -Werror Clients/Linux/tests/portal-fixture.c "${portal_flags[@]}" -o .local/portal-fixture
DICTADUO_TEST_CLIPBOARD=1 DICTADUO_TEST_PORTAL=1 bun test \
  Clients/Linux/tests/wayland-clipboard.test.ts Clients/Linux/tests/portal-keyboard.test.ts Clients/Linux/tests/literal.test.ts
