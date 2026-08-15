# Stem, headless, in a container.
#
# What runs in here is `dist/main/server.js` under plain `node` — the same entry
# scripts/server-boot.mjs has been booting since Phase 1, on the machine it was
# always meant for. There is no Electron in this image and no way for one to get
# in: the production stage installs `--omit=dev`, and electron is a devDependency.
#
# THE ONE RULE FOR node_modules: it is built HERE, never copied from a laptop.
# @huggingface/transformers pulls onnxruntime-node, which ships a compiled .node
# binary per platform+arch — a macOS arm64 build copied into a Linux image loads
# as far as `dlopen` and then dies at the first embedding. `npm ci` inside the
# image resolves the right one because it is running on the right machine.
#
# ARCH. The target is linux/amd64 unless told otherwise, because that is what a
# VPS is unless it says so — Hetzner/DO/Vultr's default plans are all x86_64, and
# an image built on an Apple Silicon Mac would otherwise be arm64 and simply not
# start there. Override it for an arm VPS (Hetzner CAX, Oracle Ampere, a Pi):
#
#   docker compose build --build-arg NODE_IMAGE=node:24-bookworm-slim   # unchanged
#   STEM_PLATFORM=linux/arm64 docker compose build
#
# Building for a platform you are not on goes through QEMU and is slow but works;
# building ON the server is faster and is what the runbook recommends.
#
# Debian slim rather than Alpine, deliberately: onnxruntime-node's prebuilt
# binaries are linked against glibc, and musl has no ABI-compatible answer. The
# saving would be ~50 MB against a base that is already carrying model runtimes.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---- stage 1: the bundle -----------------------------------------------------
#
# electron-vite emits dist/main (the server and its workers), dist/preload and
# dist/renderer. Only the first is reachable from here, but the build is one
# command and splitting it would mean maintaining a second config that could
# drift from the one the desktop is built with.
#
# The two SKIPs are the difference between a two-minute stage and a fifteen-minute
# one. `npm ci` here installs devDependencies because the bundler is one, and two
# of them fetch browsers on install: electron's ~120 MB Chromium and Playwright's
# three engines. The bundler needs electron's *module* to resolve, not its binary,
# and nothing in this image ever runs a test.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# patches/ and scripts/ensure-electron.mjs are named by `postinstall`, so they
# have to exist before `npm ci` rather than with the rest of the source.
COPY package.json package-lock.json ./
COPY patches ./patches
COPY scripts/ensure-electron.mjs ./scripts/ensure-electron.mjs
RUN npm ci --no-audit --no-fund
COPY tsconfig.json electron.vite.config.ts ./
COPY src ./src
COPY scripts ./scripts
# The bundle inlines documentation: stem-guide.ts and friends import
# docs/**/*.md and RELEASE_NOTES.md with `?raw`, so the build stage needs the
# actual files (screenshots stay out via .dockerignore).
COPY docs ./docs
COPY RELEASE_NOTES.md ./
RUN npx electron-vite build

# ---- stage 2: production dependencies ----------------------------------------
#
# A second, clean install rather than pruning the first: `npm prune --omit=dev`
# leaves the devDependency tree's transitive deduplications behind, and this
# image is the thing a person `docker pull`s.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY patches ./patches
COPY scripts/ensure-electron.mjs ./scripts/ensure-electron.mjs
# `postinstall` runs patch-package, which is a devDependency and so is not
# installed by --omit=dev — the bare `npm ci` dies with `patch-package: not
# found`. Skip scripts and apply the patches with a fetched patch-package
# instead: pi-web-access is a production dependency and must ship patched.
# (ensure-electron.mjs is the other postinstall step; it exits 0 immediately
# when electron is absent, which with --omit=dev it always is.)
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
  && npx --yes patch-package@8.0.1

# ---- stage 3: what actually ships --------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tar and ca-certificates: the first is not used by `stem-server export` (it
# writes its own archives) but is what an operator reaches for to look inside
# one, and a container you cannot inspect from is a container you cannot debug.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tar \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json RELEASE_NOTES.md ./

# Where everything lives, spelled out rather than left to the defaults, because
# these paths are the container's contract with docker-compose.yml:
#
#   /var/lib/stem/state   the state root — bind-mounted from the host, backed up
#   /var/lib/stem/models  ~1.4 GB of embedding weights — a named volume, NOT here
#   /run/stem/stem.sock   the only way in, shared with Caddy
#   /run/secrets/stem_key the passphrase, a Compose secret, never in this image
#
# The model cache is pulled OUT of the state root (it would default to
# state/embed-models) on purpose. The weights are identical for everybody and
# re-downloadable; keeping them out of the bind mount is what stops every backup
# and every `rsync` of the state root from carrying a gigabyte of files that
# HuggingFace already has. It is not baked into a layer either — see the note in
# docker-compose.yml on the volume.
# STEM_KEY_FILE is deliberately NOT set: /run/secrets/stem_key is already the
# default that both the headless key wrapper and `stem-server import` look for,
# and setting it would only add a way for the two to be told different things.
ENV STEM_STATE_DIR=/var/lib/stem/state \
    STEM_EMBED_MODELS_DIR=/var/lib/stem/models \
    STEM_SERVER_SOCKET=/run/stem/stem.sock
RUN mkdir -p /var/lib/stem/state /var/lib/stem/models /run/stem

# Root, and said out loud. The state root is a bind mount from the host, so the
# container's uid is the uid that owns the operator's files: running as a
# baked-in non-root uid means every `stem-server import`, every backup and every
# `ls` on the host has to know what that uid was. One machine, one user, one
# Stem — `user:` in docker-compose.yml is there for anyone who disagrees.
#
# It costs less than it looks: the process opens no port (a Unix socket is all it
# binds), and the only other thing in this namespace is its own state.

# No HEALTHCHECK: there is nothing to curl. Caddy in the next container is what
# has an opinion about whether this socket answers, and it says so in its log.
CMD ["node", "dist/main/server.js"]
