# Windows development (experimental)

Stem’s released installers target macOS and Linux. **Windows is a terminal-first
dev port**: you can clone, install, and run from a user account **without admin
rights**, using a portable Node.js zip. Packaging (NSIS/portable exe) is not
included yet.

Personal data still lives outside the clone, under `%APPDATA%\Stem\` (and
`%APPDATA%\Stem Profiles\` for `--fresh` / `--profile=`). Reinstalling Node or
re-cloning the repo does not wipe that folder.

## Portable Node (no admin)

1. Download the **Windows x64** Node.js **24+** binary zip from
   [nodejs.org](https://nodejs.org/) (the zip, not the MSI).
2. Extract somewhere you can write, e.g. `%USERPROFILE%\tools\node-v24.x.x-win-x64`.
3. Put that folder on your **session** PATH (do not need a permanent system PATH):

**cmd.exe (preferred when PowerShell profiles are broken):**

```bat
set PATH=%USERPROFILE%\tools\node-v24.x.x-win-x64;%PATH%
node -v
npm -v
```

**PowerShell — always skip the profile** if `profile.ps1` errors or is blocked:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$env:PATH = \"$env:USERPROFILE\tools\node-v24.x.x-win-x64;$env:PATH\"; node -v; npm -v"
```

Or open a `-NoProfile` shell first, then set PATH for that session.

## Clone and run

```bat
git clone https://github.com/TeleporterGuy/stem.git
cd stem
git checkout feat/windows-dev-port
npm install
npm run preflight
npm run dev
```

If `preflight` says Electron’s binary is missing:

```bat
node node_modules\electron\install.js
```

## Shell Stem uses for `run_command`

On Windows, approved commands run as:

`cmd.exe /d /s /c <command>`

- `/d` disables AutoRun (registry hooks that behave like a login profile).
- Stem does **not** load PowerShell’s `profile.ps1` for the default path.

If you need PowerShell from the agent, ask it to run something like:

```bat
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Write-Output hi"
```

## Smoke checklist

1. `node -v` ≥ 24 and `npm -v` with portable Node on PATH.
2. `npm install` → `npm run preflight` → `npm run dev` opens Stem.
3. Complete onboarding / chat with a provider.
4. Ask Stem to run `echo hello`, `dir`, or `git status` — expect a normal result
   (or an approval card), not a spawn/`zsh` error.
5. Confirm a broken `profile.ps1` did not fire for those default commands.
6. Optional: have Stem run the `-NoProfile` PowerShell one-liner above.
7. Check that `%APPDATA%\Stem\` appears and survives a restart.
8. Memory / search: if hybrid embeddings fail, check the main log for
   `embed-endpoint` / named-pipe errors (FTS-only fallback is safe but weaker).
