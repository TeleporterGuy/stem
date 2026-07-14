# Verified Bug Audit

Audit date: 2026-07-11

Scope: the full repository, with emphasis on runtime/session integrity, Recall persistence, scheduler behavior, MCP/OAuth, chat search, file handling, and renderer state transitions.

This is a fix handoff. Every item below was reproduced with a focused test/probe or established with a deterministic state/control-flow trace. No application implementation was changed during the audit.

## Remediation status — complete

All 37 findings were fixed in the working tree on 2026-07-12. The original audit text below is retained as the evidence and handoff record; its “Actual” descriptions document the pre-fix behavior.

Final verification after implementation:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- Production build (`npm run build`): passed.
- Unit suite excluding the sandbox-restricted Unix-socket endpoint file: 367/367 passed.
- Electron E2E: 16/16 offline scenarios passed; 8 real-credential scenarios were intentionally skipped by the suite.
- The full unit command additionally attempted five embed-endpoint tests, but this sandbox rejected their Unix socket with `listen EPERM`; all other 367 tests passed.

## Verification summary

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- Existing unit suite: 293 tests passed. Five embed-endpoint tests could not create their Unix socket because the audit sandbox returned `EPERM`; this was an environment restriction, not counted as a product failure.
- Focused runtime suites (cron, provider auth, session gate, files, scheduler): 40/40 passed before the additional repro probes.
- Existing MDX suite: 25/25 passed.
- Renderer reducer/chart repros: 2/2 reproduced the current faulty behavior.
- Additional persistence/search/security repros: 10/10 reproduced the current faulty behavior.
- Runtime probes were kept outside the repository under `/tmp`; representative observed outputs are recorded below.

## Suggested fix order

1. Fix BUG-001 through BUG-012 first. They can bypass privacy/isolation controls, misroute prompts, leak credentials, silently defeat cancellation/alerts, or resurrect deleted data.
2. Then fix scheduler, file-loss, search-loss, and persistence bugs (BUG-013 through BUG-027).
3. Finish with renderer consistency and presentation bugs (BUG-028 through BUG-037).

## High severity

### BUG-001 — Connected-folder read-only and `memorize:false` controls are bypassable through symlinks

- Affected: `src/main/pi/runtime.ts:159-165,1038-1044`; `src/main/pi/stem-mcp-extension.mjs:381-387,932-948`; roots are canonicalized in `src/main/workspace/connected-folders.ts:153-170`.
- Reproduction: connect `/vault` as read-only and private, then create `/workspace/alias -> /vault`. Read or write `/workspace/alias/secret.md` through a built-in file tool.
- Actual: both guards compare the lexical `resolve()` result of the supplied alias with `/vault`. The alias does not match, so writes are allowed and reads do not set `memoryTainted`; private content can subsequently enter Recall.
- Expected: aliases that resolve into a protected/private root receive the same policy as direct paths.
- Evidence: the read-only probe printed `{"directBlocked":true,"symlinkBlocked":false}`; the private-root probe printed `{"memoryTainted":false}`.
- Fix direction: canonicalize existing targets with `realpath`; for new write targets, canonicalize the nearest existing parent and append the remaining path. Apply one shared containment helper to both guards.

### BUG-002 — A failed `switch_session` is treated as success and later operations target the wrong chat

- Affected: `src/main/pi/runtime.ts:385-390,1368-1383`.
- Reproduction: make pi return `{ success:false, error:'corrupt session' }` for `switch_session`, then send a prompt or rename the requested chat.
- Actual: `ensureActive()` never checks `res.success`, sets `activeThreadId` to the requested ID, and returns it. Pi remains on its previous session, so the next operation is applied to the wrong conversation.
- Expected: reject the switch, preserve the real active session, and do not send the subsequent operation.
- Evidence: the probe printed `{"returned":"requested","activeThreadId":"requested"}` after a rejected switch.
- Fix direction: require a successful RPC envelope before mutating `activeThreadId`; propagate the backend error.

### BUG-003 — Empty or structurally corrupt `auth.json` is reported as authenticated

- Affected: `src/main/pi/runtime.ts:298-321`, especially the existence-only check around line 311.
- Reproduction: leave an existing `auth.json` containing `{}` (also the state after removing the last stored provider), then call runtime status.
- Actual: status is `{ ok:true, authenticated:true, providers:[] }`; onboarding/re-auth is bypassed, prewarm/scheduler starts, and turns later fail against an unavailable default provider.
- Expected: authentication is true only when at least one usable credential exists.
- Evidence: the probe printed `{"ok":true,"authenticated":true,"providers":[]}` for literal `{}`.
- Fix direction: parse and validate the credential store (or use `AuthStorage.list()`), not file existence.

### BUG-004 — MCP OAuth's advertised overall timeout never settles the login

- Affected: `src/main/pi/oauth.ts:160-209,253-331`.
- Reproduction: call `authorizeMcp(..., { timeoutMs: 50 })` and never visit the loopback callback.
- Actual: the timer only calls `loop.close()`. The unresolved `codePromise` is still awaited forever, so `mcpLogin` and its IPC call never settle.
- Expected: timeout rejects the authorization attempt and closes the listener.
- Evidence: after 250 ms the 50 ms probe still printed `STILL_PENDING_AFTER_250MS`.
- Fix direction: race callback completion against a rejecting timeout and abort discovery/register/exchange fetches as part of the same cancellation scope.

### BUG-005 — Remote MCP HTTP requests have no timeout or abort path

- Affected: `src/main/pi/stem-mcp-extension.mjs:231-285,754-775`.
- Reproduction: point a remote MCP entry at a server that accepts a TCP connection but never sends an HTTP response.
- Actual: the bridge's `fetch` calls have no `AbortSignal`; initial connection can stall bridge initialization, and a hung `tools/call` can hold an agent turn indefinitely.
- Expected: handshake and tool calls fail within a bounded timeout and surface a recoverable status.
- Evidence: the hanging-server probe printed `STILL_PENDING_AFTER_300MS`; unlike the stdio transport, the source contains no eventual request timer.
- Fix direction: apply explicit per-request timeouts/abort controllers, including initialization and tool calls.

### BUG-006 — Stop can silently fail before `startTurn` returns a turn ID

- Affected: `src/renderer/App.tsx:459-504,517-585,638-644`; `src/renderer/quickchat/QuickChat.tsx:151-203`; `src/main/pi/runtime.ts:368-447`.
- Reproduction: send a turn whose Recall/attachment preparation is slow, then immediately click Stop.
- Actual: the UI already shows `running`, but `activeTurnId` is still null. Stop clears only local state and sends no interrupt. The backend later accepts the prompt, can execute tools, and the locally re-enabled composer permits a second turn.
- Expected: Stop cancels the operation represented by the UI, even while start IPC is pending.
- Fix direction: track a cancellation request against the pending start; when the ID arrives, interrupt immediately (or add a cancellable start API). Do not enable another send until the pending operation is settled.

### BUG-007 — Scheduled `notify_user` alerts are lost if the main window was closed

- Affected: `src/main/index.ts:708-719,722-729,1484-1492`.
- Reproduction: close the main macOS window while Stem remains running, then let a scheduled task call `notify_user`.
- Actual: `revealMainWindow()` creates a loading renderer and `webContents.send('tasks:notify', ...)` fires before `App` subscribes. The dock bounce may happen, but the alert payload/modal is lost.
- Expected: a newly recreated window receives the alert after its renderer is ready.
- Fix direction: route this event through the existing `sendToMain()` did-finish-load guard, or persist pending alerts until acknowledged.

### BUG-008 — Quick Chat cannot display MCP or custom-instructions approval cards

- Affected: `src/renderer/main.tsx:17-24`; `src/renderer/quickchat/QuickChat.tsx:1-427`; `src/main/index.ts:1717-1724`; `src/main/pi/runtime.ts:1310-1316,1345-1351`.
- Reproduction: with the main window closed/ignored, ask Quick Chat to add/remove MCP configuration or change standing instructions.
- Actual: main broadcasts the proposal to Quick Chat, but `QuickChat` mounts neither approval component. The tool call stalls until its 120-second rejection timeout.
- Expected: the originating surface shows and can resolve its approval.
- Fix direction: mount the approval UI in Quick Chat or intentionally reveal/route the proposal to a ready main window.

### BUG-009 — A consolidation chunk can delete/correct facts that were not in its prompt

- Affected: `src/main/recall/consolidate.ts:122-131,245-252`; `src/main/recall/store.ts:1713-1766`.
- Reproduction: set the consolidation chunk size to 3, create 6 facts, and have the first chunk's model response return `drop:[id_of_fact_6]` even though that ID was absent from the first prompt.
- Actual: `clampOps` filters protected IDs but never restricts IDs to the current chunk. `applyConsolidation` validates against every active fact globally and retires fact 6.
- Expected: a model may mutate only IDs shown in that exact prompt.
- Evidence: focused test asserted the victim ID was absent from the prompt, then observed its status change to `superseded`.
- Fix direction: pass a per-chunk allowed-ID set to the clamp, reject duplicate IDs, and reject rather than partially rewrite invalid merge groups.

### BUG-010 — Replacing an MCP server name can send the old server's OAuth token to the new URL

- Affected: `src/main/pi/mcp.ts:54-88`; `src/main/pi/mcp-config.ts:138-179`; analogous assistant-managed replacement at `src/main/pi/stem-mcp-extension.mjs:1175-1184` and removal at `1203-1215`.
- Reproduction: add `calendar -> https://old.example/mcp`, save its OAuth token, then add `calendar -> https://new.example/mcp`.
- Actual: the config entry is overwritten but `mcp-oauth.json[calendar]` remains. On restart the bridge can attach the old credential to the new origin. Assistant-managed removal also leaves the token behind.
- Expected: replacing a server identity invalidates its prior token; removal deletes it.
- Evidence: focused test replaced the URL and still read `old-secret-token` under `calendar`.
- Fix direction: delete tokens on transport/URL/client-identity replacement and in both removal paths; consider keying credentials by normalized resource origin rather than display name.

### BUG-011 — `--profile=..` escapes the intended alternate-profile container

- Affected: `src/main/workspace/paths.ts:28-50`.
- Reproduction: call `resolveProfileOverride(['node','app','--profile=..'], {}, '/appdata')` or launch with `--profile=..`.
- Actual: the allowed-character sanitizer preserves `..`; `join('/appdata/Stem Profiles', '..')` resolves to `/appdata`. A single dot also aliases the container rather than a distinct profile.
- Expected: every named profile is a distinct child of `Stem Profiles/`.
- Evidence: focused test returned `{ label:'..', userDataDir:'/appdata' }`.
- Fix direction: reject `.`/`..`, require a non-special basename, resolve the final path, and enforce containment with `relative()`.

### BUG-012 — Clearing facts can be undone by an in-flight distillation/rebuild

- Affected: `src/main/recall/distill.ts:377-486`; `src/main/recall/rebuild.ts:61-139`; `src/main/recall/store.ts:1660-1676`; reset IPC at `src/main/index.ts:1047`.
- Reproduction: begin a distillation call, clear facts while its LLM promise is pending, then resolve the model with a claim from the pre-reset batch.
- Actual: the asynchronous pass has no generation/cancellation check after the await and writes the fact after `resetFacts()` completed. The UI can report “Facts cleared” while old facts reappear.
- Expected: reset is a barrier after which work started against an older generation cannot write.
- Evidence: focused deferred-LLM test called `resetFacts()` mid-flight and then observed `The user prefers violet notebooks.` recreated.
- Fix direction: maintain a reset generation/epoch and verify it before writes, or serialize/cancel all fact-producing jobs around reset.

## Medium severity

### BUG-013 — Scheduler ignores backend `process/exit` and blocks its queue for 15 minutes

- Affected: `src/main/scheduler/index.ts:391-414`; runtime emits the threadless event at `src/main/pi/runtime.ts:991-997`.
- Reproduction: start a scheduled turn, emit `{ method:'process/exit', params:{code,signal} }`, and observe the task.
- Actual: `waitForSettle` requires a matching turn/thread before reaching its `process/exit` branch. A process exit has neither, so the branch is unreachable; the task stays `running` and serialized tasks wait for `RUN_TIMEOUT_MS`.
- Expected: any backend process exit settles the active scheduled run immediately as failed.
- Evidence: probe output was `STILL_PENDING_AFTER_PROCESS_EXIT`.
- Fix direction: handle `process/exit` before turn/thread matching; also interrupt/clean up a turn when the 15-minute timeout itself fires.

### BUG-014 — Concurrent file adds overwrite one another despite collision naming

- Affected: `src/main/files/store.ts:63-75,87-100`.
- Reproduction: concurrently add many different source files that share the basename `same.txt`.
- Actual: `uniquePath()` performs `access()` and later `copyFile()` without an exclusive flag or mutation queue. Multiple callers choose the same destination and overwrite it.
- Expected: every submitted file is stored under a unique suffix.
- Evidence: 40 concurrent adds produced `{"submitted":40,"stored":2,"names":["same-1.txt","same.txt"]}`.
- Fix direction: serialize mutations or reserve the destination atomically (`COPYFILE_EXCL`/exclusive create with retry).

### BUG-015 — Chat search's 200-row cap is applied before grouping by thread

- Affected: `src/main/chatsearch/store.ts:150-177`; `src/main/chatsearch/search.ts:19-48`.
- Reproduction: index 250 matching messages in one chat and one matching message in a second chat, then search for the common term.
- Actual: the first chat consumes all 200 database rows, so grouping sees only that thread and silently omits the second matching chat.
- Expected: the thread limit applies after grouping, or the query selects each thread's best row in SQL.
- Evidence: the probe returned only `["noisy"]` instead of both thread IDs.
- Fix direction: use a window function/grouped subquery (`ROW_NUMBER() OVER (PARTITION BY thread_id ...)`) and limit the grouped results.

### BUG-016 — Live chat reindex stores seconds while the backfill compares milliseconds

- Affected: `src/main/chatsearch/index-sync.ts:22-49,65-84`; runtime thread timestamps are `mtimeMs` at `src/main/pi/runtime.ts:1528-1538,1583`.
- Reproduction: call `reindexChatThread()` for an unchanged thread and then run `backfillChatIndex()` with the runtime's millisecond `updatedAt`.
- Actual: live reindex writes `Math.floor(Date.now()/1000)` as the watermark. Backfill compares it to a millisecond timestamp, always considers the thread stale, and rereads/reindexes it. After normal live use, launch backfill can redo every chat.
- Expected: watermark and runtime timestamps use the same unit.
- Evidence: focused test observed `watermark < updatedAt` and `readThread` called twice for an unchanged thread.
- Fix direction: standardize `ChatSummary` timestamps (prefer ms, matching runtime) and normalize at the index boundary.

### BUG-017 — Skill distillation advances past messages it truncated out of the prompt

- Affected: `src/main/skills/distill.ts:152-187`.
- Reproduction: capture a >24,000-character message followed by a second message containing a reusable procedure, then run skill distillation.
- Actual: `.slice(0, MAX_TRANSCRIPT_CHARS)` removes the second message, but the watermark advances to the maximum ID of the entire 200-message batch. The unseen procedure is never considered later.
- Expected: advance only through characters/messages actually sent to the model, using a resumable cursor like fact distillation.
- Evidence: focused test confirmed the marker was absent from the prompt while the watermark advanced to the marker message's ID.
- Fix direction: build a bounded batch incrementally and persist message ID plus offset.

### BUG-018 — Recall deduplication drops legitimate repeated messages from later turns

- Affected: `src/main/recall/store.ts:116-118,499-521`.
- Reproduction: record identical user text in the same thread under `turn-1` and later `turn-2`.
- Actual: `dedup_key` is based only on `(threadId, role, text)`, so the second real occurrence is ignored. Its timestamp/turn/evidence never reaches search, summaries, or distillation.
- Expected: only duplicate capture of the same event is idempotent; a repeated message in a different turn remains a separate event.
- Evidence: focused test recorded two turns and observed `messageCount() === 1`, retaining only `turn-1`.
- Fix direction: include a stable event/turn identity in the dedup key; define a separate fallback only for truly ID-less captures.

### BUG-019 — Negated memory requests such as “Never remember that …” are saved

- Affected: `src/main/workspace/memory.ts:93-148`.
- Reproduction: send `Never remember that my favorite color is violet.` (curly-apostrophe `Don’t remember...` has the same class of failure).
- Actual: the negative filter only recognizes a narrow ASCII set. The positive `remember that` pattern wins, strips those words, stores `Never my favorite color is violet`, and returns the “I'll remember that” shortcut response.
- Expected: explicit negation never writes memory.
- Evidence: focused test observed `captured:true` and the malformed fact in the fact store.
- Fix direction: use intent parsing anchored around the remember verb, normalize apostrophes, and explicitly reject `never`, `do not`, `don't`, `don’t`, `please don't`, and similar scopes before extraction.

### BUG-020 — Restoring an expired fact works only until the next injection read

- Affected: `src/main/recall/store.ts:999-1005,1090-1103`.
- Reproduction: create a fact with `validUntil` in the past, expire it, click Restore, then call `getInjectableFacts()`.
- Actual: restore sets status active but leaves the old `valid_until`. The next injectable-facts read immediately expires it again.
- Expected: Restore has durable semantics or clearly refuses an expired fact.
- Evidence: focused test observed `active` immediately after restore and `superseded` again after the next injectable read.
- Fix direction: clear/renew validity on explicit restore, or require the user to choose a new expiration.

### BUG-021 — Tiny old threads can permanently starve dormant summary backfill

- Affected: `src/main/recall/summarize.ts:114-145,162-173`; candidate selection at `src/main/recall/store.ts:1542-1558`.
- Reproduction: create three old one-message trivial threads and a newer eligible two-message thread; run `backfillSummaries(..., 3)` repeatedly.
- Actual: the same three tiny threads always occupy the oldest three slots. The noise gate returns without advancing any watermark/tombstone, so the eligible thread is never selected.
- Expected: permanently skipped noise does not remain at the head of the work queue.
- Evidence: focused test observed zero LLM calls/writes and no summary for the eligible thread.
- Fix direction: persist a skipped-through watermark/status for trivial threads, or fetch beyond the requested limit until enough eligible work is found.

### BUG-022 — Impossible cron expressions are accepted as successful enabled tasks

- Affected: `src/main/scheduler/index.ts:191-223`; `src/main/scheduler/cron.ts:132-150`.
- Reproduction: create a task with `0 0 30 2 *`.
- Actual: syntactic validation succeeds, `nextAfter()` scans roughly five years of minutes and returns null, and task creation still returns success with `enabled:true,nextRunAt:null`. It never fires and the synchronous scan blocks main for about 0.5 seconds in the probe.
- Expected: creation rejects schedules with no reachable next occurrence.
- Fix direction: compute the first occurrence during validation and return a clear error when null; optimize calendar stepping to avoid minute-by-minute main-thread scans.

### BUG-023 — The cron parser accepts malformed fields as different schedules

- Affected: `src/main/scheduler/cron.ts:41-82`.
- Reproduction: validate `-1 * * * *`, `1e1 * * * *`, `+5 * * * *`, or `1-2-3 * * * *`.
- Actual: JavaScript `Number()` accepts exponent/plus notation, and `split('-')` ignores extra pieces/turns an empty left side into zero. Examples were accepted as `[0,1]`, `[10]`, `[5]`, and `[1,2]` respectively.
- Expected: only the documented decimal/range/step grammar is accepted.
- Fix direction: validate tokens with strict regular expressions before numeric conversion and require exact range arity.

### BUG-024 — Concurrent MCP config/token mutations lose updates and reject most callers

- Affected: read-modify-write calls in `src/main/pi/mcp.ts:54-113`; fixed temp path in `src/main/pi/mcp-config.ts:161-179`.
- Reproduction: issue 20 concurrent `addMcpServer` calls.
- Actual: every caller reads a stale snapshot and writes the same `<path>.tmp`; renames collide. The probe fulfilled 1 call, rejected 19, and persisted 1 server. OAuth token save/delete has the same unqueued read-modify-write pattern.
- Expected: concurrent mutations serialize and preserve every non-conflicting update.
- Evidence: `{"fulfilled":1,"rejected":19,"saved":1}`.
- Fix direction: add a module-level write queue and unique temp files; perform each read-modify-write inside the serialized task.

### BUG-025 — MCP servers that fail initial connection are never retried in later sessions

- Affected: `src/main/pi/stem-mcp-extension.mjs:750-833`.
- Reproduction: start the bridge while a configured server is down, then bring it online and start/switch sessions without restarting the whole process.
- Actual: failed clients are omitted from the retained client maps. The reconnect predicate checks only retained clients, so an empty/success-only set passes and the failed server is never attempted again.
- Expected: failed configured servers are retried with bounded backoff or at least on a later session start.
- Evidence: after the server came online, the second factory call made `requests:0` and status remained failed.
- Fix direction: retain desired-server state separately from connected clients and retry failed entries.

### BUG-026 — Chat-search's 4-second timeout leaves the underlying model call running for up to 120 seconds

- Affected: `src/main/chatsearch/expand.ts:70-102`; wiring at `src/main/index.ts:1133-1138`; completion timeout at `src/main/pi/runtime.ts:503-568`.
- Reproduction: use an LLM completion that takes longer than four seconds and perform repeated searches.
- Actual: `withTimeout` rejects only its wrapper. The child completion continues generating/consuming resources until its independent 120-second timeout; repeated searches can stack hidden work.
- Expected: timeout cancels or bounds the underlying completion itself.
- Evidence: fallback returned at 4002 ms with `underlyingSettled:false`.
- Fix direction: pass a 4-second timeout/abort signal into `runtime.complete`, or expose cancellable completion.

### BUG-027 — A rejected model selection silently sends the turn to the previous model

- Affected: `src/main/pi/runtime.ts:385-390,1386-1391`.
- Reproduction: make the `set_model` RPC return `success:false`, then start a turn specifying the rejected model.
- Actual: `applyModel` does not throw and updates nothing; `startTurn` continues on the prior model with no user-visible warning.
- Expected: the turn fails before content is sent, or the UI explicitly confirms a fallback.
- Evidence: probe printed `{"threw":false,"currentModel":"openai-codex/old"}`.
- Fix direction: validate RPC success and propagate the error before building/sending the prompt.

### BUG-028 — Backend crash during Quick Chat leaves the HUD and ownership state stuck

- Affected: `src/main/index.ts:674-689,1345-1360,1742-1760`; exit emitted at `src/main/pi/runtime.ts:991-997`.
- Reproduction: crash/kill the backend during a Quick Chat turn while the overlay is hidden behind its HUD.
- Actual: the threadless exit branch clears main-thread tracking and hides only a main-owned HUD. It does not clear `overlayTurnRunning` or a quickchat-owned HUD, so “Working…” can persist forever and inactivity auto-reset remains disabled.
- Expected: process exit settles both surfaces and their native HUD state.
- Fix direction: centralize process-exit cleanup for overlay state and drive a failed/stopped HUD transition.

### BUG-029 — Navigating away from a new draft before start IPC resolves drops its user bubble

- Affected: `src/renderer/App.tsx:473-480,521-554,700-720`; navigation entry points in `src/renderer/chats/ChatList.tsx:333-347,428-433`.
- Reproduction: send the first prompt in a draft, then immediately open another chat or press New Thread.
- Actual: when `stillMine` becomes false, the real-thread slice is created as running without merging the draft messages. Later `openChat()` refuses hydration because a live slice exists, yielding assistant output without the initiating prompt until restart.
- Expected: the sent draft snapshot follows its background thread without stealing current focus.
- Fix direction: always migrate/merge the send's captured draft into the real ID; gate only the focus change on `stillMine`.

### BUG-030 — Starting a new Quick Chat strands the old running thread as assistant-only state

- Affected: `src/renderer/quickchat/QuickChat.tsx:279-282,329-331`; `src/main/index.ts:1408-1415,1742-1763`; `src/renderer/App.tsx:700-720`.
- Reproduction: reopen a running Quick Chat and click New Thread before its reply finishes.
- Actual: ownership is cleared without aborting or handing off the overlay's user messages. Old-thread deltas reroute to main and construct an assistant-only slice that subsequently blocks disk hydration.
- Expected: abort the old turn or hand off a complete state snapshot before rerouting.
- Fix direction: make “new thread” an explicit lifecycle transition with abort/handoff acknowledgement.

### BUG-031 — Mid-stream Quick Chat handoff is treated as settled

- Affected: `src/shared/types.ts:1139-1148`; `src/renderer/quickchat/QuickChat.tsx:285-289`; `src/renderer/App.tsx:598-611`.
- Reproduction: click Open in Stem while Quick Chat is generating, particularly during a long tool call.
- Actual: the payload carries messages but not `running`, `streamingId`, activities, or active turn ID. Main shows Send and settled actions until another delta happens; during a tool call that correction may take minutes.
- Expected: live turn/Stop state transfers atomically with the messages.
- Fix direction: add the full thread-state fields to `QuickChatHandoff` and merge them in App.

### BUG-032 — Backend-owned turns do not become running on `item/started`

- Affected: `src/renderer/chatState.ts:120-146`; scheduled row insertion at `src/renderer/App.tsx:430-449`; composer/status use in `src/renderer/chat/ChatView.tsx:385-389,617-624`.
- Reproduction: let a scheduled/background turn start with reasoning or a long tool call before any text delta.
- Actual: activity is recorded, but `running` remains false, status stays idle, and there is no spinner, running dot, or Stop control until text arrives.
- Expected: the first owned `item/started` marks that turn running.
- Evidence: focused reducer test reproduced the idle state after a tool-start event.
- Fix direction: update running/status/active turn ID in the reducer's non-agent `item/started` branch.

### BUG-033 — Concurrent chat opens can select or overwrite the wrong chat

- Affected: `src/renderer/App.tsx:700-721`.
- Reproduction: click a large-history chat A, then quickly click smaller chat B.
- Actual: both IPC calls race; whichever resolves last unconditionally calls `setActiveThreadId`. Slow A can steal focus back and can overwrite state that accumulated while its read was pending.
- Expected: only the latest open request may select/replace state.
- Fix direction: use a monotonically increasing open request ID and merge defensively with live state.

### BUG-034 — Retry and Edit discard the original turn's attachments

- Affected: `src/renderer/App.tsx:799-837`; `src/renderer/quickchat/QuickChat.tsx:205-235`.
- Reproduction: attach a file/image, ask about it, then Retry or edit-and-rerun the prompt.
- Actual: both paths call `onSend(text, [])`; the regenerated turn receives no attachment and can answer a different question with missing context.
- Expected: Retry reproduces the complete original inputs; Edit preserves attachments unless the user removes them.
- Fix direction: retain sendable `TurnAttachment` metadata per turn (not just rendered chips) and pass it through rerun.

### BUG-035 — Approval UI drops concurrent proposals and stays stale after timeout

- Affected: `src/renderer/manage/McpApprovalCard.tsx:8-31`; `src/renderer/manage/InstructionsApprovalCard.tsx:24-62`; `src/main/pi/runtime.ts:279-282,1302-1316,1337-1351`.
- Reproduction: one turn issues two parallel MCP-admin or instructions proposals, or leave one proposal unanswered past its runtime timeout.
- Actual: runtime tracks multiple approvals, but each renderer card stores one scalar proposal, so a newer proposal replaces the older one. The hidden call times out. Runtime emits no dismissal event, so an expired card can remain visible and blocking.
- Expected: proposals queue and every resolution/timeout reconciles the UI.
- Fix direction: use an ID-keyed queue and emit explicit resolved/expired events.

### BUG-036 — Bar and area charts misrepresent negative values

- Affected: `src/renderer/mdx/components.tsx:276-280,315-324`.
- Reproduction: render a chart containing `-5` and `-2`.
- Actual: the baseline is `y(min)` rather than `y(0)`. The most-negative bar has zero height/disappears, and other negative bars extend upward as if positive. Area fill uses the same wrong baseline.
- Expected: values are measured from a zero baseline (and the domain includes zero).
- Evidence: server-rendered bar heights were `[0, 94.8]`.
- Fix direction: include zero in the y-domain and compute signed geometry around `y(0)`.

### BUG-037 — A stale local-server probe can validate a newly edited URL/provider

- Affected: `src/renderer/onboarding/OnboardingGate.tsx:384-420,436-473`; save path at `src/main/index.ts:849-871`.
- Reproduction: start Test against a working server, edit the URL or switch provider while it is pending, then let the old test succeed.
- Actual: the stale result sets `test.ok=true` for the new, untested configuration and enables Continue. Save does not re-probe, so onboarding can finish with an unreachable server.
- Expected: a test result is valid only for the exact provider/URL tested.
- Fix direction: tag requests with provider+normalized URL (or an incrementing ID), discard stale responses, and invalidate success immediately on input changes.

## Completion criteria for the fixing agent

- Add a regression test for every fixed bug; prefer pure unit tests and existing environment seams.
- For IPC/state races, include at least one delayed-promise test that proves stale completions cannot win.
- For filesystem policies, test direct paths, symlink aliases, non-existent write targets, and nested roots.
- For destructive Recall/MCP operations, validate allowed identities/IDs at the final write boundary, not only in prompts/UI.
- Run `npm run typecheck`, `npm run lint`, and the full unit suite. Run Electron E2E for renderer/window-lifecycle fixes where the environment permits.
