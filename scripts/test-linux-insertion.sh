#!/usr/bin/env bash
# Opens temporary fields in the current Hyprland session and restores focus.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${WAYLAND_DISPLAY:?Run in a Wayland desktop session}"
: "${HYPRLAND_INSTANCE_SIGNATURE:?Run in a Hyprland desktop session}"
cd "$ROOT"
mkdir -p "$ROOT/.local"
read -r -a fixture_flags <<< "$(pkg-config --cflags --libs gtk+-3.0)"
cc -O2 -Wall -Wextra -Werror "$ROOT/Clients/Linux/tests/entry-fixture.c" \
  "${fixture_flags[@]}" -o "$ROOT/.local/entry-fixture"
task_dir="$(mktemp -d "${TMPDIR:-/tmp}/dictaduo-insertion.XXXXXX")"
previous_focus="$(hyprctl -j activewindow | jq -r '.address')"
task_bus_pid=""
cleanup() {
  if [[ -n "$task_bus_pid" ]]; then kill "$task_bus_pid" 2>/dev/null || true; fi
  hyprctl dispatch focuswindow "address:$previous_focus" >/dev/null 2>&1 || true
  rm -rf "$task_dir"
}
trap cleanup EXIT
# A private accessibility bus avoids stale session services and never replaces
# the desktop's shared AT-SPI socket, unlike a nested session bus launcher.
cat > "$task_dir/bus.conf" <<EOF
<busconfig>
  <include>/usr/share/defaults/at-spi2/accessibility.conf</include>
  <listen>unix:path=$task_dir/bus</listen>
</busconfig>
EOF
export AT_SPI_BUS_ADDRESS="unix:path=$task_dir/bus"
export GTK_MODULES=atk-bridge
dbus-daemon --config-file="$task_dir/bus.conf" --nofork > "$task_dir/bus.log" 2>&1 &
task_bus_pid=$!
for ((attempt = 0; attempt < 100; attempt++)); do
  [[ -S "$task_dir/bus" ]] && break
  sleep 0.01
done
if [[ ! -S "$task_dir/bus" ]]; then
  cat "$task_dir/bus.log" >&2
  echo "The private accessibility bus did not start." >&2
  exit 1
fi
DICTADUO_TEST_DESKTOP=1 bun test "$ROOT/Clients/Linux/tests/native-destination.test.ts" "$@"
