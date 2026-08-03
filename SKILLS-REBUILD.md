# Skills rebuild

Design record and implementation plan for replacing Stem's skill system. Written
2026-08-03 after an investigation of the current implementation, a comparison
against Hermes Agent (`NousResearch/hermes-agent`), and a backtest over the
local session history.

Implemented 2026-08-03. "What we decided" records the design; "Open items —
resolved" and "What changed from the plan" record where the build differed from
it and why. The plan sections below are kept as written so the reasoning survives
alongside the code.

## Why

### The library we have

25 auto-authored skills in `<userData>/pi-home/skills`. Three have ever been
used since usage tracking began 2026-07-23. Mean body 1,355 bytes, whole
library 34 KB.

Split by who wrote them:

| author | skills | ever used |
| --- | --- | --- |
| the model, via `manage_skill` | 2 | **2** |
| the background distiller | 23 | 1 |

The two written through `manage_skill` — `agent-browser-vercel` and
`inspect-youtube-video-with-captions` — are two of the three skills that have
ever been retrieved.

Reading the user messages that preceded each call shows they came from different
paths, and this matters for the design:

- **`agent-browser-vercel`** (5 Jul) followed the message *"please add agent
  browser skill by vercel"*. A direct, natural-language request.
- **`inspect-youtube-video-with-captions`** (21 Jul) followed *"Má to
  autogenerované titulky"* at the end of a long browser-troubleshooting
  digression with several dead ends. Nobody asked; the model volunteered.

So the highest-quality path is really two paths — the user asking in
conversation, and the model volunteering after a hard turn — and both produced a
skill that got reused. The requested path is almost certainly the common one in
practice, and today it has no surface other than saying it out loud. Any design
that makes "hey, save this as a skill" harder than it is now is a regression.

The distiller's output is episodic rather than reusable —
`determine-bike-lock-cylinder-size-and-search-criteria`,
`draft-merchant-invoice-request-email`,
`estimate-vehicle-lease-equity-before-sale`. These are transcripts of one
conversation reformatted as numbered steps.

### Why the distiller produces that

`recall/store.ts:1378` selects `id, threadId, turnId, role, ts, text`, and
`recall/capture.ts:46-54` writes only user prose and `agentMessageText(item)`.
The recall DB holds **no tool calls, no results, no errors**. So the distiller's
prompt — which asks for "a sequence of tool calls… especially one it got right
only after recovering from a misstep" (`skills/distill.ts:90`) — is run against
an input where tool calls and missteps are structurally absent. It reconstructs
procedures from the assistant's narration of them, which is why the output reads
like narration.

### Three defects in the current system

1. **The enable/disable switch does nothing.** `setSkillEnabled`
   (`workspace/skills.ts:76`) and the curator's archive (`skills/curate.ts:249`)
   write a `.disabled` marker. pi has no concept of it — its only ignore
   mechanism is `IGNORE_FILE_NAMES = ['.gitignore', '.ignore', '.fdignore']`,
   and its scanner returns on the first `SKILL.md` in a directory before looking
   at sibling dotfiles. Disabled and "archived" skills stay in context.

2. **Frontmatter is out of spec.** `createSkill` validates only that
   name/description/body are non-empty, that the *slug* is valid, and that the
   file is under 15 KB. The `name:` field takes the model's free text verbatim —
   one live skill has a 79-character English sentence in a field agentskills.io
   and pi both cap at 64 lowercase-hyphenated chars.

3. **No retrieval, so no feedback loop.** pi broadcasts every skill's
   name+description into the system prompt each turn. Because everything is
   always injected, the injected-count is constant across skills and carries no
   information — the precision signal that makes memory work is unavailable by
   construction.

### The bar: what memory does that skills doesn't

Memory is 8,807 lines across 33 modules; skills is 1,021 across 4. The gap that
matters is not size:

- **Per-turn relevance retrieval.** `recall/inject.ts` embeds the message,
  cosine-shortlists, reranks, applies a sensitivity-tiered gate
  (`STANDARD_FACT_MIN_COSINE = 0.72`), and falls back to a BM25+trigram tier
  when embeddings are unreachable.
- **A closed feedback loop.** Facts carry `times_injected` / `times_used` /
  `last_used_at` (`store.ts:157`). `usageRate()` is Laplace-smoothed and
  half-life decayed, and ranking blends it in — `blended = cosine + W·(usageRate
  − 0.5)` (`inject.ts:137-150`) — while the safety gate stays on raw cosine.
- **Evidence and provenance** on every fact (`adjudicate.ts:28-31`).
- **Conflict machinery** — `reconcile.ts` supersedes or opens a conflict;
  `adjudicate.ts` takes a second pass, caps attempts, defaults to keep.
- **Write-time semantic dedup** at a calibrated `DEFAULT_DUP_COSINE = 0.94`
  (`store.ts:428`).
- **Evals with floors.** `memory-eval.mjs` lifts `DISTILL_INSTRUCTIONS` verbatim
  from the shipping source and throws if it gains an interpolation, so the gate
  can never grade a paraphrase. `recall-eval.mjs` prints recall@1/3/5 + MRR per
  tier and exits 1 below floor.

Memory is good because it is measured. That is the mechanism to copy.

## Backtest

Run over 547 turns reconstructed from 225 session logs in
`<userData>/pi-home/sessions`. pi's own session JSONL persists `toolCall` blocks
with arguments and `toolResult` blocks with output and a real `isError` flag.

| signal | turns | rate |
| --- | --- | --- |
| zero tool calls | 400 | 73.1% |
| any genuine tool error | 7 | 1.3% |
| error → recovery | 5 | 0.9% |
| ≥4 tool calls | 67 | 12.2% |
| ≥6 tool calls | 49 | 9.0% |
| ≥4 tools OR recovery | 67 | 12.2% |

Two findings:

- **Recovery is fully subsumed by tool count.** All 5 recovery turns already had
  ≥4 tool calls, so the recovery clause adds no coverage. Dead-end-and-recover is
  a coding-agent shape; Stem is a personal assistant. Recovery still earns its
  place in *routing* (a turn that loaded a skill and then failed should patch it)
  but not in firing.
- **73% of turns call no tools**, so a tool-count gate is free on the majority of
  turns.

Re-run this against the same corpus when tuning the threshold rather than
guessing.

## What we decided

| area | decision |
| --- | --- |
| Manual triggers | three, in order of expected use: (1) **asking in conversation** — "add a skill for this" — handled by `manage_skill` inside the live turn; (2) `/learn [focus]` in the composer; (3) a per-turn "Save as skill" button. All three enforce the same contract |
| Policy | one setting, three values: Off / Ask / Auto. Default **Ask** |
| Fire gate | ≥N tool calls in the settled turn; one model call both judges and authors |
| Routing | `turn.skillsUsed.size > 0` → patch that skill; otherwise create |
| Authoring input | in-memory turn trace (tool name, args, truncated result, status), plus user and assistant text |
| Privacy | skip authoring entirely when `turn.memoryTainted` |
| Retrieval | Stem owns it. `--no-skills` on the main spawn; embed + rank, inline top-k full bodies above a cosine gate, index the rest by name+description |
| Usage | `recordTurnInjectedSkills` → graded → blended into ranking, mirroring facts |
| Contract | slug `name` ≤64 matching the directory; one-sentence `description` ≤160 chars that does not restate the name; body ≤4 KB with `## When to use`, `## Steps`, `## Verification` |
| Validation | hard-fail with specific reasons; the model retries |
| Upkeep | write-time cosine dedup + patch-on-use + usage demotion + a merge/prune-only curator |
| `manage_skill` | kept and registered in **every** mode; takes `initiated_by: 'user' \| 'assistant'`. User-requested writes directly after validation; assistant-initiated follows the mode |
| Mode semantics | the mode governs **Stem's own initiative**, never the user's explicit instructions |
| Framing | follow-but-report-deviation, with provenance labels on each skill |
| Eval | two harnesses, fixtures harvested from real session logs, prompts lifted from source |
| Migration | wipe all existing skills; one-time dialog explains, offers export to Files, and picks the mode |
| Not doing | multi-file skills, blind body rewrites, DB-persisted tool events |

### Rationale for the less obvious ones

**Manual-first, with an automatic mode.** Requested. It also defers the largest
piece of plumbing: a trigger that runs inside a live turn already has the tool
history, so no persistence layer is needed.

**Inline bodies rather than index-and-read.** The agentskills standard has the
model `read` a SKILL.md when the description matches. Hermes' own docs concede
"models don't always do this." Bodies average 1,355 bytes, so inlining the top 2
costs ~700 tokens — the same order as recall's existing per-turn spend. Inlining
removes all dependence on the model volunteering a tool call, which is the
behaviour class that produced 2 `manage_skill` calls in 225 sessions.

This has a consequence: today's usage signal is a `read`/`grep` landing inside a
skill folder (`runtime.ts:1643`). Once bodies are inlined no read happens, so
usage must become the memory-style injected-then-graded loop. That is the loop
we want anyway.

**Per-turn block, not the system prompt.** `runtime.ts:2168-2215` builds a
`blocks` array prepended to the user message — how recall, files, and connected
folders already reach the model. pi is a persistent process, so `--skill` flags
are spawn-time only and can never be per-turn; the block is the only place
selection can live. It also keeps the system prompt stable, preserving the prompt
cache that reloads are currently deferred to protect (`runtime.ts:1834`).

**No multi-file skills.** Stem spawns pi with `--exclude-tools bash`
(`runtime.ts:1494`) and tells the model it has no shell, so a `scripts/`
directory would be unrunnable. With inline delivery under a 4 KB cap,
`references/` would never load.

**Curator keeps merge and archive, loses rewrite.** Body edits belong to
patch-on-use, which knows what actually failed. A periodic pass rewriting bodies
it has no failure evidence for can silently degrade a working skill — and it is
the one mechanism that has been running continuously on the library we are
deleting.

**Keep `manage_skill`, and let the user's request override the mode.** It is the
highest-precision authoring path we found (2 for 2), and half of that is the user
simply asking in conversation. The mode label for Off is "Only when I ask", so a
design where an explicit request is refused in Off — or has to be confirmed
through a card in Ask — contradicts its own copy and adds friction to the one
path that demonstrably works. Hence `initiated_by`: the model declares whether
the user asked, user-requested writes land directly in any mode, and the mode
retains a clean meaning as a limit on Stem's initiative rather than on the user's
instructions. The model can in principle mislabel the flag; the stakes are one
validated skill file, visible and removable in Manage.

**Who writes the body.** When the user asks in conversation, the model authors
the SKILL.md inline, in its own turn — it holds the full live context (real tool
results, the whole thread), which is strictly richer than the serialized trace a
one-shot receives. Quality there comes from hard validation and the retry loop,
not from moving the work elsewhere. The one-shot `authorSkill()` exists for the
cases where no live turn is available: the end-of-turn pass and `/learn`.

**Skills are followed; memory is not.** `bootstrap.ts:5` fences the memory block
as untrusted data that must never be treated as instructions. Skills are the
opposite by construction, and under Auto they are model-authored and unreviewed.
The block therefore tells the model to follow the loaded procedure *and to say so
when a step is wrong rather than following it silently* — which makes a bad skill
visible and routes it into patch-on-use. Each skill is labelled user-written or
auto-saved.

## Plan

### Patch 1 — ships independently, now

`setSkillEnabled` (`workspace/skills.ts:76`) and `archiveSkill`
(`skills/curate.ts:248`) rebuild `<skillsRoot>/.gitignore` from the set of
directories carrying a `.disabled` marker, then call the existing
`requestSkillReload`. `.disabled` stays the source of truth for the UI;
`.gitignore` is what pi reads. Extend the assertion at
`tests/unit/skills-curate.test.ts:116`.

This is a live bug on the current version and does not depend on anything below.

### Release — ordered by dependency

1. **Trace retention** — `pi/normalize.ts`, `pi/runtime.ts`. Add
   `trace: TraceEntry[]` to `TurnContext`, populated from data already on the
   events: `ev.args` at `tool_execution_start` (`normalize.ts:334`), `ev.result`
   at `tool_execution_end` (`normalize.ts:337`). Both are currently discarded.
   Cap 2 KB per result, 24 KB per turn. Keep a ring of the last ~3 settled turns
   on `PiRuntime` so `/learn` can reach the turn that just ended.

2. **Contract + validator** — new `skills/contract.ts`. Single source of truth,
   exported so the eval can lift it.

3. **Authoring routine** — new `skills/author.ts`.
   `authorSkill({trace, userText, assistantText, focus?})` → one-shot
   `complete()` on `skills.model` → parse → validate → one retry with the
   violations → write or stage. The standards prompt is an exported constant with
   no interpolation, so the eval can lift it verbatim the way
   `memory-eval.mjs:31` does.

4. **Gate + routing** — `settleTurn`. Fire on ≥N tool calls; route to patch when
   `turn.skillsUsed` is non-empty; skip when `turn.memoryTainted`.

5. **Mode + approval card** — `SkillsSettings.mode: 'off' | 'ask' | 'auto'`, plus
   `SkillProposal` / `onSkillApproval` / `respondSkillApproval` mirroring
   `InstructionsProposal` (`types.ts:1782-1789`). `manage_skill` gains
   `initiated_by` and stays registered in all three modes; only the
   assistant-initiated branch consults the mode. In Off that branch is refused
   with a message telling the model to mention the idea in its reply instead, so
   the user can just say yes.

6. **Retrieval takeover** — new `skills/inject.ts`. `--no-skills` on the main
   spawn; embed the turn, rank descriptions, inline top-k bodies above the cosine
   gate, index the rest; push into `blocks`. Reuses `getEmbeddingsClient` /
   `getRerankClient` from `recall/retrieval`. Add `<stem_skills>` to
   `SYNTHETIC_MARKERS` (`recall/capture.ts:14`) — pi's own
   `<skills_instructions>` is already there.

7. **Usage loop** — `recordTurnInjectedSkills`, grading, `usageRate` blended into
   ranking per `recall/inject.ts:137-150`. Retire the `SKILL_CONSULT_TOOLS`
   detection at `runtime.ts:1643`; no reads happen once bodies are inlined.

8. **Upkeep** — write-time cosine dedup on create; strip rewrite from
   `skills/curate.ts`, keep merge and archive, feed it injected-vs-used.

9. **Reset** — export to Files, delete, schema marker, and the one-time dialog
   that also picks the mode.

10. **Evals** — a fixture harvester over the session logs, then
    `scripts/skill-author-eval.mjs` (fired? contract-valid? content? no
    regression on negatives) and `scripts/skill-retrieval-eval.mjs`
    (recall@1/3/5, MRR, exit 1 below floor).

11. **Prompt** — rewrite the skills paragraph at `bootstrap.ts:19-21`. It must
    cover both paths explicitly: when the user asks you to remember how to do
    something, save it with `initiated_by: 'user'`; when you work out a
    non-trivial procedure unasked, offer it with `initiated_by: 'assistant'`.
    Give a concrete trigger for the second, and drop "Don't announce skill
    bookkeeping unless the user asks" — it actively suppresses the behaviour we
    want.

## Open items — resolved during implementation

- **Who owns the `manage_skill` write.** Resolved: it forwards to main. The
  bridge already had the mechanism — `ctx.ui.input(SENTINEL, json)`, which
  PiRuntime intercepts and answers with a JSON string (`run_command` and the
  scheduled-task tools both use it). A fourth sentinel, `SKILL_BRIDGE_TITLE`,
  carries the write. The extension is no longer a writer at all; it does argument
  marshalling and nothing else, and the drift guard in
  `tests/unit/pi-protocol.test.ts` now asserts it never touches `.skills-rev`.
- **Where skill vectors live.** Sidecar, `.skills-vectors.json`, next to
  `.skills-usage.json` — for the reason usage is a sidecar: a SKILL.md write
  bumps `.skills-rev` and forces a backend reload, and a vector refresh must
  never cost one. Invalidated per entry by a content hash, and wholesale when the
  embedding model changes.
- **Gate threshold N.** Five (`SKILL_GATE_MIN_TOOL_CALLS`).
- **Scheduled runs in Ask mode.** Resolved as Off, in both places
  independently: `decideSettle` returns `scheduled`, and `SkillBridge` refuses an
  assistant-initiated save outright. Two checks because they are reached by
  different paths — the pass and a live tool call.

## What changed from the plan while building it

- **`manage_skill` actions are `save` / `remove`**, not create/patch/remove. The
  old `old_string` → `new_string` surgery is gone: an update sends the full body.
  Partial edits could not be validated as a whole, and the retry loop needs a
  whole draft to reject. `create` and `patch` are still accepted as aliases so a
  model reaching for the old vocabulary does not lose a turn.
- **The distiller is deleted**, not left running. `skills/distill.ts`, its test,
  its background pass, and the "Collect now" button are gone. Nothing it did has
  an owner any more: it swept chat messages for procedures, and the recall DB
  holds no tool calls to sweep.
- **Usage grading is deterministic, not a model call.** A skill counts as used
  when the turn ran a tool its `## Steps` names (`skills/grade.ts`). Recall can
  afford an LLM judge because it rides the distill pass that runs anyway; there
  is no free ride here, and a per-turn judge would cost a model call on every
  turn in the app. The proxy is weak in both directions, which is acceptable
  because of what the number is for: a 0.1-weight reordering term inside a raw-
  cosine gate that can never admit or reject on its own, and it decays.
- **The curator can no longer rename.** A merge keeps the winner's slug, and the
  merged body is written through `saveSkill` — so the one remaining place that
  writes a body meets the same contract as every other, and a merge that would
  produce an invalid skill writes nothing rather than half of one.
- **Write-time dedup blocks the create** rather than leaving it for the curator
  (`skills/dedup.ts`, `SKILL_DUP_COSINE = 0.94`, the same value and calibration
  as recall's fact dedup). The caller is still holding the draft at that moment,
  so the answer can be "update that one instead" and be acted on immediately.
  Creates only; an update naming its own target is not a duplicate.
- **The trace redacts credentials by argument name**, not just encrypted
  envelopes. `add_mcp_server` takes the user's token as a plain `env` /`headers`
  /`oauthClientSecret` argument, and the trace is fed to a model when a skill is
  authored. Keys survive and values do not, so "set `HA_TOKEN` in env" — the
  reusable part — still reaches the skill.
- **`skillSlugForPath` and `SKILL_CONSULT_TOOLS` are deleted.** They detected a
  skill being used by watching for a read inside its folder. With bodies inlined,
  no such read happens — the signal is gone by construction, not by choice.

## Reference

Hermes Agent is cloned at `.external/hermes-agent` (gitignored, sparse). The
parts worth reading:

- `agent/learn_prompt.py` — `_AUTHORING_STANDARDS`, the closest thing to a house
  style guide for skill authoring.
- `agent/prompt_builder.py:1414` — `build_skills_system_prompt`, the two-layer
  cached index, and the `## Skills (mandatory)` block at line 1640.
- `tools/skill_manager_tool.py` — the six-action `skill_manage`, frontmatter
  validation, `absorbed_into` on delete.
- `tools/skill_usage.py` — active/stale/archived lifecycle, provenance,
  `PROTECTED_BUILTIN_SKILLS`.
