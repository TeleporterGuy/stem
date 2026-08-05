# IMPLEMENTATION — Stem-style bash security gate for Pi + Pendant

You are implementing a **command security gate** for Pi, used from **Pendant 0.26**
on **Windows with bash**, with **GLM 5.2** as both the chat model and the safety
judge.

Copy the starter under `extension-sketch/` into the user’s Pi extensions folder,
then finish and wire it up. Prefer editing the sketch over inventing a new layout.

---

## Goal (what “done” looks like)

When Pi’s `bash` tool is about to run a command:

1. If every chain segment matches a **static or learned allowlist** → run immediately.
2. Else call **GLM 5.2 once** with a one-word classification prompt (`safe` / `unsafe` / `unsure` + short reason), using the **current user request** as intent when available.
3. If the judge says `safe` → run.
4. If `unsafe`, `unsure`, or the judge **fails/times out** → show a Pendant/Pi UI prompt that **explains why**, shows the full command + cwd, and offers:
   - **Allow once**
   - **Always allow** (persist learnable prefix(es) to the allowlist file)
   - **Deny**
5. Cancel / no UI / print mode → **block** (fail closed).

This mirrors Stem’s assisted mode (`allowlist → LLM judge → approval card`).

---

## How Pi + Pendant fit together (do not invent a VS Code extension)

Pendant is a **UI host** for Pi. Command interception belongs in a **Pi extension**,
not in Pendant settings.

| Mechanism | Where |
| --- | --- |
| Intercept `bash` before spawn | Pi `tool_call` event |
| Ask the user | `ctx.ui.select(...)` (works in Pendant RPC; Pendant notifies on `select`/`input`) |
| Call GLM for the judge | `complete()` from `@earendil-works/pi-ai` (or the package name your Pi install exposes — check imports in existing extensions) with `ctx.model` + `ctx.modelRegistry.getApiKeyAndHeaders(model)` |
| Persist allowlist | File under `~/.pi/agent/` (e.g. `.security-gate-allowlist`) |

Official references (read if unsure):

- Pi extensions: https://pi.dev/docs/latest/extensions  
- Especially: `tool_call`, `ctx.ui.select` / `confirm`, `ctx.hasUI`, `complete()` examples (`handoff.ts`, `custom-compaction.ts`)  
- Pi example close to tier-3 only: `permission-gate.ts` in Pi’s `examples/extensions/`  
- Existing allowlist-only package (do **not** combine with this): `@fgladisch/pi-bash-approval`  
- Pendant 0.26: loads Pi skills/extensions; notifies on extension `ui.select`/`ui.input`; interactive **slash** commands from extensions may be unsupported — keep slash commands **text-only** (list/reload) or skip them

---

## Placement

Install as a global Pi extension:

```text
~/.pi/agent/extensions/security-gate/
  package.json          # optional; needed if you add deps
  index.ts              # default export function (pi) { ... }
  policy.ts             # parse / classify / judge prompt / verdict parse
  allowlist.ts          # load/save learned prefixes
```

On Windows the home path is typically `%USERPROFILE%\.pi\agent\extensions\...`
(Git Bash: `~/.pi/agent/extensions/...`).

If discovery is disabled in Pendant, add the path via Pendant / Pi settings
(`extensions` array or `pi.extraExtensions`). Prefer auto-discovery first.

After install: **Reload Pi config** from Pendant so the extension loads.

---

## Pipeline to implement

```text
bash tool_call
    │
    ├─ empty command? → block
    │
    ├─ Tier 1: classify(command, allowlist)
    │     every segment allowlisted AND no hard shell meta → ALLOW
    │
    ├─ Tier 2: LLM judge (same ctx.model = GLM 5.2)
    │     verdict == safe → ALLOW
    │     fail / timeout / empty → treat as unsure (escalate)
    │
    └─ Tier 3: ctx.ui.select(...)
          allow once → ALLOW
          always allow → append prefixes, then ALLOW
          deny / cancel / !hasUI → BLOCK { block: true, reason }
```

### Shell parsing rules (Windows + **bash**)

Model **bash** quoting (POSIX), **not** `cmd.exe`.

Stem’s Windows/`cmd.exe` parser is the wrong grammar here. Use POSIX rules:

- Split chains on `&&`, `||`, `|`, `;`, newlines.
- Lone `&` (background), redirects `>` `<`, `$`, `` ` ``, `( )`, `{ }`, `\` outside quotes → `hasShellMeta` → **never** tier-1; go to judge/approval.
- Inside single quotes: no meta.
- Inside double quotes: still flag `$`, `` ` ``, `\`.
- Unterminated quote → treat as meta.
- Every chained segment must clear the allowlist for tier-1 auto-run.
- Command words with path separators (`./git`, `/usr/bin/rm`) must **not** match a bare allowlisted `git` / `rm`.

Starter logic is in `extension-sketch/policy.ts` — keep it pure and unit-testable if you add tests.

### Static allowlist (seed)

Start conservative (read-mostly), POSIX names:

`ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `which`, `file`, `stat`, `date`,  
`git status`, `git log`, `git diff`, `git show`, `git branch`

Plus whatever the user already trusts at work. Prefer narrow prefixes (`git status`) over wide ones (`git`).

Learned rules: store one prefix per line in `~/.pi/agent/.security-gate-allowlist`
(same idea as Stem’s `exec.allowlist` / pi-bash-approval’s `.bash-approval`).

Suggested “Always allow” learnable form: first token, or `word sub` when the second token is a bare word (`git status`, `npm test`).

### Judge (same GLM 5.2)

- Use **`ctx.model`** (active Pendant model). Do not hardcode a cloud “cheap” model.
- Call `complete(model, { messages: [...] }, { apiKey, headers, signal, maxTokens: small })`.
- Timeout: ~30–60s; on abort/error → escalate to UI with a human reason (“did not answer in time” / “no model available”).
- Reply contract: **one line**, first word `safe` | `unsafe` | `unsure`, optional short reason.
- Parse fail-safe: unrecognized text → `unsure`.
- Match order: test `unsafe` before `safe` (because “unsafe” contains “safe”).

**Intent:** pull the latest user message text from `ctx.sessionManager` (branch / context entries). Truncate (~800 chars). If missing, say so in the prompt and judge the command alone.

**Shell label in the prompt:** say the command will run under **bash on Windows** (Git Bash / user’s bash), not cmd.exe.

Use the prompt in `extension-sketch/policy.ts` (`buildJudgePrompt`) — it is adapted from Stem’s `src/main/exec/policy.ts`.

### Approval UI (Pendant-friendly)

Prefer `ctx.ui.select` with clear labels, e.g.:

```text
Title: Run this command?
Body (message / option labels must include):
  - Verdict line: "Safety check flagged this as potentially unsafe: <reason>"
    or "could not tell…", or "safety check could not run: <why>"
  - Command (full string)
  - cwd
Options:
  - Allow once
  - Always allow “git push”   // only if prefixes.length > 0
  - Deny
```

If `!ctx.hasUI`, block with a reason pointing at the allowlist file (same posture as pi-bash-approval in print mode).

Do **not** rely on `ctx.ui.custom()` for the first version (RPC/Pendant may not support full custom TUI).

Optional: `ctx.ui.setStatus` / notify while the judge runs (“Checking command safety…”) so Pendant can surface status if configured.

---

## Modes (optional settings)

If you add config in `~/.pi/agent/settings.json`, keep Stem’s names mentally:

| Mode | Behavior |
| --- | --- |
| `assisted` (default) | allowlist → judge → UI |
| `manual` | allowlist → UI (skip judge) |
| `yolo` | allow all (still optional: keep a hard deny list if you add one later) |

Default to **assisted**.

---

## What not to do

- Do not implement this as a Pendant-only VS Code extension.
- Do not install `@fgladisch/pi-bash-approval` alongside this gate.
- Do not auto-run on judge failure.
- Do not teach wide prefixes (`rm:*`, `git:*`) from “Always allow” without the user picking them — suggest the **narrow** prefix of the failing segment.
- Do not use Stem’s `cmd.exe` Windows meta rules while the host shell is bash.
- Do not block on MDX / Stem UI code — this is Pi-side only.

---

## Verification checklist

1. Reload Pi config in Pendant; confirm the extension loads (no extension error toast).  
2. `ls` or `git status` → runs **without** a prompt.  
3. Something not allowlisted but clearly needed for the user’s ask (e.g. `mkdir tmp-gate-test`) → judge may say `safe` and run, or escalate with a clear reason.  
4. `rm -rf /` or a destructive oddball → UI shows **unsafe/unsure** + reason; Deny blocks; tool result explains the block to the model.  
5. `git status && rm -rf /tmp/x` → must **not** auto-run on the strength of `git status` alone.  
6. “Always allow” → prefix appears in `.security-gate-allowlist`; same command later auto-runs.  
7. Cancel the select dialog → blocked.  

---

## Deliverables

1. Working extension under `~/.pi/agent/extensions/security-gate/` (or project `.pi/extensions/`).  
2. Seed + empty learned allowlist file.  
3. Short note for the human: where files live, how to reload, how to edit the allowlist.  

Start from `extension-sketch/` in this folder.
