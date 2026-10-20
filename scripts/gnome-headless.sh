#!/bin/bash
# Runs a command inside a private, headless GNOME Shell that has Stem's
# computer-control extension loaded (native/linux/gnome-extension, from the
# tree this script sits in) and a working accessibility bus — the setup
# computer control needs, without touching the person's own session:
#
#   - its own D-Bus session (dbus-run-session), runtime, config, data and cache
#     folders under /tmp/stem-gnome;
#   - GSETTINGS_BACKEND=keyfile, so no setting is ever written to the person's
#     dconf database (the private bus would otherwise reach their real one);
#   - everything it started is stopped when the command ends.
#
# Used by `scripts/linux-pc.mjs gnome-e2e|gnome-sh`. Inside, WAYLAND_DISPLAY
# points at the shell and XDG_CURRENT_DESKTOP=GNOME, so the Linux helper and
# Electron behave as in a real GNOME Wayland session.
set -u
root=/tmp/stem-gnome
repo=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${STEM_GNOME_INNER:-}" ]; then
  rm -rf "$root"
  mkdir -p "$root/config" "$root/data/gnome-shell/extensions" "$root/cache" "$root/run"
  chmod 700 "$root/run"
  ln -s "$repo/native/linux/gnome-extension/stem-computer@awantech.sk" "$root/data/gnome-shell/extensions/"
  export XDG_CONFIG_HOME=$root/config XDG_DATA_HOME=$root/data XDG_CACHE_HOME=$root/cache XDG_RUNTIME_DIR=$root/run
  export GSETTINGS_BACKEND=keyfile STEM_GNOME_INNER=1
  unset DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS
  exec dbus-run-session -- "$0" "$@"
fi
[ "$GSETTINGS_BACKEND" = keyfile ] || { echo "gnome-headless: refusing to run off the keyfile settings backend" >&2; exit 1; }
gsettings set org.gnome.shell enabled-extensions "['stem-computer@awantech.sk']"
gsettings set org.gnome.shell disable-user-extensions false
# D-Bus activation cannot start the accessibility daemons inside a
# dbus-run-session here (exec is denied), so they are started by hand.
/usr/libexec/at-spi-bus-launcher --launch-immediately >"$root/a11y.log" 2>&1 &
for _ in $(seq 50); do gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.a11y.Bus.GetAddress >/dev/null 2>&1 && break; sleep 0.1; done
/usr/libexec/at-spi2-registryd >>"$root/a11y.log" 2>&1 &
gnome-shell --headless --wayland --no-x11 --virtual-monitor 1440x900 --wayland-display=stem-gnome >"$root/shell.log" 2>&1 &
for _ in $(seq 100); do
  gdbus call --session --dest org.gnome.Shell --object-path /sk/awantech/StemComputer --method sk.awantech.StemComputer.Version >/dev/null 2>&1 && break
  sleep 0.2
done
export WAYLAND_DISPLAY=stem-gnome XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME
"$@"
status=$?
for p in $(pgrep -u "$(id -u)"); do
  [ "$p" = "$$" ] && continue
  tr '\0' '\n' <"/proc/$p/environ" 2>/dev/null | grep -q "^XDG_CONFIG_HOME=$root/config\$" && kill "$p" 2>/dev/null
done 2>/dev/null
exit $status
