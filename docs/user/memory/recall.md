# Recall

← [Stem guide](../../README.md) · [Memory](README.md)

Recall helps with questions such as:

```text
What did we decide about the Argo CD — Kubernetes Code rollout?
```

Stem can find relevant messages from earlier chats before asking you to repeat the
context.

Open the right sidebar → **Memory** → **Recall**.

<!-- TODO(screenshot): Recall tab showing storage limit, message count, and conversation summaries. -->

## What Recall stores

- **Episodic recall** — a local, searchable store of past chat messages.
- **Conversation summaries** — a rolling English summary of what each chat discussed,
  decided, and left open.

Stem uses summaries and matching past messages when they help. Retrieved context goes
to the model used for that chat—local or cloud.

The Memory model creates summaries. A cloud Memory model receives transcript excerpts
and may use provider quota.

## Storage limit

Choose a storage limit at the top of the tab. When Recall grows past it, Stem removes
the oldest captured messages first. This does not delete the chats themselves.

## Delete Recall data

- Delete one conversation summary from its row. Its chat and captured messages remain,
  so Stem may rebuild the summary.
- Choose **Reset recall** to permanently erase all captured messages and conversation
  summaries.

Resetting Recall keeps facts, chats, and Files.
