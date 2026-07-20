#!/bin/bash
# Expose the launcher on PATH so DE keyboard shortcuts can run `stem --quick-chat`
# (the Wayland summon path; Electron's globalShortcut never fires there).
ln -sf '/opt/Stem/stem' /usr/bin/stem
