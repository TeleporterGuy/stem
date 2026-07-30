# Verified Bug Audit

Audit date: 2026-07-30
Audited revision: `994721b` (`main`)

Scope: the current repository, with emphasis on features added since the previous completed audit: the mobile bridge, web search, and custom OpenAI-compatible providers.

This is an identification-only handoff. No application code was changed. Every finding below survived an adversarial second pass that looked for downstream validation, intended-behavior explanations, and existing safeguards.

## Remediation status — complete

All six findings were fixed on 2026-07-30, one commit each. The audit text below
is retained as the evidence and handoff record; its “Actual” descriptions
document the pre-fix behavior.

Two findings turned out to be different from the report once the code was
re-read, and the fixes reflect the code rather than the report:

- **BUG-005 needed more than the gate.** The report assumed rewriting
  `web-search.json` was sufficient, quoting `writeWebSearchConfig`'s own comment
  that pi-web-access "re-reads the file lazily (mtime-cached per module)". That
  comment was wrong: in the installed `pi-web-access@0.15.0`, every backend
  module (`brave.ts`, `exa.ts`, `tavily.ts`, `searxng.ts`, …) does
  `if (cachedConfig) return cachedConfig;` with no invalidation, so a key a
  running backend has already read is frozen until the next spawn. Only
  `provider` is re-read per call — which is why the pre-existing
  `'provider' in patch` branch appeared to work. A credential change now also
  respawns the backend, debounced (Settings persists keys per keystroke) and
  skipped while a turn is streaming. The false comment was corrected.
- **BUG-001's `files:preview` had no phone caller at all.** It is reached only
  from the `att.path` branch of `renderer/attachments.ts`, and a phone's
  attachments are always base64. Rather than containment-checking it, it was
  removed from the mobile allowlist — it cannot be restricted globally, because
  the desktop legitimately previews dialog/drop-picked images from anywhere on
  disk.

Two smaller things were fixed alongside, both found while verifying:

- `backend:startTurn` also let a phone forge `scheduled`, the scheduler's
  headless-run marker. It is now dropped from mobile calls.
- `readModelsConfig`'s `.corrupt` quarantine path raced exactly as the `.tmp`
  path did, and got the same per-writer naming.

Each fix carries a regression test, and the three with a plausible ordering or
gating subtlety were confirmed to fail against the unfixed code before being
committed: the mobile busy-mark race (BUG-004), the models.json disconnect race
(BUG-003), and the web-search credential-only edit (BUG-005). The first e2e
attempt at BUG-005 passed against the unfixed handler — it switched backends
afterwards, which rewrites the config for its own reasons — and was replaced
with a credential-only test that does not.

Final verification after implementation:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- Production build (`npm run build`): passed.
- Unit suite: 844 passed across 61 files, 0 skipped. (The audit's own run
  reported 795 passed / 25 skipped plus six socket failures; this machine did
  not hit the `listen(127.0.0.1)` `EPERM` restriction the audit sandbox did, so
  the mobile socket tests ran and passed.)
- Electron E2E: 45 passed, 5 skipped (the real-credential and Linux-only
  scenarios the suite skips by design).

## Summary

| ID | Severity | Area | Result |
| --- | --- | --- | --- |
| BUG-001 | High | Mobile / attachments | A paired client can read arbitrary process-readable files from the Mac |
| BUG-002 | High | Mobile / settings | `settings:get` returns stored API keys to paired clients |
| BUG-003 | High | Provider configuration | Concurrent model-config syncs can reject, lose updates, or resurrect a disconnected provider and key |
| BUG-004 | Medium | Mobile / scheduler | A fast phone turn can leave the scheduler blocked indefinitely |
| BUG-005 | Medium | Web search | Credential-only edits do not reach the active search configuration |
| BUG-006 | Medium | Provider settings UI | A stale connection test can populate model IDs for a different endpoint |

## High severity

### BUG-001 — A crafted mobile turn can read arbitrary files from the Mac

- Affected:
  - `src/main/mobile/channels.ts:39-47,67-69`
  - `src/main/ipc/guard.ts:21-27,51,58`
  - `src/main/index.ts:884-898`
  - `src/main/ipc/workspace.ts:53-59`
  - `src/main/pi/attachments.ts:81-90,103-110,115-142`
  - `src/main/pi/runtime.ts:2162-2170`
- Reproduction:
  1. Pair a phone, or otherwise use a valid mobile bearer token.
  2. Call `POST /rpc` with channel `backend:startTurn` and an object containing an attachment such as `{ "name": "secret.txt", "path": "/absolute/path/to/a/readable/file" }`.
  3. Ask the model to repeat or summarize the attached file.
  4. For an image, call the separately allowlisted `files:preview` channel with an arbitrary `.png`, `.jpg`, `.gif`, or `.webp` path to receive its bytes directly as a data URL.
- Actual: the mobile boundary validates only that `backend:startTurn` receives an object and `files:preview` receives a string. The shared attachment resolver trusts desktop-style `path` attachments, reads the supplied path with `readFile`, and inserts text into the prompt. `files:preview` likewise reads any supported image path. The shipped mobile UI sends base64 attachments, but the server does not enforce that contract.
- Expected: mobile calls must reject path-based attachments. Mobile previews must be restricted to an explicitly authorized file/root, or the channel should not be exposed remotely.
- Impact: possession of a pairing token grants a direct, approval-free path to process-readable files outside the Files place and connected folders.
- Adversarial verdict: confirmed. No containment, canonicalization, attachment-origin check, or mobile-specific input validation exists downstream.

### BUG-002 — `settings:get` discloses stored API keys to every paired mobile client

- Affected:
  - `src/main/index.ts:961-963`
  - `src/main/mobile/channels.ts:76-77`
  - `src/main/mobile/server.ts:179-197`
  - `src/main/workspace/settings.ts:275-295,308-335`
  - `src/shared/types.ts:172-190,1149-1168,1240-1250,1279-1289`
- Reproduction:
  1. Pair a phone and obtain the mobile bearer token.
  2. Call `POST /rpc` with `{ "channel": "settings:get", "args": [] }`.
  3. Inspect the returned `AppSettings`.
- Actual: the handler returns the full result of `readSettings()` without redaction. That object includes web-search credentials, remote embedding/reranker keys, and the custom OpenAI-compatible endpoint key.
- Expected: the phone should receive a purpose-built, non-secret settings projection containing only fields it renders. API keys must never cross the mobile bridge.
- Impact: a leaked or retained pairing token exposes credentials unrelated to mobile chat, even though the mobile allowlist describes `settings:get` as serving model labels and note-mode configuration.
- Adversarial verdict: confirmed. Authentication and origin checks restrict who can call the channel, but no response redaction exists after authorization.

### BUG-003 — Concurrent model-config syncs can resurrect a disconnected provider and secret

- Affected:
  - `src/main/pi/models-config.ts:124-149,164-190`
  - `src/main/pi/runtime.ts:2378-2386`
  - `src/main/ipc/auth.ts:56-84`
- Reproduction:
  1. Enable a custom provider with an API key.
  2. Let the background local-model refresh begin a `syncModelsConfig()` call.
  3. Before its probe/write finishes, disconnect that provider, which starts a second `syncModelsConfig()` with the provider disabled.
  4. Allow the older sync to finish after the disconnect sync.
- Actual: `syncModelsConfig()` is an unqueued read-modify-write. Every writer uses the same `<models.json>.tmp` path. Two adversarial probes established both failure modes:
  - two concurrent syncs produced one `ENOENT` rename rejection while the final file contained data from the rejected caller, demonstrating cross-talk through the shared temporary file;
  - a delayed stale “provider enabled” sync followed by a disconnect sync finished with the disconnected custom provider and its old key present again.
- Expected: model-config mutations must be serialized, use unique temporary files, and prevent work based on an older settings generation from committing after a newer disconnect.
- Impact: provider operations can fail spuriously, lose updates, or restore a provider/key the user just removed.
- Adversarial verdict: confirmed with two runtime probes outside the repository. Real overlap exists between background model refresh and provider connect/disconnect handlers.

## Medium severity

### BUG-004 — A terminal event racing the phone's start response can block scheduled tasks indefinitely

- Affected:
  - `src/main/startup/mobile.ts:35-63,126-143`
  - `src/main/index.ts:1275-1289,1438-1445`
  - `src/main/pi/runtime.ts:599-614,630-658`
  - analogous race handling already present in `src/renderer/session/turns.ts:39-56,302-307`
- Reproduction:
  1. Start a very fast new turn from the phone.
  2. Have the backend emit `turn/completed`, `turn/failed`, or `turn/aborted` before the `/rpc` `backend:startTurn` call returns.
  3. Check `mobileTurnsInFlight()` or wait for a scheduled task.
- Actual: the terminal event deletes the thread from `mobileTurns` before it has been added. When `dispatchLocal('backend:startTurn')` later resolves, `dispatch()` adds the already-settled thread. No later terminal event removes it, so `busyWithin()` continues to report user activity and scheduled tasks remain deferred until the backend exits or the mobile server restarts.
- Expected: terminal-before-start-response ordering must not create a live busy mark. Registration should happen before terminal events can win, or settled IDs/generations should be reconciled when the response arrives.
- Evidence: the runtime can emit a terminal event after the prompt acknowledgement but before `startTurn()` returns, especially while a new chat awaits `set_session_name`. The shared renderer explicitly implements a settled-before-start-response guard for the same supported ordering.
- Adversarial verdict: confirmed by control-flow trace; the delete-before-add sequence has no compensating cleanup path.

### BUG-005 — Web-search credential edits are persisted but not applied live

- Affected:
  - `src/main/index.ts:981-991`
  - `src/renderer/manage/tabs/SettingsTab.tsx:1088-1102`
  - `src/shared/types.ts:1149-1168`
  - `src/main/pi/web-search.ts:125-152`
- Reproduction:
  1. Select a keyed search backend such as Brave.
  2. Enter or change its key without changing the selected backend.
  3. Confirm that Settings shows the saved value, then inspect `web-search.json` or run a search.
- Actual: the renderer sends `{ credentials: ... }`, but the main-process handler rewrites `web-search.json` only when the patch contains `provider` or the obsolete keys `searxngUrl` / `apiKeys`. A credential-only edit therefore updates `settings.json` while the search extension continues using its previous configuration until another provider change or restart happens.
- Expected: any `credentials` change must rewrite `web-search.json` immediately.
- Impact: the UI reports a backend as configured while live searches still fail or continue using an old key/endpoint.
- Adversarial verdict: confirmed. The current type and UI use `credentials`; no later handler observes that field.

### BUG-006 — A late custom-endpoint test result can configure the wrong server

- Affected:
  - `src/renderer/manage/tabs/SettingsTab.tsx:615-649,703-725`
  - safeguarded onboarding equivalent: `src/renderer/onboarding/OnboardingGate.tsx:476-520`
- Reproduction:
  1. In Settings → AI Providers → Add server, select Custom endpoint A and click **Test connection**.
  2. Before the request completes, change the URL/API key to endpoint B or switch server choices.
  3. Let endpoint A's request resolve.
- Actual: the settings form accepts every response unconditionally. A late successful response can restore a cleared status and auto-fill endpoint A's model IDs into the form now describing endpoint B. The user can then enable B with A's catalog.
- Expected: changing any tested input must invalidate the outstanding request, and a response should commit only if its request generation and complete input snapshot still match.
- Impact: an endpoint can be enabled with model IDs it does not serve, causing missing models or failed turns that appear unrelated to the earlier test.
- Adversarial verdict: confirmed. The onboarding form already uses `RequestGate` for this race, but the Settings form does not.

## Validation

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- Electron E2E: 44 passed, 5 intentionally skipped.
- Unit run excluding the known sandbox-hostile embed endpoint: 795 tests passed, 25 skipped. Four mobile socket tests and two suite hooks failed because this sandbox rejected `listen(127.0.0.1)` with `EPERM`; those failures were treated as environment restrictions, not product bugs.
- One adversarial sub-agent independently challenged every reported finding. It rejected a separate “world-readable secrets” claim because this Mac's enclosing `~/Library` and `Application Support` directories are mode `0700`; that claim is intentionally absent from this report.
