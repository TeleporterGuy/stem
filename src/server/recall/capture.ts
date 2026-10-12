
import { requestEpisodicMaintenance } from './scan';
import { degrade } from '../degrade';
import type { BackendEventEnvelope, ItemEventParams } from '../../shared/types';
import { agentMessageText } from '../../shared/types';
import { isRecallEnabled, isSensitiveMemoryText } from '../workspace/memory';
import type { LlmClient, LlmImage } from './llm';
import { recallStore } from './store';
const { getEpisodicGeneration, recordMessage } = recallStore;

// Captures conversation into Stem's own store (Level 2). The runtime taps user
// text (in startTurn) and assistant text (from the item/completed event) and
// calls recordMessage — the authoritative, clean path. Pictures the user
// attaches are described into a row of their own (captureUserImages).

// Injected/synthetic blocks ride through as user/developer messages. They are not
// things the user said, so they must never enter recall.
const SYNTHETIC_MARKERS = [
  '<permissions instructions>',
  // pi's own skills preamble (now unused — the backend is spawned --no-skills)
  // and Stem's replacement for it. Both are procedures Stem injected, not
  // anything the user said.
  '<skills_instructions>',
  '<stem_skills',
  '<INSTRUCTIONS>',
  '# AGENTS.md instructions',
  'Stored Stem memory notes',
  'What you know about the user',
  'Possibly relevant from past conversations',
  'Format the entire reply as plain Markdown'
];

function isSyntheticText(text: string): boolean {
  return SYNTHETIC_MARKERS.some((m) => text.includes(m));
}

// Pruning the episodic store VACUUMs the db, so we don't want to do it on every
// message. Check the size limit only every Nth capture; the actual prune runs in
// the scan worker (fire-and-forget) so a multi-second VACUUM never blocks the
// main event loop, and is gated behind a cheap size comparison there.
const ENFORCE_EVERY = 20;
let sinceEnforce = 0;
function maybeEnforceEpisodicLimit(): void {
  if (++sinceEnforce < ENFORCE_EVERY) return;
  sinceEnforce = 0;
  try {
    requestEpisodicMaintenance();
  } catch (error) {
    // Pruning must never break capture — but the request is the only thing that
    // ever asks for the size cap, so a swallow here is the store growing without
    // bound, and every later capture skips the check for another ENFORCE_EVERY.
    degrade('recall.capture', 'skipped the episodic size check', error);
  }
}

/** Live tap for assistant replies: record the authoritative completed agentMessage.
 *  `opts.web` marks the row as coming from a turn that used web tools — see
 *  RecordMessageInput.web for what downstream does with it. */
export function captureFromEvent(envelope: BackendEventEnvelope, opts: { web?: boolean } = {}): void {
  if (envelope.method !== 'item/completed') return;
  const params = envelope.params as ItemEventParams | undefined;
  const item = params?.item;
  if (!item || item.type !== 'agentMessage') return;
  const text = agentMessageText(item);
  if (!text.trim()) return;
  try {
    recordMessage({ threadId: params.threadId, turnId: params.turnId, role: 'assistant', text, web: opts.web ?? false });
    maybeEnforceEpisodicLimit();
  } catch (error) {
    // Capture must never break the chat. The reply is still on screen and still
    // in pi's own session file; it is recall that no longer has it, and nothing
    // re-reads a turn, so the loss is permanent and otherwise invisible.
    degrade('recall.capture', 'dropped an assistant reply from recall', error);
  }
}

/** Live tap for user messages, called once a turn's threadId/turnId are known. */
export function captureUserMessage(input: {
  threadId: string;
  turnId?: string | null;
  text: string;
  cwd?: string | null;
}): void {
  if (!input.text.trim() || isSyntheticText(input.text)) return;
  try {
    recordMessage({
      threadId: input.threadId,
      turnId: input.turnId ?? null,
      role: 'user',
      text: input.text,
      cwd: input.cwd ?? null
    });
    maybeEnforceEpisodicLimit();
  } catch (error) {
    // Same as the assistant tap: the turn carries on, but this message will
    // never be distilled, summarized or searchable.
    degrade('recall.capture', 'dropped a user message from recall', error);
  }
}

/** Most pictures of one turn we describe. They all ride one memory-model call,
 *  so this caps that call's cost when someone drops a whole album in. */
export const MAX_DESCRIBED_IMAGES = 4;

/** Longest name for what a picture is ("hospital admission order form"). */
const MAX_WHAT_LENGTH = 200;

/** Longest transcription kept per picture. Past this the model is copying out a
 *  whole document; the head is what a search needs to land on the chat. */
const MAX_IMAGE_TEXT_LENGTH = 1200;

function describeChatImagesPrompt(text: string, imageCount: number): string {
  const noun = imageCount === 1 ? 'an image' : `${imageCount} images`;
  const typed = text.trim();
  return `A user attached ${noun} to a chat message. Describe each one so the chat can be found later by searching for what the picture held.

Message text: ${typed ? typed.slice(0, 1000) : '(none — the image is the whole message)'}

For each image, in order:
- "what": what the thing is, in a few English words (a receipt, a hospital order form, a router label, a screenshot of …). Skip layout, colours, and decoration.
- "text": the key legible text, copied EXACTLY as written in its original language (never translate): names, dates, numbers, places, headings, list items, amounts, identifiers. Separate items with "; ". Empty when the image holds no text.
- Leave out passwords, PINs, card numbers, and recovery codes.
Return ONLY JSON {"images":[{"what":"...","text":"..."}]} with one entry per image.`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The describer's reply as the episodic row's text, one `[image: …]` line per
 *  picture. Throws on a reply that is not the asked-for shape. */
function imageDescriptionText(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('reply held no JSON object');
  const parsed = JSON.parse(raw.slice(start, end + 1)) as { images?: unknown };
  if (!Array.isArray(parsed.images)) throw new Error('reply had no images list');
  const lines: string[] = [];
  for (const entry of parsed.images as Array<{ what?: unknown; text?: unknown } | null>) {
    const what = typeof entry?.what === 'string' ? clip(entry.what.trim(), MAX_WHAT_LENGTH) : '';
    let text = typeof entry?.text === 'string' ? clip(entry.text.replace(/\s+/g, ' ').trim(), MAX_IMAGE_TEXT_LENGTH) : '';
    // The image-note rule: a photo of a password sticker is not transcribed into
    // recall. Only the transcription goes — "what" still finds the chat.
    if (text && isSensitiveMemoryText(text)) {
      degrade('recall.capture', "kept a credential-looking image's text out of recall", new Error('transcription matched the secret filter'));
      text = '';
    }
    if (!what || isSensitiveMemoryText(what)) continue;
    lines.push(`[image: ${what}${text ? ` — ${text}` : ''}]`);
  }
  return lines.join('\n');
}

/**
 * Describe the pictures a user attached to a chat turn into a user-role
 * episodic row of their own, so `search_past_chats` (and recall injection) can
 * find the chat by what the picture held — recall ranks text, and an image
 * otherwise contributes nothing. Same model and posture as image notes
 * (note.ts): one memory-model call, best-effort, failures to the degrade
 * ledger. The row is dated `ts`, the user message's capture time, not whenever
 * the model got round to answering.
 *
 * The caller has already applied the user-capture gates (recall on, not a
 * scheduled run, not persona-authored mail, turn not private or tainted). This
 * re-checks only what can change while the model is thinking: recall switched
 * off, or the episodic store reset under us. Never rejects.
 */
export async function captureUserImages(
  input: { threadId: string; turnId?: string | null; text: string; cwd?: string | null; ts: number; images: LlmImage[] },
  llm: LlmClient
): Promise<void> {
  const images = input.images.slice(0, MAX_DESCRIBED_IMAGES);
  if (images.length === 0) return;
  try {
    const generation = getEpisodicGeneration();
    let description: string;
    try {
      description = imageDescriptionText(await llm.complete(describeChatImagesPrompt(input.text, images.length), images));
    } catch (error) {
      // The picture is still in the chat, but nothing retries this: a chat whose
      // point was the picture stays findable only by the words around it. A
      // memory model that cannot see images lands here too.
      degrade('recall.capture', 'left a chat image undescribed in recall', error);
      return;
    }
    if (!description) return;
    if (!isRecallEnabled() || getEpisodicGeneration() !== generation) return;
    recordMessage({
      threadId: input.threadId,
      turnId: input.turnId ?? null,
      role: 'user',
      text: description,
      cwd: input.cwd ?? null,
      ts: input.ts
    });
    maybeEnforceEpisodicLimit();
  } catch (error) {
    degrade('recall.capture', 'dropped a chat image description from recall', error);
  }
}
