# A Linux desktop to test Stem in, from a Mac or anywhere Docker runs.
# scripts/linux-test.mjs builds and drives it; see that file for the modes.
#
# The image holds only the system: Node, an X server, the libraries Electron
# and Chromium load, and a VNC/noVNC desktop to watch. The repo is mounted at
# run time, and node_modules, dist and the Playwright browsers live in named
# volumes, so a Mac's native modules never meet this Linux and a rebuild of
# the image does not cost an `npm ci`.
FROM node:24-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth x11-utils fluxbox x11vnc novnc websockify \
      libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libnotify4 libsecret-1-0 libxtst6 \
      xdg-utils dbus-x11 fonts-dejavu-core procps scrot \
      chromium \
    && rm -rf /var/lib/apt/lists/*

# Chromium's own libraries, by the Playwright version the repo pins; the
# browser itself is downloaded into a volume at run time. (Debian's own
# `chromium`, installed above, is the browser a user would have: Stem knows
# /usr/lib/chromium/chromium and will start it; desktop mode uses that one.)
ARG PLAYWRIGHT_VERSION=1.61.0
RUN npx -y playwright@${PLAYWRIGHT_VERSION} install-deps chromium && rm -rf /var/lib/apt/lists/* /root/.npm

COPY entrypoint.sh /usr/local/bin/stem-linux
RUN chmod +x /usr/local/bin/stem-linux
WORKDIR /repo
ENTRYPOINT ["/usr/local/bin/stem-linux"]
