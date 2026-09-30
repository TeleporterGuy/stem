import type { ChatMessage, ChatSummary, Folder } from '../../shared/types';
import { toMs } from '../../shared/inbox';
import type { FilingMark } from '../workspace/chats';
import { autoFileChat, getFilingState } from '../workspace/chats';
import { backgroundRunOf, readSettings } from '../workspace/settings';
import { log } from '../log';
import type { SubjectDeps } from './subject';
import { wholeThreadExcerpt } from './subject';

// Filing idle chats. A chat nobody has touched for a day is done being talked
// about, and that is when it is worth tidying away: the subject writer's small
// model is shown the user's folders, a few chats already in each, and this
// chat, and names a folder or NONE.
//
// Everything here leans towards leaving a chat alone. Only folders the user
// made are candidates — nothing here ever creates one. A chat is looked at once
// (the chat store's `filing` mark), whatever the verdict, so a NONE is not
// re-asked every sweep. And a chat the user has placed — into a folder, or
// back to root — is theirs: setChatFolder marks it, and nothing here reads a
// marked chat again. Undoing a filing is just moving the chat back.
//
// Two cases deliberately leave NO mark, so the chat stays eligible:
// - the user has no folders at all. There is nothing to file into, and once
//   they make some, the chats that went idle meanwhile should get their turn
//   (still bounded by the 30-day window below).
// - the model call failed (timeout, a dead provider). That says nothing about
//   the chat, so it is asked again next sweep — and the sweep stops at the
//   first failure, so a dead model costs one call per sweep, not one per chat.

/** How long a chat has to sit untouched before it is filed. */
export const IDLE_MS = 24 * 60 * 60_000;
/**
 * How far back a sweep looks. The first sweep on an existing profile
 * would otherwise walk every old chat the user ever had, a model call each;
 * anything quieter than this has been sitting at root for a month already.
 */
export const WINDOW_MS = 30 * 24 * 60 * 60_000;
/** Chats filed per sweep at most; the next sweep carries on. */
export const MAX_PER_SWEEP = 20;
/** Chats already in a folder shown as examples of what belongs there. */
const EXAMPLES_PER_FOLDER = 5;
/** A one-word answer on a small model; don't wait on a wedged one. */
const AUTOFILE_TIMEOUT_MS = 20_000;
/** How much of the chat the model is shown. */
const EXCERPT_CAP = 1_500;

/** What the model answers when no folder fits. */
export const NONE = 'NONE';

/** Between the segments of a nested folder's path: "Work / Cloudfarms". */
const SEP = ' / ';

/**
 * Every folder's full path, root first. A parent chain that loops or dangles
 * (only a hand-edited file can hold one) just stops where it breaks.
 */
export function folderPaths(folders: Folder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  for (const folder of folders) {
    const names: string[] = [];
    const seen = new Set<string>();
    let at: Folder | undefined = folder;
    while (at && !seen.has(at.id)) {
      seen.add(at.id);
      names.unshift(at.name.trim());
      at = at.parentId ? byId.get(at.parentId) : undefined;
    }
    paths.set(folder.id, names.join(SEP));
  }
  return paths;
}

/** One path as a comparable key: segments trimmed, whitespace collapsed. */
function pathKey(path: string): string {
  return path
    .split('/')
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .join('/');
}

/**
 * Reduce the model's reply to one of the user's folders, or null for root.
 *
 * Strict on purpose — a wrong answer moves a chat somewhere the user won't
 * look for it, while null only leaves it where it already was. The reply has
 * to name a folder's FULL path (case aside); a bare leaf name, a folder that
 * doesn't exist, or a path two folders share is root.
 */
export function parseFolderReply(raw: string, folders: Folder[]): string | null {
  let text = (raw ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  text = text.replace(/^(folder|answer)\s*[:\-–]\s*/i, '').replace(/^[-•·]\s+/, '');
  // Wrapping quotes/backticks and a trailing period, in whichever order they came.
  for (let i = 0; i < 3; i += 1) {
    const stripped = text.replace(/^["'`“”‘’*]+|["'`“”‘’*.]+$/g, '').trim();
    if (stripped === text) break;
    text = stripped;
  }
  if (!text || text.toUpperCase() === NONE) return null;

  const paths = [...folderPaths(folders)];
  const match = (same: (a: string, b: string) => boolean): string | null | undefined => {
    const hits = paths.filter(([, path]) => same(pathKey(path), pathKey(text)));
    if (hits.length === 1) return hits[0][0];
    // Two folders with the same path: the answer can't say which one it meant.
    return hits.length > 1 ? null : undefined;
  };
  const exact = match((a, b) => a === b);
  if (exact !== undefined) return exact;
  return match((a, b) => a.toLowerCase() === b.toLowerCase()) ?? null;
}

/** The one-shot prompt behind a filing. */
export function autoFilePrompt(
  folders: { path: string; examples: string[] }[],
  chatTitle: string,
  conversation: string
): string {
  const tree = folders.flatMap(({ path, examples }) => [
    `- ${path}${examples.length ? '' : ' (no chats in it yet)'}`,
    ...examples.map((title) => `    · ${title}`)
  ]);
  return [
    "Decide which of the user's folders the chat below belongs in.",
    '',
    'Rules:',
    `- Reply with one folder path exactly as it is written in the list, or the single word ${NONE}.`,
    `- Only pick a folder the chat clearly belongs in, judging by its name and the chats already in it. When in doubt, reply ${NONE}: a chat left where it is costs nothing, a chat filed in the wrong folder gets lost.`,
    '- Never make up a folder. Anything not in the list is ignored.',
    '- No quotes, no explanation.',
    '',
    'Folders, each with some of the chats already in it:',
    ...tree,
    '',
    `Chat: ${chatTitle}`,
    '"""',
    conversation.slice(0, EXCERPT_CAP),
    '"""'
  ].join('\n');
}

/** The chat store's view of who may be filed, as {@link getFilingState} reads it. */
export interface FilingSnapshot {
  folders: Folder[];
  assignments: Record<string, string>;
  filing: Record<string, FilingMark>;
  private: Set<string>;
}

/**
 * The chats a sweep may file, newest first: idle for a day but active within
 * the window, in no folder, never placed by the user, never looked at, and not
 * private. `chats` is the chat list as the sidebar gets it, so mail sessions
 * and scheduled-run threads are already out. Empty when there are no folders.
 */
export function autoFileCandidates(chats: ChatSummary[], state: FilingSnapshot, nowMs: number): ChatSummary[] {
  if (state.folders.length === 0) return [];
  return chats
    .filter(
      (chat) =>
        toMs(chat.updatedAt) <= nowMs - IDLE_MS &&
        toMs(chat.updatedAt) >= nowMs - WINDOW_MS &&
        !state.assignments[chat.threadId] &&
        !state.filing[chat.threadId] &&
        !state.private.has(chat.threadId) &&
        !chat.private
    )
    .sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt));
}

/** What a sweep needs from the server, injected so it stays testable. */
export interface AutoFileDeps {
  complete: SubjectDeps['complete'];
  /** The chats the chat list shows — hidden threads already filtered out. */
  listChats(): Promise<ChatSummary[]>;
  /** A chat's messages, oldest first. */
  readMessages(threadId: string): Promise<ChatMessage[]>;
  /** A chat moved; the clients should re-read the list. */
  onFiled?(threadId: string): void;
  /** True once interactive work has started; the sweep stops and the next one carries on. */
  shouldYield?(): boolean;
}

export interface AutoFileResult {
  /** The chats that moved, and where to. */
  filed: { title: string; folder: string }[];
  /** Chats that got a verdict (filed or left at root). */
  considered: number;
}

/**
 * One sweep: file up to {@link MAX_PER_SWEEP} idle chats, one model call at a
 * time. Never throws — a failure is logged and ends the sweep.
 */
export async function autoFileSweep(
  deps: AutoFileDeps,
  opts: { nowMs?: number; limit?: number } = {}
): Promise<AutoFileResult> {
  const result: AutoFileResult = { filed: [], considered: 0 };
  try {
    if ((await readSettings()).chats.autoFile === false) return result;
    const state = await getFilingState();
    if (state.folders.length === 0) return result;
    const chats = await deps.listChats();
    const candidates = autoFileCandidates(chats, state, opts.nowMs ?? Date.now()).slice(
      0,
      opts.limit ?? MAX_PER_SWEEP
    );
    if (candidates.length === 0) return result;

    const paths = folderPaths(state.folders);
    const folders = [...paths]
      .map(([id, path]) => ({
        path,
        // The listing is newest first, so these are the folder's latest chats.
        examples: chats
          .filter((c) => state.assignments[c.threadId] === id && !c.private && !state.private.has(c.threadId))
          .slice(0, EXAMPLES_PER_FOLDER)
          .map((c) => c.subject ?? c.title)
      }))
      .sort((a, b) => a.path.localeCompare(b.path));

    for (const chat of candidates) {
      if (deps.shouldYield?.()) break;
      // Turned off mid-sweep: stop before the next call, not after the batch.
      if ((await readSettings()).chats.autoFile === false) break;
      let messages: ChatMessage[];
      try {
        messages = await deps.readMessages(chat.threadId);
      } catch (e) {
        // One unreadable transcript is that chat's problem; the rest can go on.
        log('chats', 'auto-file skipped an unreadable chat', { threadId: chat.threadId, error: String(e) });
        continue;
      }
      const excerpt = wholeThreadExcerpt(messages);
      const title = chat.subject ?? chat.title;
      let folderId: string | null = null;
      // A chat with nothing said in it has nothing to file by; it stays at root.
      if (excerpt.trim()) {
        const reply = await deps.complete(autoFilePrompt(folders, title, excerpt), {
          ...(await backgroundRunOf('subject', (s) => ({ model: s.chats.subjectModel, effort: s.chats.subjectEffort }))),
          timeoutMs: AUTOFILE_TIMEOUT_MS
        });
        folderId = parseFolderReply(reply, state.folders);
      }
      const moved = await autoFileChat(chat.threadId, folderId);
      result.considered += 1;
      if (moved && folderId) {
        result.filed.push({ title, folder: paths.get(folderId) ?? '' });
        deps.onFiled?.(chat.threadId);
      }
    }
  } catch (e) {
    log('chats', 'auto-file sweep stopped', { error: String(e) });
  }
  return result;
}
