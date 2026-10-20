#!/bin/bash
# Inside the Linux test container (tests/linux/Dockerfile). Started as root only
# to hand the volumes to the `node` user; everything after runs as `node`, the
# way a desktop user runs Stem.
#
#   stem-linux test [playwright args]   the E2E suite under Xvfb
#   stem-linux desktop                  Stem on a desktop you can watch: noVNC on :6080.
#                                       A real Stem (sign in as you would), with Debian's
#                                       chromium to set browser control up in by hand.
#                                       `docker exec -u node -e DISPLAY=:99 stem-linux-desktop scrot /tmp/s.png`
#                                       grabs the whole screen.
#   stem-linux shell                    a shell, set up the same way
set -euo pipefail

if [ "$(id -u)" = 0 ]; then
  mkdir -p /repo/node_modules /repo/dist /home/node/.cache/ms-playwright /home/node/.npm
  chown node:node /repo/node_modules /repo/dist /home/node/.cache /home/node/.cache/ms-playwright /home/node/.npm
  exec runuser -u node -- "$0" "$@"
fi

cd /repo
export HOME=/home/node

# node_modules is a volume: install only when the lockfile changed since last time.
want=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ "$(cat node_modules/.stem-lock 2>/dev/null)" != "$want" ]; then
  echo "stem-linux: npm ci (lockfile changed)"
  npm ci --no-audit --no-fund
  echo "$want" > node_modules/.stem-lock
fi
npx playwright install chromium >/dev/null

mode=${1:-test}
shift || true
case "$mode" in
  test)
    exec xvfb-run -a -s '-screen 0 1440x900x24' npx playwright test "$@"
    ;;
  desktop)
    export DISPLAY=:99
    Xvfb :99 -screen 0 1440x900x24 >/tmp/xvfb.log 2>&1 &
    sleep 1
    fluxbox >/tmp/fluxbox.log 2>&1 &
    x11vnc -display :99 -forever -shared -nopw -quiet -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
    websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
    npx electron-vite build >/tmp/build.log 2>&1
    echo "stem-linux: desktop at http://localhost:6080/vnc.html  (Stem's DevTools port 9223 inside the container)"
    # A fresh throwaway profile every start: this is a test desktop, not a Stem to keep.
    exec dbus-launch --exit-with-session npx electron . --remote-debugging-port=9223
    ;;
  shell)
    exec bash
    ;;
  *)
    echo "usage: stem-linux test [playwright args] | desktop | shell" >&2
    exit 2
    ;;
esac
