# TEMP — Pi security gate (Stem-style) for Pendant + GLM

**This folder is temporary.** Copy it out of Stem into your work Pi/Pendant setup,
then delete this directory (and the PR branch) from Stem.

## What this is

Instructions + a starter Pi extension that mirrors Stem’s command-approval
pipeline:

1. **Allowlist** — known-safe prefixes auto-run  
2. **LLM judge** — same chat model (your GLM 5.2) classifies `safe` / `unsafe` / `unsure` with a short reason  
3. **User card** — Pendant/`ctx.ui.select` asks Allow once / Always allow / Deny, showing the verdict + reason  

## Target stack (as specified)

| Piece | Choice |
| --- | --- |
| Host UI | Pendant **0.26** (VS Code / Cursor) |
| Runtime | Pi coding agent (bundled or BYO) |
| Model | Local **GLM 5.2** for chat *and* judge |
| Shell | **bash on Windows** (Git Bash / MSYS / WSL bash — not `cmd.exe`) |

## Files

| Path | Purpose |
| --- | --- |
| `IMPLEMENTATION.md` | Step-by-step instructions **for your Pi agent** to implement/install this |
| `extension-sketch/` | Starter extension source to copy into `~/.pi/agent/extensions/` |
| `STEM-REFERENCE.md` | Pointers into Stem’s real implementation (for comparison only) |

## Quick start (human)

1. Copy `_temp/pi-security-gate/` somewhere outside Stem.  
2. Open your work workspace in Pendant and paste `IMPLEMENTATION.md` to Pi as the task.  
3. After it works, remove this folder from Stem.

## Important

- The LLM judge is a **convenience**, not a security boundary. Deny/timeout must fail closed.  
- Do **not** install `@fgladisch/pi-bash-approval` *and* this extension together — you would get double prompts. Pick one pipeline.  
- Pendant 0.26 loads Pi extensions and supports `ui.select` / `ui.confirm` (with notifications). Prefer `ui.select` over interactive slash commands (Pendant may refuse interactive slash commands from extensions).
