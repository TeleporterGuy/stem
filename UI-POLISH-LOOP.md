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
- To avoid dirtying the real profile, launch with `STEM_FRESH=1` or
  `STEM_PROFILE=uiloop` (see `src/main/index.ts` ~line 145). A fresh profile
  shows the onboarding wizard — that's also a surface worth checking.
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

## Backlog

- [ ] Text truncated with `…` instead of being fully visible — find the
      places where labels/values ellipsize even though space exists or
      wrapping would work (chat list? settings rows? fact/skill names?).
      Fix the worst offender; file the rest as separate items.
- [ ] `+` / `-` buttons rendered on the same line, cramped together —
      separate/space them properly.
- [ ] Test row sits alone on its own line and looks orphaned; its result
      ("test is good") only appears after pressing it. Show the state
      inline/at rest and integrate the row visually with its context.
