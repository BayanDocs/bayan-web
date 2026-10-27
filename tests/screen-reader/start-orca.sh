#!/usr/bin/env bash
# Starts what Orca, the GNOME screen reader, needs on a machine without a desktop, then Orca itself with a debug log of everything it
# speaks: a virtual X display (Xvfb), a D-Bus session and the AT-SPI accessibility bus. Used for WEB-002's screen-reader evidence
# (tests/screen-reader/orca.ts; docs/spikes/WEB-002-report.md). Not part of `pnpm verify`.
#
# Ubuntu 24.04 only, on a machine without a desktop session, such as a container. None of these packages is a dependency of the app
# or its gate. Install them from the Ubuntu archive frozen at a snapshot, so that no package younger than a day can arrive (ADR-0017
# rule 4); this is the snapshot that scripts/dev-setup.sh used (APT_SNAPSHOT) when the evidence was recorded:
#   sudo apt-get update --snapshot 20261003T000000Z
#   sudo apt-get install --no-install-recommends --snapshot 20261003T000000Z orca at-spi2-core dbus-x11 python3-pyatspi xdotool xvfb
# That installs orca 46.1-1ubuntu1, at-spi2-core 2.52.0-1build1, dbus-x11 1.14.10-4ubuntu4.1, python3-pyatspi 2.46.1-1,
# xdotool 1:3.20160805.1-5build1 and xvfb 2:21.1.12-1ubuntu1.8, the versions that produced docs/spikes/WEB-002-evidence/.
# Orca's Python bindings are built for Ubuntu's Python 3.12, which this script uses explicitly.
#
# It refuses to run where it could disturb a person's own screen reader: when DISPLAY is set (a desktop session) or Orca is already
# running. Orca's settings and data go to folders inside the output folder, never to the user's own.
#
# Usage: tests/screen-reader/start-orca.sh <output-folder>
# It writes <output-folder>/env.sh (source it before running orca.ts), orca-debug.log and orca.pid.
set -euo pipefail

out="$(cd "${1:?usage: start-orca.sh <output-folder>}" && pwd)"
display=:99

[ -z "${DISPLAY:-}" ] || {
  echo "DISPLAY is set, so this looks like a desktop session; run this only where no one uses a screen reader (a container)." >&2
  exit 1
}
if pgrep -x orca >/dev/null 2>&1 || pgrep -f '^/usr/bin/python3[.0-9]* /usr/bin/orca' >/dev/null 2>&1; then
  echo "Orca is already running; this script would replace it." >&2
  exit 1
fi

Xvfb "$display" -screen 0 1280x900x24 >/dev/null 2>&1 &
sleep 1
export DISPLAY="$display"
eval "$(dbus-launch --sh-syntax)"
printf "export DISPLAY=%s DBUS_SESSION_BUS_ADDRESS='%s'\n" "$DISPLAY" "$DBUS_SESSION_BUS_ADDRESS" >"$out/env.sh"
/usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
sleep 1

# Orca's own folders, inside the output folder.
export XDG_DATA_HOME="$out/xdg-data" XDG_CONFIG_HOME="$out/xdg-config"
mkdir -p "$XDG_DATA_HOME/orca" "$XDG_CONFIG_HOME"
# Without a speech synthesizer, a "say all" never reports that it finished, and Orca would stay in it; so no say-all on load.
# Everything else is Orca's default configuration.
cat >"$XDG_DATA_HOME/orca/orca-customizations.py" <<'PYTHON'
import orca.settings as settings
settings.sayAllOnLoad = False
PYTHON

/usr/bin/python3.12 /usr/bin/orca --debug-file="$out/orca-debug.log" >"$out/orca-stdout.log" 2>&1 &
echo $! >"$out/orca.pid"
sleep 4
grep -q "SPEECH OUTPUT: 'Screen reader on.'" "$out/orca-debug.log" || {
  echo "Orca did not start; see $out/orca-stdout.log" >&2
  exit 1
}
echo "Orca is running. Source $out/env.sh, then run tests/screen-reader/orca.ts."
