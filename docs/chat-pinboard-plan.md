# Chat pinboard

Status: idea, shape proposed. Not implemented.

## Purpose

Long chats bury the parts worth keeping — a mixing ratio, a setting, a deadline —
somewhere in the scroll. Quick notes (`//`, `/note`) don't fit: they go to Recall,
which is memory *about the user*, unscoped from any chat. A pinboard is memory
*about this chat*: what the user chose to keep, visible at the top of the thread
and, just as important, never forgotten by the model.

## Proposed shape

| Area | Proposal |
| --- | --- |
| Placement | A strip directly under the chat header (title + model line), full width of the chat column, sticky while the messages scroll. Not the window's top edge — that is the title bar. |
| Collapsed | One ~32px line: `📌 3 · Rubio 3:1 · cure 5 days …` (count + first items, truncated). Hidden entirely until the chat has a first item. |
| Expanded | Drops down *over* the messages (does not push them), max ~40% of the chat height, scrolls inside. A "keep open" toggle docks it instead, pushing the messages down. Open/closed remembered per chat. |
| Item: pinned message | Pin in the message action row (next to copy / retry / branch / delete). Shows the first lines; expand for the rest. |
| Item: pinned passage | Select text in a message → Pin. The common case: the formula is one sentence of a long answer. |
| Item: chat note | User-written, editable text that the AI never said ("2nd coat done Oct 3"). |
| Jump to source | Clicking a pinned message or passage scrolls to the message and highlights it (passage: the exact range). |
| In the model's context | All items are injected into every turn of the chat, like pinned Recall facts — so they survive pi's compaction of a long thread. |
| Private chats | Pins work (they are the user's explicit choice), but nothing flows into Recall. |
| Clients | Stored on the server, so the mobile app can show and add them later. |

## Implementation sketch

- **Storage.** Threads belong to pi (session JSONL); Stem keeps its own per-thread
  metadata in `workspace/chats.ts` (folders, subjects, naming, private, filing). A
  pinboard grows past a JSON map quickly and is edited often, so a small SQLite table
  (`chat_pins`: id, thread_id, kind `message|passage|note`, turn_id, role, text
  snapshot, passage offsets, created/updated, sort order) is the better home —
  `node:sqlite` is already used by Recall, folder-index and chat search.
- **Anchoring.** `ChatMessage.turnId` (shared/types.ts) is the stable identity retry/
  edit/fork already use. A pin stores turn id + role + a text snapshot, so it still
  reads correctly if the source changes.
- **Retry / edit / rollback.** A pin whose turn is rolled back keeps its snapshot
  and shows "source no longer in chat" (no jump). Never silently deleted.
- **Fork** (`chats:forkThread`). Copy the pins whose turns are in the fork, plus notes.
- **Delete chat** (`removeChat`). Delete its pins.
- **Injection.** Per-turn block built next to the Recall injection, budgeted (cap on
  total characters; oldest passages truncated first, notes never dropped).
- **Search.** Pins and notes indexed by chat search, so "Rubio ratio" finds the chat.

## Ideas for later

- **Suggested key points.** After a turn, a cheap background pass (like chat naming
  in `chats/subject.ts`) proposes items — "Mixing ratio: 3 parts oil : 1 accelerator"
  — that the user accepts with one click. Suggest, never auto-add: a board the user
  didn't curate stops being trusted.
- **Dated items → reminders.** "Fully cured on Oct 8" pinned with a date, offered as
  a Task/reminder.
- **Space boards.** A pinboard per folder (e.g. *Domácnosť*: inverter settings, error
  codes) collecting pins from any chat in it, injected into all of its chats.
- **Promote to memory.** "Save to memory" on a pin for the rare item that is really
  about the user, handing it to the `/note` path.
- **Checklist items.** Notes with checkboxes for multi-step jobs (coat 1 ✓, coat 2,
  buff, cure).
- **Export.** Copy the board as Markdown — a project summary in one click.
