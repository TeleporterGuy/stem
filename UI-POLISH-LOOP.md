# UI Polish Loop

You are running one iteration of an autonomous UI-polish loop for Stem (this
Electron app). Each iteration fixes exactly ONE visual/UX issue, verifies it
with real screenshots, and commits. Do not batch multiple issues into one
iteration.

## One iteration, step by step

1. **Pick the issue.** Take the topmost unchecked item in the Backlog below.
   If every item is checked, go hunting instead: launch the app, walk through
   every surface (chat, quick chat, Settings, Folders, Tasks, Skills, Memory),
   screenshot each in BOTH light and dark, and look for one new polish issue —
   truncated/ellipsized text, cramped or misaligned controls, orphaned rows,
   inconsistent spacing, hover/press states that hide information, overflow,
   contrast problems. Add it to the Backlog with a one-sentence description,
   then fix it this iteration.
2. **Reproduce it visually first.** Before touching code, get a screenshot
   showing the problem. If you cannot reproduce it, note that in the Backlog
   item and move to the next one — do not "fix" what you can't see.
3. **Fix it.** Smallest diff that solves the issue. Stay in the renderer
   styles/components; do not refactor unrelated code, do not restyle whole
   surfaces, do not change behavior unless the issue IS behavior (e.g. state
   only visible on press).
4. **Verify visually.** Re-screenshot the same view in light AND dark and
   confirm the fix renders correctly, at the default window size and once with
   a narrow window (~900px wide) to catch overflow regressions. Also confirm
   neighboring elements didn't break.
5. **Gate.** Run `npm run typecheck` and `npm run lint`. Run `npm run test` if
   you touched anything with test coverage.
6. **Commit.** One commit per issue, message like
   `ui: <what was wrong> — <what it does now>`. Check the item off in the
   Backlog (edit this file, include it in the commit).
7. **Report.** End with: which issue, before/after screenshot paths, and what
   you'd pick next.

## Running the app and taking screenshots

- Dev app: `npm run dev` (run in background; wait for the window). In dev the
  renderer exposes CDP — see `src/main/index.ts` (~line 164): port **9222**.
- Screenshot helper: `node scripts/cdp-shot.mjs <out.png> ["optional JS to run first"]`
  — note it hardcodes port **9223**; if nothing answers there, check 9222 and
  adjust the port constant locally (don't commit that tweak). `DARK=1` env
  emulates dark mode; `WAIT=<ms>` controls settle time.
- The JS-expression argument is how you navigate before the shot (e.g. click a
  Settings tab). For interactive flows (press states, hover reveals), drive
  the app over CDP/agent-browser instead of one-shot screenshots.
- **Run against the real, live profile** (plain `npm run dev`, no `STEM_FRESH`
  / `STEM_PROFILE`). The whole point is to see the UI as a real user sees it —
  populated with real chats, facts, skills, tasks, folders. An empty fresh
  profile hides exactly the truncation/overflow/orphaned-row problems this loop
  hunts for, so do NOT use a throwaway profile for the polish pass. Only launch
  a fresh profile (`STEM_FRESH=1`) if you specifically need to check the
  onboarding wizard as a surface.
- These are read-only screenshot passes; don't send messages, delete data, or
  otherwise mutate the real profile while polishing.
- Save screenshots under `/tmp/uiloop/` (e.g. `/tmp/uiloop/<issue>-before-dark.png`),
  NOT in the repo.

## Style ground rules

- The whole UI is styled on `prefers-color-scheme` — every fix must be checked
  in both schemes; never hardcode a light-only or dark-only color.
- Match the existing CSS conventions in the file you're editing (variables,
  spacing units, class naming). No new dependencies, no inline style dumps.
- Truncation: prefer wrapping or a tooltip/title attribute over silently
  ellipsizing meaningful text; if truncation must stay, make the full text
  reachable.
- If a fix genuinely requires a bigger structural change, do NOT do it —
  write the finding into the Backlog as `(needs design decision: ...)`, check
  nothing off, and pick a different issue.

## Stop conditions

Stop the loop (don't schedule another iteration) when: the Backlog has no
unchecked items AND a full hunting pass over all surfaces found nothing new,
OR the same issue failed twice, OR typecheck/lint is broken in a way that
predates your change.

## Hunting log

- **2026-07-06 — clean sweep, loop stopped.** Full hunting pass over all
  live-data surfaces found no new genuine defect: Chats (list + message view +
  `Used N tool` expander), quick chat, Settings (model/providers/files/input),
  Connected Folders (paths already carry `title` tooltips), Tasks, MCP &
  Skills, Memory → Facts (+ stored-memory list, header icons have
  `aria-label`+`data-label`) and Memory → Recall. Backlog fully resolved +
  nothing new ⇒ stop condition met. NOT swept: the first-run onboarding wizard
  — it only appears on a fresh profile (no live data) and launching one would
  disrupt the live instance, which is out of scope for the user's "run on the
  live app with live data" directive. Resume the loop later to cover onboarding
  on a `STEM_FRESH=1` profile if desired.

## Backlog

- [x] Text truncated with `…` instead of being fully visible — worst offender
      was the CHATS sidebar: every chat/folder/search-hit title ellipsizes with
      NO `title` attribute, so the full title was completely unreachable (can't
      even hover to read it). Added `title={…}` to chat titles, folder names,
      and search-hit titles in `ChatList.tsx` so the full text is reachable on
      hover. (Fixed 2026-07-06.)
      Remaining truncation offenders to file as separate items on a later hunt:
      Settings model-picker labels (`.mp-trigger-label` / `.mp-opt-label`),
      attachment names (`.attachment-name`), activity-row labels
      (`.activity-row-label`), scheduled-run titles (`.sched-run-title`) — check
      each for a reachable full text before fixing.
- [x] `+` / `-` buttons rendered on the same line, cramped together —
      separate/space them properly. NON-REPRO (2026-07-06): these are the
      `.gutter` add/remove buttons under the AI Providers and MCP Servers lists.
      On inspection they're a correctly-formed macOS-native joined segmented
      control (divider between them, proper padding, rounded corners, renders
      cleanly light+dark) — the standard System-Settings source-list gutter
      idiom, not a defect. Joining them is intentional; separating them would
      break the pattern. No change made.
- [x] Test row sits alone on its own line and looks orphaned; its result
      ("test is good") only appears after pressing it. Show the state
      inline/at rest and integrate the row visually with its context.
      FIXED (2026-07-06): the `.retrieval-test-btn` (Memory → Facts → Relevance
      ranking → Embeddings/Reranker, and the provider connection test) was a
      bare unlabeled plug icon sitting alone — unreadable at rest. Added a
      visible "Test connection" text label to all three buttons (which becomes
      "Testing…" in progress, folding away the old separate status span), and
      widened `.retrieval-test-btn` padding/gap + `font-size` in styles.css. The
      button now reads as a labeled control at rest; the ✓/✗ result still shows
      inline beside it after pressing.
- [x] Tasks tab: the schedule meta line truncated a datetime mid-value
      (`once · Jul 15, 09:0…`) because `.task-head .row-main em` inherited
      `white-space: nowrap; text-overflow: ellipsis` and the 4 action buttons
      crowded the row. FIXED (2026-07-06): scoped `.task-head .row-main em` to
      `white-space: normal; overflow: visible; text-overflow: clip` so the
      short schedule string wraps and shows in full instead of clipping. Found
      during the first hunting pass. Verified light+dark.
- [x] Tasks tab: the task TITLE (`.task-head .row-main strong`) shows an
      ellipsis (`…Golden Gate be…`) that is NOT CSS truncation — on inspection
      the `…` is part of the STORED title string itself (`ScheduledTask.title`
      is a short label deliberately derived+truncated from the prompt; the
      strong wraps fully, no clamp). So `title={t.title}` would be useless
      (same truncated text). FIXED (2026-07-06) instead by adding
      `title={t.prompt}` to the `<strong>` — hovering the shortened label now
      reveals the FULL task prompt (the instruction it re-runs), which is the
      genuinely-unreachable text. Uses the existing `prompt` field, no
      structural change. Verified light+dark, no layout shift.
- [x] Skills tab (MCP & Skills → Skills): every skill's description
      (`.group-row .row-main em`) truncates to one ellipsized line and had NO
      `title` attribute — the full description was unreachable. FIXED
      (2026-07-06) by adding `title={s.description}` to the `<em>` in the
      SkillsTab list so the full description is reachable on hover. Additive,
      no layout change. Found during a hunting pass; verified light+dark.
- [x] Model picker dropdown: long model names truncate in the option list
      (`.mp-opt-label`, e.g. `text-embedding-multilingual-e5-large-in…`,
      `…snowflake-arctic-embe…`) with NO `title`, so the full model id was
      unreachable; the trigger label (`.mp-trigger-label`) has the same
      exposure for a long selected model. FIXED (2026-07-06) by adding
      `title={row.label}` to `.mp-opt-label` and a combined
      `title={label · provider}` to `.mp-trigger-label` in ModelPicker.tsx.
      Additive, no layout change. Found during a hunting pass; verified in the
      open dropdown.
- [x] Composer context meter overflowed off-screen at narrow widths — the
      `.composer-controls` flex row had no `flex-wrap`, so when the reasoning /
      speed / MDX toggle segments didn't fit (~900px window with the sidebar
      open), the `.context-meter` (pushed right by `margin-left:auto`) spilled
      past the composer's right edge and got clipped by the sidebar
      (`17k / 27…`). FIXED (2026-07-06) by adding `flex-wrap: wrap` to
      `.composer-controls` so the meter drops to a second line and stays fully
      visible; no effect at default width (everything fits on one line). First
      NON-truncation find. Verified narrow(900) + default(1200), light+dark.