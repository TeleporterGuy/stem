# Facts

← [Stem guide](../../README.md) · [Memory](README.md)

Facts are stable details Stem may pick up from ordinary conversations.

Maya says during a regular chat:

```text
My App Source uses pnpm and Node 22.
```

No special wording. With **Memory** on, Stem reviews new conversations in the
background. Reusable details may appear as facts shortly afterward.

Open the right sidebar → **Memory** → **Facts**.

<!-- TODO(screenshot): Facts tab with source, confidence, Pin, Confirm, and Forget actions visible. -->

## How facts arrive

- **Learned** — extracted from regular conversations. The normal path.
- **From Personal Obsidian** — learned from a connected folder when its
  [settings allow it](../connected-folders.md).
- **On request** — optional direct save with “remember this,” `/note`, or `//`.

The source appears on each fact. One-off completed task details are normally skipped.

## Review stored facts

Expand **Stored memory**. A fact can show:

- its source and category;
- **sensitive**, **pinned**, **draft**, or **injected**;
- confidence and supporting evidence in its details.

**Draft** means the fact would be used for the message currently being written.
**Injected** means it was used for the last turn.

Actions appear on a fact:

- **Confirm** — accept a low-confidence fact.
- **Pin** — send this fact with every message; up to five. Confirm before pinning
  sensitive information.
- **Restore** — bring back a superseded fact.
- **Forget permanently** — delete that fact.

## What Stem chooses

Stem normally sends only facts relevant to the current message, not the whole store.
Sensitive facts need a more direct match. Expired and unconfirmed details inferred
by Stem are excluded. While two facts disagree, one side may still be sent, marked
as **disputed** so the model treats it as uncertain rather than forgetting both.

Selected facts go to the model used for that chat—local or cloud.

Use **Preview draft** in **Stored memory** to see which facts the current message would
use.

## Settings that matter

- **Memory** — stops saving new facts and Recall, and stops using stored Memory across
  chats. Existing data remains until reset.
- **Model** — reviews conversations for durable facts, creates summaries, and tidies
  Memory. A remote model receives transcript excerpts and may use provider quota.
- **Tidy up automatically** — merges duplicates and drops stale facts after the chosen
  number of new facts.
- **Conflicts** — keep the newer fact, the older fact, or both. Stem also resolves
  conflicts between inferred facts on its own in the background (keeping the better
  supported side, keeping both, or rewriting them into corrected statements); a
  conflict that involves something you stated explicitly is always left for you.

Leave **Relevance ranking (advanced)** at its default unless fact matching is poor.
Built-in matching runs locally. A configured server receives fact text and each
search; a separate ranking server also receives the search and candidate facts.

## Erase facts

Choose **Reset facts** at the bottom of the tab. This permanently erases durable facts.
It keeps Recall and Files.
