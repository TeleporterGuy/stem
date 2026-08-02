---
name: release-notes
description: Draft or cut a RELEASE_NOTES.md section for Stem. Use when the user asks to write release notes, update the changelog, note what's shipped since the last tag, or cut a release. Reads the git log since the last tag and writes user-facing entries in the file's house voice.
---

# Release notes

`RELEASE_NOTES.md` at the repo root is what Stem's users read. The app parses it into
`## <version> — <date>` sections and shows the new ones in a popup the first time
someone opens a build they haven't seen (`src/main/workspace/release-notes.ts`).

Two modes. Pick from what the user asked; if it's ambiguous, draft.

## Mode 1 — draft (default)

Write up everything shipped since the last release into the top section.

1. **Find the range.** `git describe --tags --abbrev=0` for the last tag, then
   `git log --pretty='%h %ad %s' --date=short <tag>..HEAD --no-merges`. Honour an
   explicit range if the user gave one.
2. **Read the current top section** of `RELEASE_NOTES.md`. If it already has an
   `Unreleased` heading, you are *extending* it — re-read its bullets and merge, never
   append a second copy of something already described. If the top section is a dated
   release, open a new `## <next-version> — Unreleased` above it (patch bump for
   fixes only, minor bump if anything was added).
3. **Understand each commit before writing about it.** A subject line is a summary for
   developers, not for users. When the user-facing effect isn't obvious from the
   subject, read the commit (`git show --stat <sha>`, then the diff of the files that
   matter). Never guess at what a change does for someone using the app.
4. **Drop what nobody outside the repo can see**: refactors, test-only changes, CI,
   docs, dependency bumps, build-system work. The exception is when they have a felt
   effect — "the Linux download is half the size" earned a bullet; the `files:` pattern
   that achieved it did not.
5. **Group** under `### Added`, `### Fixed`, and `### Changed` / `### Removed` when
   needed. Omit an empty group.
6. **Check the result parses**: `npx vitest run tests/unit/release-notes.test.ts`. That
   suite reads the real file and will catch a malformed heading or an empty section.

### Voice

Match what's already in the file. Concretely:

- A bold lead-in naming the change from the user's side, then a plain sentence saying
  what it means for them. **Bold the claim, not the feature name.**
- Write about the user's experience, not the implementation. "Your phone can no longer
  read files or API keys off your Mac" — not "tightened the mobile IPC allowlist".
- Second person. No commit hashes, no file paths, no internal component names.
- One or two sentences per bullet. If it needs three, it's probably two bullets.
- A fix bullet says what was broken, in the past tense, and that it now isn't. Users
  who never hit the bug should still be able to tell whether it affected them.
- No marketing. No "we're excited to". No exclamation marks.

## Mode 2 — cut a release

When the user is actually shipping (`/release-notes cut 0.3.0`, "cut the release"):

1. Run mode 1 first if there are commits since the last tag that aren't written up yet.
2. Set `version` in `package.json` to the release version.
3. In `RELEASE_NOTES.md`, change the top heading's `Unreleased` to today's date
   (`## 0.3.0 — 2026-08-02`) and make sure its version matches `package.json` — the app
   hides any section newer than the running build, so a mismatch means users see
   nothing.
4. `npx vitest run tests/unit/release-notes.test.ts` — it asserts the shipping version
   has a section.
5. Commit, then tag `v<version>`. Don't push the tag or build artifacts unless asked.

## Notes

- The notes file ships inside the app (it's in `electron-builder.yml`'s `files`), so a
  section added after a build is cut never reaches that build's users. Write the notes
  before you tag.
- Users on an older version only ever see sections at or below their own version, so
  there's no harm in the top section sitting at `Unreleased` for a while.
