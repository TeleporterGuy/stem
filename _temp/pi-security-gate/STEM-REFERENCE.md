# Stem reference (read-only pointers)

These paths are inside the **Stem** repo. Use them as design reference; do not
depend on Stem at runtime in your work Pi setup.

| Stem file | Role |
| --- | --- |
| `src/main/exec/service.ts` | Orchestration: settings → protected roots → allowlist → judge → approval → spawn |
| `src/main/exec/policy.ts` | Pure parse/classify + judge prompt + verdict parse + judge model pick |
| `src/main/exec/protected.ts` | Hard fail-closed read-only folder scan (optional later; not required for v1) |
| `src/renderer/manage/ExecApprovalCard.tsx` | How the UI phrases the verdict + reason to the user |
| `docs/user/settings.md` | User-facing description of Manual / Assisted / Yolo |

### Stem vs Pi mapping

| Stem | Pi + Pendant |
| --- | --- |
| `ExecService.handleExecRequest` | `pi.on("tool_call")` for `bash` |
| `classify()` allowlist | Same idea in extension `policy.ts` |
| `runtime.complete(judgePrompt)` | `complete(ctx.model, …)` via pi-ai |
| `emitApprovalRequest` + card | `ctx.ui.select(...)` |
| `ExecSettings.allowlist` | `~/.pi/agent/.security-gate-allowlist` |
| Protected roots | Skip for v1 unless you need read-only folders |

### Deliberate differences for this work setup

- Judge model = **same GLM 5.2** (`ctx.model`), not Stem’s “cheapest cloud” auto-pick.
- Shell grammar = **bash**, even on Windows (not Stem’s `cmd.exe` Windows path).
- UI host = Pendant RPC, not Stem’s Electron approval card.
