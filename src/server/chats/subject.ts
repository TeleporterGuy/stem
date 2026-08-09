import type { ChatsSettings } from '../../shared/types';
import { setSubject } from '../workspace/chats';
import { backgroundRunOf, readSettings } from '../workspace/settings';
import { log } from '../log';

// Naming a thread. pi never names a session, so Stem always has to; the cheap
// answer is the first line the user typed (autoTitle, below), and the good one
// is a subject a small model writes from that same message.
//
// The two live together on purpose: `autoTitle` is not just a fallback, it is
// also the fingerprint that tells us nobody has renamed the thread by hand. If
// the thread's current name is still exactly what autoTitle produced, the name
// is ours to replace; anything else the user chose, and we leave it alone.

/** Max length of an auto-derived title (the sidebar ellipsizes anyway). */
const MAX_AUTO_TITLE = 80;
/** Max length of a written subject — a subject line, not a sentence. */
export const MAX_SUBJECT = 60;
/** How much of the first message the subject writer is shown. */
const PROMPT_INPUT_CAP = 2_000;
/** The writer is a two-sentence task on a small model; don't wait on a wedged one. */
const SUBJECT_TIMEOUT_MS = 20_000;

/** Derive a chat title from the first user message: its first non-empty line, trimmed and capped. */
export function autoTitle(input: string): string {
  const line = input.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > MAX_AUTO_TITLE ? `${line.slice(0, MAX_AUTO_TITLE - 1).trimEnd()}…` : line;
}

/** The one-shot prompt behind a written subject. */
export function subjectPrompt(firstMessage: string): string {
  return [
    'Write a subject line for a conversation that opens with the message below, the way an email subject names a thread.',
    '',
    'Rules:',
    '- Two to six words. Never more than 60 characters.',
    '- Name the topic, not the request: "Q3 revenue breakdown", not "User asks about Q3 revenue".',
    '- Keep concrete nouns from the message — names, files, error codes — over generic ones.',
    '- Write it in the same language as the message.',
    '- No quotes, no trailing period, no "Subject:" prefix, no explanation.',
    '- Reply with the subject line alone.',
    '',
    'Message:',
    '"""',
    firstMessage.slice(0, PROMPT_INPUT_CAP),
    '"""'
  ].join('\n');
}

/**
 * Reduce a model's reply to a usable subject line, or to '' if there isn't one.
 * Deliberately unforgiving: a bad subject would become the thread's NAME, and a
 * blank result just leaves the first-line title standing, which is no worse than
 * where we started.
 */
export function sanitizeSubject(raw: string): string {
  let text = (raw ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  // Models like to answer a "write a subject" prompt in the shape of the question.
  text = text.replace(/^(subject|title)\s*[:\-–]\s*/i, '');
  // Strip matched wrapping quotes/backticks, possibly nested ("`…`").
  for (let i = 0; i < 3; i += 1) {
    const stripped = text.replace(/^["'`“”‘’*]+|["'`“”‘’*]+$/g, '').trim();
    if (stripped === text) break;
    text = stripped;
  }
  text = text.replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim();
  // A reply this long isn't a subject line — it's the model ignoring the brief.
  if (text.length > MAX_SUBJECT * 3) return '';
  if (text.length > MAX_SUBJECT) text = `${text.slice(0, MAX_SUBJECT - 1).trimEnd()}…`;
  return text;
}

/** What the writer needs from the backend, injected so it stays testable. */
export interface SubjectDeps {
  complete(
    prompt: string,
    opts: { model?: string | null; effort?: string | null; timeoutMs?: number }
  ): Promise<string>;
  /** The thread's current name, or null if it can't be read. */
  currentTitle(threadId: string): Promise<string | null>;
  rename(threadId: string, name: string): Promise<void>;
}

/**
 * True while the thread still carries the name Stem gave it, so renaming it is
 * replacing our own guess rather than overwriting the user's choice.
 */
function stillAutoNamed(current: string | null, firstMessage: string): boolean {
  if (current === null) return false;
  const name = current.trim();
  return name === '' || name === 'New chat' || name === autoTitle(firstMessage);
}

/**
 * Write one thread's subject from its first message.
 *
 * Runs on the warm `--no-session` completion worker, so it never touches the
 * user's live chat, and every failure path is silent: a thread that doesn't get
 * a subject simply keeps the first line of what you typed.
 *
 * `force` is the "Write a subject" row action — an explicit request, so it runs
 * whatever the mode is and may replace a name the user typed. Returns the
 * subject if one was written, else null.
 */
export async function writeSubject(
  deps: SubjectDeps,
  threadId: string,
  firstMessage: string,
  opts?: { force?: boolean; settings?: ChatsSettings }
): Promise<string | null> {
  const force = opts?.force === true;
  try {
    const chats = opts?.settings ?? (await readSettings()).chats;
    if (chats.subjects === 'off' && !force) return null;
    if (!firstMessage.trim()) return null;
    // Cheap bail-out before spending a model call on a thread we won't rename
    // and whose name the user has already chosen.
    if (!force && !stillAutoNamed(await deps.currentTitle(threadId), firstMessage)) return null;

    const reply = await deps.complete(subjectPrompt(firstMessage), {
      ...(await backgroundRunOf('subject', () => ({ model: chats.subjectModel, effort: chats.subjectEffort }))),
      timeoutMs: SUBJECT_TIMEOUT_MS
    });
    const subject = sanitizeSubject(reply);
    if (!subject) return null;
    await setSubject(threadId, subject);

    if (chats.subjects === 'everywhere') {
      // Re-check: the completion took a couple of seconds, and the user may have
      // renamed the thread inside that window.
      if (force || stillAutoNamed(await deps.currentTitle(threadId), firstMessage)) {
        await deps.rename(threadId, subject);
      }
    }
    return subject;
  } catch (e) {
    log('chats', 'subject write failed', { threadId, error: String(e) });
    return null;
  }
}
