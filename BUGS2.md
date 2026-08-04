# Open Bug Follow-up

Audit date: 2026-08-04

Checked revision: `dd2f9bb` (`main`) plus the current uncommitted Recall fixes.

Scope: findings discovered while the original `BUGS.md` set was being closed.
This file contains only defects that still need a fix in the current working
tree. Already-fixed findings checked during this pass are recorded separately at
the end so they are not reopened accidentally.

## Summary

| ID | Severity | Area | Result |
| --- | --- | --- | --- |
| BUG-021 | Low | Mobile / Memory audit UI | Past turns derive `disputed` from a fact's current status and can be mislabeled in both directions |

## Open findings

### BUG-021 — Mobile Memory Peek reconstructs a historical `disputed` flag from current state

- Affected:
  - `src/main/pi/runtime.ts:2545-2551`
  - `src/main/recall/store.ts:1187-1235`
  - `src/main/ipc/memory.ts:122-146`
  - `src/renderer/mobile/MemoryPeek.tsx:4-14,50-56`
- Reproduction — false positive:
  1. Complete a turn that injects an ordinary active fact.
  2. Later, put that fact into a conflict.
  3. Open **Memory used in this chat** for the earlier turn on mobile.
  4. The fact is now labeled **conflicting**, although it was not disputed when
     it was injected.
- Reproduction — false negative:
  1. Complete a turn that injects one side of an open conflict as the disputed
     representative.
  2. Later, resolve that conflict so the retained fact is active again.
  3. Open **Memory used in this chat** for the earlier turn on mobile.
  4. The historical **conflicting** label is gone, although the model received
     the fact as disputed on that turn.
- Actual: `buildRecallContext` returns the correct selection-time `Fact.disputed`
  flag, but `runtime.ts` persists only `{ id, reason }` in `active_facts`.
  `getActiveFactIds` therefore cannot recover the flag. The
  `memory:activeFacts` IPC handler guesses with
  `f.status === 'conflicted'`, using the fact's status at read time rather than
  its state when the recorded turn began. The adjacent draft-preview path uses
  the live `f.disputed` value correctly, but that value no longer exists when a
  historical active-facts record is read.
- Expected: the active-facts snapshot preserves whether each fact was injected
  as a disputed representative, and Memory Peek renders that recorded value
  regardless of later conflict lifecycle changes.
- Impact: this does not change what the model receives. It makes the read-only
  audit surface inaccurate, undermining the user's ability to verify what Memory
  actually told a past turn.
- Recommended fix:
  1. Extend the JSON entries stored by `setActiveFacts` to include
     `disputed?: boolean` alongside `id` and `reason`.
  2. Pass `f.disputed` from `runtime.ts` when recording `chosen.facts`.
  3. Parse and return the recorded flag from `getActiveFactIds` and have
     `memory:activeFacts` use it instead of current `f.status`.
  4. Keep legacy numeric and `{ id, reason }` rows compatible by treating an
     absent flag as unknown/false.
  5. Add regression coverage for both lifecycle directions above and for the
     legacy JSON shapes.
- Adversarial verdict: confirmed. Merely changing the IPC condition to
  `f.disputed` is insufficient because `getFactsByIds` returns current database
  rows and does not reconstruct the selection-time disputed representative.

## Checked and excluded — already fixed

The following observations were genuine defects in the pre-fix code, but the
current working tree already contains their fixes and regression coverage. They
do not belong in the open summary.

### `applyAdjudication` deferred-transaction snapshot upgrade

- Pre-fix defect: `applyAdjudication` had the same read-then-write transaction
  shape as BUG-004. A deferred `BEGIN` could fail immediately with
  `SQLITE_BUSY_SNAPSHOT` if another WAL connection committed after the reads.
- Current state: `src/main/recall/store.ts:2143-2147` uses `BEGIN IMMEDIATE`.
- Coverage: `tests/unit/recall-facts-gates.test.ts:57-70` asserts that the write
  lock is taken up front.
- Verdict: true historically; fixed, no further action required.

### Adjudication `LIMIT` applied before eligibility filtering

- Pre-fix defect: `getConflictsForAdjudication` selected the oldest rows under
  the attempts cap, applied `LIMIT`, and only then discarded conflicts with an
  explicit side during hydration. An all-ineligible head window returned no work
  while adjudicable conflicts waited behind it, independently of BUG-007's gate.
- Current state: `src/main/recall/store.ts:1974-1988` applies the shared
  `ADJUDICABLE_CONFLICT_WHERE` predicate in SQL before `ORDER BY ... LIMIT`.
- Coverage: `tests/unit/recall-facts-gates.test.ts:168-177` puts ineligible rows
  first and confirms that a full adjudicable batch is still returned.
- Verdict: true historically; fixed, no further action required.

### BUG-009 blocked-pair queue policy

- Current state: `src/main/recall/store.ts:2060-2068` excludes pairs with a
  currently conflicted side using SQL `NOT EXISTS` before the queue window is
  limited. Their verdict remains `NULL`, so they become eligible immediately
  when the conflict settles; there is no wall-clock retry floor.
- Coverage: `tests/unit/recall-facts-gates.test.ts:194-227` verifies both queue
  fairness and immediate re-entry after `keep_both`.
- Verdict: the SQL exclusion is preferable to a timestamp defer and is already
  implemented; no further action required.

## Validation

- `npm test -- --run tests/unit/recall-facts-gates.test.ts tests/unit/relation-queue.test.ts`
  passed: 2 files, 19 tests.
- No product code or existing audit file was changed by this follow-up.
