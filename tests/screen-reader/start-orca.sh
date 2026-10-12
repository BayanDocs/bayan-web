#!/usr/bin/env bash
# Starts what Orca, the GNOME screen reader, needs on a machine without a desktop, then Orca itself with a debug log of everything it
# speaks: a virtual X display (Xvfb), a D-Bus session and the AT-SPI accessibility bus. Used for WEB-002's screen-reader evidence
# (tests/screen-reader/orca.ts; docs/spikes/WEB-002-report.md). Not part of `pnpm verify`.
#
# Ubuntu 24.04 only, with these packages from the Ubuntu archive (none of them is a dependency of the app or its gate):
#   sudo apt-get install --no-install-recommends orca at-spi2-core dbus-x11 python3-pyatspi xdotool xvfb
# Orca's Python bindings are built for Ubuntu's Python 3.12, which this script uses explicitly.
#
# Usage: tests/screen-reader/start-orca.sh <output-folder>
# It writes <output-folder>/env.sh (source it before running orca.ts), orca-debug.log and orca.pid.
set -euo pipefail

out="$(cd "${1:?usage: start-orca.sh <output-folder>}" && pwd)"
display=:99

Xvfb "$display" -screen 0 1280x900x24 >/dev/null 2>&1 &
sleep 1
export DISPLAY="$display"
eval "$(dbus-launch --sh-syntax)"
printf "export DISPLAY=%s DBUS_SESSION_BUS_ADDRESS='%s'\n" "$DISPLAY" "$DBUS_SESSION_BUS_ADDRESS" >"$out/env.sh"
/usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
sleep 1

# Without a speech synthesizer, a "say all" never reports that it finished, and Orca would stay in it; so no say-all on load.
# Everything else is Orca's default configuration.
mkdir -p "$HOME/.local/share/orca"
cat >"$HOME/.local/share/orca/orca-customizations.py" <<'PYTHON'
import orca.settings as settings
settings.sayAllOnLoad = False
PYTHON

/usr/bin/python3.12 /usr/bin/orca --replace --debug-file="$out/orca-debug.log" >"$out/orca-stdout.log" 2>&1 &
echo $! >"$out/orca.pid"
sleep 4
grep -q "SPEECH OUTPUT: 'Screen reader on.'" "$out/orca-debug.log" || {
  echo "Orca did not start; see $out/orca-stdout.log" >&2
  exit 1
}
echo "Orca is running. Source $out/env.sh, then run tests/screen-reader/orca.ts."
