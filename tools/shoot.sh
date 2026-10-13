#!/bin/bash
# Renders the README screenshots in a throwaway headless GNOME Shell, with
# fake rbw / op binaries and a fake Clockify API (tools/fixtures), so no real
# vault or account is involved. Writes docs/*.png. Run via `make screenshots`.
set -u
UUID=quick-launcher@julian.falcondev.de
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
SANDBOX=${QL_SANDBOX:-/tmp/quick-launcher-shots}
OUT=${QL_OUT:-$ROOT/docs}
PORT=${QL_CLOCKIFY_PORT:-8765}

# A private bus, or the headless shell would lose org.gnome.Shell to the
# running session and every call below would drive the real desktop.
if [ -z "${QL_PRIVATE_BUS:-}" ]; then
  # The private bus daemon logs every service activation; keep that out of the way.
  QL_PRIVATE_BUS=1 exec dbus-run-session -- "$0" "$@" 2> >(grep -v '^dbus-daemon\[' >&2)
fi

[ -f "$ROOT/dist/metadata.json" ] || { echo "run 'make assets' first"; exit 1; }

rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"/{config,cache,state,fixture-state,data/gnome-shell/extensions}
cp -r "$ROOT/dist" "$SANDBOX/data/gnome-shell/extensions/$UUID"
cp -r "$HERE/driver" "$SANDBOX/data/gnome-shell/extensions/screenshot-driver@quick-launcher"

export XDG_CONFIG_HOME="$SANDBOX/config" XDG_DATA_HOME="$SANDBOX/data"
export XDG_CACHE_HOME="$SANDBOX/cache" XDG_STATE_HOME="$SANDBOX/state"
export QL_FIXTURE_STATE="$SANDBOX/fixture-state"
# Settings go to a throwaway keyfile, never the real dconf database.
export GSETTINGS_BACKEND=keyfile
unset WAYLAND_DISPLAY DISPLAY

gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
gsettings set org.gnome.shell disable-user-extensions false
# No banners, so notifications from the real account (e.g. online accounts) stay out of the shots.
gsettings set org.gnome.desktop.notifications show-banners false
gsettings set org.gnome.shell enabled-extensions "['$UUID', 'screenshot-driver@quick-launcher']"
gsettings set org.gnome.desktop.interface scaling-factor 2
gsettings set org.gnome.desktop.interface accent-color teal
gsettings set org.gnome.desktop.interface color-scheme "${QL_SCHEME:-prefer-dark}"
set_ql() { gsettings --schemadir "$ROOT/dist/schemas" set org.gnome.shell.extensions.quick-launcher "$@"; }
set_ql rbw-path "$HERE/fixtures/rbw"
set_ql op-path "$HERE/fixtures/op"
set_ql onepassword-unlock password
set_ql clockify-api-key screenshot
set_ql clockify-api-url "http://127.0.0.1:$PORT/api/v1"
set_ql onboarding-done true
echo julian@falcondev.de > "$QL_FIXTURE_STATE/rbw-email"

# Fake T3 Code: a state database and a handler for t3code:// links.
mkdir -p "$SANDBOX/t3code" "$SANDBOX/data/applications"
sqlite3 "$SANDBOX/t3code/statev2.sqlite" < "$HERE/fixtures/t3code.sql"
echo screenshot-environment > "$SANDBOX/t3code/environment-id"
printf '[Desktop Entry]\nType=Application\nName=T3 Code\nExec=true %%U\nIcon=%s\nMimeType=x-scheme-handler/t3code;\n' \
  "$( [ -e /usr/share/icons/hicolor/512x512/apps/t3code-nightly.png ] && echo t3code-nightly || echo utilities-terminal)" \
  > "$SANDBOX/data/applications/t3code.desktop"
update-desktop-database "$SANDBOX/data/applications"
set_ql t3code-data-dir "$SANDBOX/t3code"

python3 -I "$HERE/fixtures/clockify.py" "$PORT" &
SERVER_PID=$!
gnome-shell --headless --wayland --no-x11 --virtual-monitor 2800x1800 >"$SANDBOX/shell.log" 2>&1 &
SHELL_PID=$!
trap 'kill $SHELL_PID $SERVER_PID 2>/dev/null; wait 2>/dev/null' EXIT

driver() { gdbus call --session --dest org.gnome.Shell --object-path /qltest --method "qltest.Driver.$1" "${@:2}" >/dev/null; }
keys() { local IFS=,; driver Keys "[$(printf "'%s'," "$@" | sed 's/,$//')]"; }
type_text() { driver Type "$1"; }
shot() {
  driver ShotLauncher "$OUT/$1.png" 48 &&
    magick "$OUT/$1.png" -strip -define png:compression-level=9 "$OUT/$1.png" &&
    echo "wrote docs/$1.png"
}

for _ in $(seq 60); do
  gdbus introspect --session --dest org.gnome.Shell --object-path /qltest 2>/dev/null | grep -q ShotLauncher && break
  sleep 0.5
done
driver HideOverview
sleep 2
mkdir -p "$OUT"

clear_query() { keys Control_L a; keys BackSpace; sleep 0.3; }

# Bitwarden starts unlocked, 1Password locked; a few recently used items.
touch "$QL_FIXTURE_STATE/rbw-unlocked"
set_ql recent "['password:bitwarden:b1', 'emoji:🚀', 'password:bitwarden:b2']"

keys Control_L Shift_L Return
sleep 2
shot root

type_text github
sleep 0.5
shot search
keys Control_L k
sleep 0.4
shot actions
keys Escape
clear_query

type_text "2 min in year"
sleep 0.4
shot calculator
clear_query
type_text "time in tokyo"
sleep 0.4
shot timezone
clear_query

type_text "search t3"
sleep 0.4
keys Return
sleep 1
shot t3code
keys Escape
sleep 0.3
clear_query

type_text standup
sleep 0.4
shot clockify
clear_query

type_text ":rocket"
sleep 0.4
shot emoji
clear_query

type_text "unlock 1pass"
sleep 0.4
keys Return
sleep 0.8
shot unlock
type_text hunter2
keys Return
sleep 1.5
keys Escape

# First run: nothing connected yet, so the launcher opens with Getting Started.
# Then connect Bitwarden (email, self-hosted server, master password) and Clockify from there.
keys Escape
rm -f "$QL_FIXTURE_STATE/rbw-unlocked" "$QL_FIXTURE_STATE/rbw-email"
set_ql clockify-api-key ''
set_ql onepassword-enabled false
set_ql onboarding-done false
sleep 0.5
keys Control_L Shift_L Return
sleep 1.5
shot onboarding
keys Return
sleep 0.8
type_text julian@falcondev.de
keys Return
sleep 0.5
type_text vault.example.com
keys Return
sleep 2
type_text hunter2
keys Return
sleep 1.5
keys Down
keys Down
keys Return
sleep 0.5
type_text screenshot
keys Return
sleep 1.5
keys Escape
keys Escape

echo "--- shell log (extension-relevant lines) ---"
grep -iE "JS ERROR|St-WARNING|quick-launcher" "$SANDBOX/shell.log" | head -15
