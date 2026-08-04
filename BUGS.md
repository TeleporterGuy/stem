# Verified Bug Audit

Audit date: 2026-08-04
Audited revision: `8dbef56` (`main`)

Scope: the recall/memory subsystem as it stands after the seven-commit hardening
pass `8469d76…8dbef56`. One reviewer per commit re-read the diff plus the full
current bodies of every touched function and its collaborators, then hunted for
defects the commit introduced, left behind, or moved. The load-bearing findings
were re-verified by hand against the source before being written down.

This is an identification-only handoff. No application code was changed for this
audit. The previous audit (2026-07-30, fully remediated) is preserved in git
history at `ecadb2e`.

All twenty-five items the hardening pass set out to implement *are* implemented,
and every new regression test was traced against pre-fix code and confirmed to
fail on revert. Eighteen findings below survive as current defects. Two additional
mechanisms were verified but are retained separately as engineering observations,
not bugs.

## Summary

| ID | Severity | Area | Result |
| --- | --- | --- | --- |
| BUG-001 | High | Ingestion / privacy | `memorize:false` can still write the user's prompt into Recall |
| BUG-003 | High | Retrieval / privacy | Sensitive facts bypass the lexical bar in stores under 32 facts |
| BUG-002 | Medium | Reset / episodic embedding | A reset race leaves reused message IDs permanently unembedded |
| BUG-004 | Medium | Capture / SQLite | `recordMessage`'s deferred transaction can drop a turn's reply |
| BUG-005 | Medium | Ingestion | The held-back user message is lost on backend exit, shutdown, or a hung turn |
| BUG-006 | Medium | Facts lifecycle | An authorized revival is re-superseded within 60 s |
| BUG-007 | Medium | Conflict lifecycle | The open-conflict gate counts conflicts nothing can resolve |
| BUG-008 | Medium | Conflict lifecycle | A user's keep-both decision is re-litigated into a fresh conflict |
| BUG-009 | Medium | Conflict lifecycle | Permanently-conflicted pairs block the head of the relation-check queue |
| BUG-010 | Medium | Conflict lifecycle | Pairs are classified before their status is re-checked |
| BUG-011 | Medium | Reset | Two more post-await writers are ungated by the episodic epoch |
| BUG-012 | Medium | Folder index / worker | Cached doc handles survive an index drop-and-recreate and fail silently |
| BUG-013 | Medium | MCP server | A folder-scoped query evicts every other folder's cached handle |
| BUG-016 | Low | Retrieval | `countActiveFacts()` is the wrong corpus-size proxy for the bm25 gates |
| BUG-017 | Low | Ingestion | The prompt-shrink never engages for the failure it was built for |
| BUG-018 | Low | Tooling | The eval still treats a missing tier as "skip"; one verify assertion is vacuous |
| BUG-019 | Low | Docs / UI | Two more surfaces still claim disputed facts are withheld from the model |
| BUG-020 | Low | Ingestion | Uncited-evidence backfill can attach excerpts from another conversation |

## High severity

### BUG-001 — `memorize:false` can still write the user's prompt into Recall

- Affected:
  - `src/main/index.ts:1521-1530`
  - `src/main/pi/runtime.ts:756,830-841,1990-1998`
  - `src/main/pi/normalize.ts:461-509`
- Reproduction:
  1. Connect a folder with `memorize:false`.
  2. Ask a question that makes the model emit reasoning or an answer delta before
     reading inside it ("summarise the notes in my private folder").
  3. After the turn, inspect the episodic store: the user message is present.
- Actual: the capture is deferred to the *first event of the turn*, not to turn
  end. `index.ts:1528` flushes on every event that carries a `threadId`. If the
  model emits `item/started` for reasoning or an `agentMessage` delta before its
  private-folder tool call, the prompt is captured before `tool_execution_start`
  can set the taint. A direct tool call as the first event is safe: `onPiEvent`
  sets `memoryTainted` before emitting that tool's normalized `item/started`.
  The other safe path is
  `privateDocsInjected` (`runtime.ts:2542`), which taints during `buildMessage`
  — before `startTurn` even sets `pendingUserCapture`, so a synchronous check
  would have covered it.
- Expected: the user message is written only once the turn's suppression verdict
  is final, i.e. in `settleTurn`.
- Impact: the confidential half of the exchange is suppressed while the prompt
  that names it is retained. The reply-side suppression that does work makes the
  gap easy to miss.
- Adversarial verdict: confirmed as an event-order race; the direct-tool-first
  control path is not affected.
- Note on the fix: the flush was placed early for a real reason —
  `settleTurn` runs *after* the `item/completed` agentMessage is emitted, so a
  settle-only flush gives the user row a higher id than its own reply, and
  distill/summaries walk id ASC (`store.ts:1458,2658`). The fix is to carry the
  prompt-time timestamp (`recordMessage` already accepts `input.ts`) and order
  on `(ts, id)`; the flush can then move to `settleTurn` and the guarantee holds.

### BUG-003 — Sensitive facts bypass the lexical bar in stores under 32 facts

- Affected:
  - `src/main/recall/search.ts:83-87`
  - `src/main/recall/store.ts:1859-1863`
- Reproduction: with fewer than 32 active facts, embeddings off, and a stored
  sensitive fact ("the user takes insulin for diabetes management"), ask
  "any management tips for my team offsite?".
- Actual: `const gated = countActiveFacts() >= FACT_LEXICAL_GATE_MIN_FACTS`
  short-circuits *both* filters — `!gated ||` disables the sensitivity bar along
  with the bm25 noise ceiling. The small-corpus argument justifies standing down
  the noise gate (bm25 magnitudes collapse when IDF is small), but it does not
  transfer to a bar whose entire purpose is to demand more than an incidental
  term match. A 20-fact store is precisely where one sensitive fact is most
  likely to *be* the top lexical hit.
- Expected: the noise ceiling stands down below the threshold; the sensitivity
  bar is corpus-independent (or expressed relative to the corpus's own bm25
  distribution rather than an absolute constant).
- Impact: the commit's own leak scenario, reproduced one fact below the
  threshold.
- Adversarial verdict: confirmed; re-verified by hand at `search.ts:85-87`.

## Medium severity

### BUG-002 — A reset race leaves reused message IDs permanently unembedded

- Affected:
  - `src/main/recall/embed-episodic.ts:89-113`
  - `src/main/startup/retrieval.ts:166-178`
  - `src/main/recall/store.ts:2746-2775` (`resetEpisodic`)
- Reproduction:
  1. Start the episodic embed pass over a captured message.
  2. Hit "Reset recall" while `await emb.embed(...)` is outstanding.
  3. Capture a new message while the old embed call is still outstanding, so it
     reuses the deleted row ID.
  4. Let the old embed call finish, then run semantic search.
- Actual: `replaceMessageChunks` writes the old chunks *before* the awaited embed
  call. Reset correctly deletes those chunks. After the await, however, the
  ungated pass writes stale chunk/message vectors for the reused ID and advances
  the model's watermark past it. The new message is then skipped by later embed
  passes. Its stale chunk vector has no matching chunk row, so semantic search
  returns no hit. Crucially, the erased chunk text does **not** resurface: the
  previous High-severity privacy claim was disproved by an executable race probe.
  The summary-vector backfill loop in `startup/retrieval.ts` has the same missing
  generation guard and can bind an old summary embedding to a reused summary ID,
  causing mis-ranking rather than text leakage.
- Expected: every post-await episodic writer snapshots
  `getEpisodicGeneration()` and drops its writes when the epoch moves, exactly as
  `summarize.ts`, `distill.ts`, and the successful path in `rebuild.ts` do.
- Impact: wider than the race window itself. `getMessagesForEmbedding` selects
  `WHERE id > watermark`, so a resurrected watermark suppresses **every** message
  captured after the reset until new rowids climb back past the pre-reset
  high-water mark. On a store that had reached id 50 000 that is semantic
  episodic search silently dead for the next 50 000 messages under the current
  model (switching embedding models re-embeds from zero, since the watermark is
  model-keyed). Reused summary IDs can also carry the wrong ranking vector.
- Adversarial verdict: the reset race is confirmed by executable reproduction;
  the erased-text leakage and High severity are rejected.

### BUG-004 — `recordMessage`'s deferred transaction can drop a turn's reply

- Affected: `src/main/recall/store.ts:1012-1051`; `src/main/recall/capture.ts:58,74`
- Actual: the new atomicity wrapper uses a deferred `BEGIN` around a
  read-then-write. With `turnId` set, the supersede `SELECT` opens a read
  snapshot; the first `DELETE` upgrades it to a write. In WAL, if another
  connection has committed since that snapshot, SQLite returns
  `SQLITE_BUSY_SNAPSHOT` **immediately and does not invoke the busy handler** —
  so the 60 s `busy_timeout` raised in the same commit is irrelevant here. The
  scan worker commits constantly during a prune round
  (`maintenance-core.ts:82-87`). Capture swallows the throw, so the turn's reply
  is silently lost.
- Expected: `BEGIN IMMEDIATE`, which takes the write lock up front and *is*
  covered by the busy handler.
- Impact: a regression in the exact failure mode the transaction was added to
  prevent — before the commit these were autocommit statements and the INSERT
  simply waited on the busy handler.
- Adversarial verdict: confirmed; re-verified by hand at `store.ts:1012`.

### BUG-005 — The held-back user message is lost on backend exit, shutdown, or a hung turn

- Affected: `src/main/pi/runtime.ts:628-636,1839-1852`; `src/main/index.ts:1657`
- Actual: two exits null `currentTurn` without flushing `pendingUserCapture`:
  backend process exit and `shutdown()`/`restart()`. `index.ts:1657` calls
  `runtime.shutdown()` on `before-quit` with no `isTurnRunning` guard. A pi that
  wedges without emitting a terminal event holds the pending capture until the
  process dies.
- Expected: flush (subject to the taint check) on every terminal path, or accept
  the loss explicitly and document it.
- Impact: the window is narrow (send → first token) but this was a lossless path
  before the commit.
- Adversarial verdict: confirmed by the reviewing agent; exit-path enumeration
  showed every other exit does flush, and a double write is impossible (both
  sites clear the field first and `recordMessage` is `INSERT OR IGNORE` on
  `dedup_key`).

### BUG-006 — An authorized revival is re-superseded within 60 s

- Affected: `src/main/recall/store.ts:1546-1580`, `:1680` (`sweepExpiredFacts`),
  `:1837` (`restoreSupersededFact`)
- Actual: the new `reviveSuperseded` gate flips `status` back to active, but the
  same `DO UPDATE` keeps `valid_until = COALESCE(excluded.valid_until,
  facts.valid_until)` — the past expiry date survives. Since `supersedeFact`
  mangles the norm key, the expiry path is the *only* way a restatement can land
  on a superseded row, so every legitimate revival carries a stale
  `valid_until` and is re-superseded by the next `sweepExpiredFacts` (≤ 60 s,
  fired from `getFacts`/`getInjectableFacts`). `restoreSupersededFact` clears
  `valid_until` for exactly this reason; `upsertFact` does not.
- Expected: clear `valid_until` when the revive flip fires, as the manual
  restore path does.
- Impact: the feature is a ≤ 60 s flip plus a full memo wipe. The new test
  passes only because `getFactDetails` reads the row directly and never triggers
  the expiry sweep.
- Adversarial verdict: confirmed; re-verified by hand at `store.ts:1550`.

### BUG-007 — The open-conflict gate counts conflicts nothing can resolve

- Affected: `src/main/startup/recall-tasks.ts:123`; `src/main/recall/store.ts:1867,1934,1941`
- Actual: `countOpenConflicts()` counts every row with `status = 'open'`, but the
  adjudicator can never resolve two classes: conflicts with an explicit side
  (filtered out by design at `store.ts:1941`) and conflicts at `attempts >= 3`
  (`store.ts:1934`; `adjudicate.test.ts:130-142` asserts they stay open
  forever). The sweep mints explicit-side conflicts routinely, because
  `mayAutoSupersede` refuses explicit/pinned targets and falls through to
  `createFactConflict`. Twenty-one of those sitting in an unopened Conflicts card
  switches `processPendingRelationChecks` off permanently.
- Expected: gate on the count of *adjudicable* conflicts.
- Impact: the conflicts are visible in the Memory tab, but unless the user opens
  that surface and resolves them, a manual-only backlog silently stops all new
  background relation checks.
- Adversarial verdict: confirmed; re-verified by hand at `store.ts:1867`.

### BUG-008 — A user's keep-both decision is re-litigated into a fresh conflict

- Affected: `src/main/recall/reconcile.ts:287-320`
- Actual: `processPendingRelationChecks` never consults `isRelationChecked`, so
  fixing the over-eager stale kill (BUG-fix #2 of that commit) removed the
  accidental protection the memo work was built for. Sequence: an over-budget
  sweep enqueues `(A,B)` with a NULL verdict → a later pass raises `conflict(A,B)`
  → the user resolves keep-both, both sides return to active and the conflict row
  goes `resolved` → the still-NULL pending row is now eligible, gets classified,
  contradicts, and `createFactConflict(A,B)` fires again.
  `idx_fact_conflict_pair` is partial (`WHERE status='open'`), so
  `INSERT OR IGNORE` inserts a fresh open conflict.
- Expected: settle the pending row as `stale` when `isRelationChecked(A,B)`
  already holds, before spending a model call on it.
- Impact: a decision the user made by hand comes back.
- Adversarial verdict: confirmed; re-verified by hand — no `isRelationChecked`
  call exists in that function.

### BUG-009 — Permanently-conflicted pairs block the head of the relation-check queue

- Affected: `src/main/recall/store.ts:2002-2026`
- Actual: `getPendingRelationChecks` over-fetches `limit * 4` ordered
  `created_at ASC, id ASC` and breaks at `limit`; conflicted sides are now
  `continue`d with no aging or deprioritisation. Pairs involving a permanently
  conflicted fact (see BUG-007) camp at the head of that ordering forever, so
  past roughly 100 such rows every pass returns zero work while newer, ready
  pairs are never examined. The pairs themselves also stay pending indefinitely.
  Related: `WHERE verdict IS NULL ORDER BY created_at` has no supporting index —
  a full scan and sort over a queue that now only grows.
- Expected: skip-and-age (or an explicit deferred state with a retry stamp), plus
  an index on `(verdict, created_at)`.
- Adversarial verdict: confirmed; re-verified by hand.

### BUG-010 — Pairs are classified before their status is re-checked

- Affected: `src/main/recall/reconcile.ts:294-313`
- Actual: `classifyRelation` is awaited at `:295`; the `gone()`/status re-read
  happens at `:303-313`. Queue pairs cluster on shared neighbours, so one
  conflict raised early in a pass invalidates later rows — up to 25 discarded
  model calls per cycle. `checked` is incremented only after the re-check, so the
  activity row can read "Checked 0 pairs" after 25 calls.
- Expected: read status before spending the call.
- Adversarial verdict: confirmed; re-verified by hand. Note the in-loop skip is
  currently unreachable from tests because `getPendingRelationChecks` pre-filters,
  which is why this passes CI.

### BUG-011 — Two more post-await writers are ungated by the episodic epoch

- Affected: `src/main/recall/rebuild.ts:195-203`; `src/main/startup/retrieval.ts:166-178`
- Actual: `runMemoryRebuildStep`'s success path checks the epoch, its `catch`
  path checks only `getFactsGeneration()`. `resetEpisodic` deletes
  `memory_rebuild_v2`, so a reset followed by a rejected model call recreates the
  row as a stale `failed` run — and since `resetEpisodic` leaves legacy-source
  facts alone, `provenanceGap()` stays true and the user is shown "Memory rebuild
  failed" immediately after a clean reset. The summary-vector loop in
  `startup/retrieval.ts` is covered under BUG-002.
- Expected: the same epoch check on the catch path; the comment directly above it
  already states the requirement, for facts only.
- Adversarial verdict: confirmed; re-verified by hand at `rebuild.ts:197`.

### BUG-012 — Cached doc handles survive an index drop-and-recreate and fail silently

- Affected: `src/main/recall/scan-worker.ts:70-129`; `src/main/recall/scan.ts:71-78`;
  `src/main/recall/search-core.ts:895`; `src/main/folder-index/index.ts:70-77`
- Actual, two compounding halves:
  1. **No invalidation on recreate.** `dropFolderIndex` closes the main store and
     `rm`s `<folderId>.sqlite` plus its WAL/SHM siblings; it runs whenever a
     folder's `index` flag goes false. Folder ids are stable UUIDs, so
     index off → index on recreates the identical path. Nothing tells the worker,
     and the protocol has no eviction message. On POSIX the worker keeps reading
     the unlinked inode indefinitely — hits for documents the user removed,
     nothing indexed after the toggle ever visible, and the deleted file's blocks
     stay allocated. On Windows the `rm` fails against the open handle and the
     failure is swallowed by `.catch(() => undefined)`, so an index DB holding
     full document text **survives a disconnect the user believes deleted**.
     (A genuine disconnect-and-reconnect is safe: new UUID, new path.)
  2. **The eviction path is dead.** The comment says handles are "evicted on any
     error", but `semanticSearchDocsCore` catches its own SQLite errors and
     returns `[]`, so the `catch { evictDocDb; fail }` only ever sees *open*
     failures. A bad cached handle replies `doc-hits: []`, the manager resolves,
     `scanDocsOffThread` does **not** fall back in-process, and `hybridSearchDocs`
     silently degrades to FTS-only for that folder for the process lifetime —
     indistinguishable from "no matches".
- Expected: an eviction message from `dropFolderIndex`/`syncFolderIndexes`; a
  worker-side liveness check (file identity or mtime) before reuse; and an error
  channel that distinguishes "zero hits" from "the scan failed".
- Adversarial verdict: confirmed; re-verified by hand at `scan-worker.ts:74-129`.
  Minor, same file: `openDocDb` still sets `busy_timeout = 5000`, so the comment
  that it mirrors the main handle is only half true.

### BUG-013 — A folder-scoped query evicts every other folder's cached handle

- Affected: `src/main/recall/mcp-server-main.ts:225-233`
- Actual: `entries` is filtered by the `folder:` argument *before* `live` is
  derived from it, so one `search_folder_docs(query, folder: "notes")` closes
  every other folder's handle. The comment says "folders that left the manifest";
  the code says "folders not in this call's result set".
- Expected: derive `live` from the unfiltered manifest.
- Impact: performance only — it defeats the cache the commit added.
- Adversarial verdict: confirmed; re-verified by hand.

## Verified engineering observations (not bugs)

These mechanisms are real, but the adversarial review did not establish a
product defect. They are excluded from the bug summary and retained as explicit
design decisions to revisit.

### OBS-001 — A 60 s `busy_timeout` permits a long main-thread stall

- Affected: `src/main/recall/store.ts:521`; `src/main/recall/scan-worker.ts:61`
- Actual: `node:sqlite`'s `DatabaseSync` is synchronous, so a 60 s busy wait on
  the main-process handle is a 60 s Electron **main-thread** block — no IPC, no
  window events. `enforceEpisodicLimitCore` runs up to eight DELETE+VACUUM rounds
  on a large file in the worker; any main-thread store call caught in that window
  (the capture tap, the injection-path search, `clearEpisodicMemory`'s own
  deletes) now blocks instead of throwing after 5 s.
- Possible mitigation: a bounded wait (~10-15 s) on the main-thread handle, with
  the long timeout reserved for the worker; longer term, move capture writes off
  the main thread.
- Impact: trades a swallowed `SQLITE_BUSY` for a potentially worse hang. Worth a
  deliberate decision rather than a silent 12× raise.
- Adversarial verdict: the blocking mechanism is confirmed — a 300 ms probe
  blocked synchronously for 333 ms — but this remains a timeout trade-off, not a
  verified bug.

### OBS-002 — The episodic recency weight is on the wrong side of both boundaries

- Affected: `src/main/recall/search-core.ts:199-207,215-239`
- Actual: `EPISODIC_RECENCY_WEIGHT = 2.5e-4` is a flat additive term, but the
  RRF score gaps it competes with differ by an order of magnitude between the two
  regimes it lands in:
  - **Single-list (FTS-only) fusion**: the adjacent gap at rank 1↔2 is
    `1/61 − 1/62 = 2.644e-4`, and at 2↔3 `2.560e-4` — both larger than the
    maximum possible boost. A fresh message at rank 2 can never overtake a
    two-year-old at rank 1, which is exactly the scenario the term was added for,
    and `inject.ts` consumes only the top 3 + 2 extra raw hits.
  - **Both-legs fusion**: hits present in both legs cluster far tighter — e.g.
    `(fts 2, sem 3) = 0.0320020` vs `(fts 1, sem 4) = 0.0320184`, a gap of
    `1.6e-5`. There the term jumps two ranks freely, violating the stated
    invariant.
  The header comment's claim that the adjacent gap "grows toward the tail" is
  also backwards — it shrinks (`1/61−1/62 = 2.64e-4` vs `1/71−1/72 = 1.96e-4`);
  the "never jumps two ranks" conclusion survives only because candidate lists
  are capped at 12, and breaks if `FTS_CANDIDATES` rises past ~30.
- Possible alternative: apply recency in *rank* space, where gaps are uniform by
  construction — `1/(RRF_K + rank − δ·decay)` with `δ < 1` bounds the effect to
  at most one rank step per leg in both regimes. Any change here must re-run
  `node scripts/recall-eval.mjs` against the `recall-golden.json` floors.
- Impact: no misbehaviour, and the eval floors hold either way; the term simply
  does not do what it was tuned to do.
- Adversarial verdict: the arithmetic and comment mismatch are confirmed, but no
  retrieval regression or floor failure was demonstrated. This is calibration
  debt, not a verified product bug.

## Low severity

### BUG-016 — `countActiveFacts()` is the wrong corpus-size proxy for the bm25 gates

- Affected: `src/main/recall/store.ts:1859-1863`; `src/main/recall/search.ts:83`
- Actual: the gate asks "is this corpus big enough for bm25 magnitudes to be
  meaningful", but counts only `status = 'active'`. `factTermSearch` searches
  `status IN ('active','conflicted')`, and bm25's IDF/avgdl come from the whole
  `facts_fts` index, which the triggers populate for every row — superseded facts
  keep their rows (the status flip does not delete them). A store with 28 active
  and 300 superseded facts has full-scale bm25 while the count says 28, so both
  gates stand down indefinitely. `COUNT(*) FROM facts` is the correct proxy.
  (`chooseFacts` already holds `getInjectableFacts()` at `inject.ts:265`, so the
  extra per-query count is also redundant.)
- Adversarial verdict: confirmed; re-verified by hand.

### BUG-017 — The prompt-shrink never engages for the failure it was built for

- Affected: `src/main/recall/distill.ts:567-582,597-619`
- Actual: `blockScale` keys off parse strikes, and strikes are recorded only when
  the reply *parses to nothing*. If the model errors on an oversized prompt — a
  local server returning `context_length_exceeded`, the stated motivation —
  `llm.complete` throws, the catch returns 0 with the cursor unmoved and no
  strike recorded. `priorStrikes` stays 0, `blockScale` stays 1, and the identical
  oversized prompt retries forever with no `MAX_PARSE_STRIKES` escape. The shrink
  helps only the truncated-garbage variant.
- Expected: record a strike (or a separate oversize counter) on a completion
  error too.
- Adversarial verdict: confirmed by the reviewing agent.

### BUG-018 — The eval still treats a missing tier as "skip"; one verify assertion is vacuous

- Affected: `scripts/recall-eval.mjs:154-215`; `tests/eval/score.mjs:71`;
  `scripts/recall-verify.mjs:96`
- Actual: `checkFloors` does `if (!actuals) continue`, so any tier absent from the
  aggregate is skipped and the run still prints ALL FLOORS PASS — the exact
  silent-degradation mechanism that had left the eval testing only the FTS tier,
  untouched by its repair. It is worse for facts: the tier name comes from the
  runtime result and `chooseFacts` swallows embedding failures and degrades to
  `lexical`, so a dead embedder records every fact query as `facts-lexical` while
  the fixture's only fact floor is keyed `facts-embedding`. Separately,
  `recall-verify.mjs:96`'s relaxed check no longer tests what its name says: the
  only "UZ Gent" message is assistant-role, which the new `roles: ['user']`
  filter makes structurally uninjectable, so the assertion now matches solely the
  durable fact and is redundant with the line above it.
- Expected: a floor whose tier is absent is a violation (or a `requiredTiers`
  list in the fixture); reseed the verify case with a user-role message and
  assert on `pastUserMessages`/`pastConversations`.
- Adversarial verdict: confirmed by the reviewing agent, which ran both scripts
  (`recall-verify` ALL_PASS, 35 checks; `recall-eval` ALL FLOORS PASS with all
  four tiers populated).

### BUG-019 — Two more surfaces still claim disputed facts are withheld from the model

- Affected: `src/renderer/manage/tabs/FactsTab.tsx:897`; `README.md:53`
- Actual: the in-app InfoTip says conflicted/expired/unconfirmed claims "are
  excluded" and the README says they "stay out". Both contradict
  `getDisputedRepresentatives`, which injects one side flagged as uncertain. The
  hardening pass corrected `docs/user/memory/facts.md` — the least-read of the
  three surfaces.
- Related, same area: `facts.md:53` introduces a bolded **disputed** state users
  cannot see anywhere in the desktop app (the only user-visible rendering is
  mobile's `MemoryPeek.tsx:55`, labelled "conflicting"), and the doc never
  mentions the "Recently auto-resolved" audit list (`FactsTab.tsx:845-878`) that
  is a user's only window into what the autonomous adjudicator did.
- Adversarial verdict: confirmed by the reviewing agent.

### BUG-020 — Uncited-evidence backfill can attach excerpts from another conversation

- Affected: `src/main/recall/distill.ts:644-645`; `src/main/recall/store.ts:1458`
- Actual: the new `.slice(-3)` takes the last three user messages *of the batch*,
  and `getMessagesForDistillFrom` is `WHERE id > ? ORDER BY id ASC` with no thread
  filter — so a batch spans threads and a claim distilled from early in the batch
  can be given three excerpts from whatever chat happened to end it. The previous
  whole-batch backfill was noisier but always contained the true source.
- Expected: prefer the three nearest messages from the claim's own thread.
- Adversarial verdict: confirmed by executable reproduction. A source
  conversation followed by three unrelated user messages in another thread
  produced an uncited fact whose three evidence rows all belonged to the later,
  unrelated thread.

## Coverage gaps

Not defects, but the reason several findings above pass the current suite:

- Nothing in `tests/` references `flushPendingUserCapture`, `pendingUserCapture`,
  `blockScale`, `USAGE_BLOCK_CHAR_BUDGET`, or `facts_trigram_built` — the
  highest-risk change in the pass (BUG-001, BUG-005) is untested.
- `OPEN_CONFLICT_GATE` and `MAX_PER_PASS = 15` have no coverage; no test touches
  `recall-tasks.ts`.
- The worker's `docDbs` cache and eviction, `scanDocsOffThread`'s fallback, and
  the `semanticScan` wiring in `searchFolderDocs` are all uncovered
  (`scanMessagesOffThread` is covered, which is what makes the gap easy to miss).
- The cross-folder doc merge — the defect the fallback commit calls load-bearing
  — is still tested against a single folder only.
- The sub-32-fact standdown (BUG-003) and the embeddings-on + ≥32-facts
  interaction of the lexical ceiling are untested.
- The role filter's semantic leg is untested: the test passes no
  `getQueryEmbedding`, so reverting the `roleSet` filter or the `roles` scan
  option leaves it green. Its FTS half is genuinely non-vacuous.

## Validation notes

- Executable throwaway-database probes reproduced BUG-003, BUG-006, BUG-008,
  BUG-009, and BUG-020. A reset-during-embed probe confirmed the corrected
  BUG-002 failure mode and disproved the previous erased-text leakage claim.
- A two-connection WAL probe reproduced BUG-004's immediate read-to-write
  snapshot failure despite `busy_timeout = 60000`.
- On macOS, an open read-only SQLite handle continued reading the unlinked old
  folder index after the same path was recreated, confirming BUG-012's POSIX
  half. The Windows deletion-retention half is source-derived, not locally run.
- `npm run typecheck` and `npm run lint` passed.
- With socket-dependent suites excluded, 74 test files passed: 1,090 tests, 3
  skipped. The full sandbox run failed only in mobile/socket suites with
  `listen/connect EPERM`; those failures are environment restrictions, not
  evidence for or against these findings. The temporary verification probes were
  removed after the run.
