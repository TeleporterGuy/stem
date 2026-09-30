// Filing idle chats into folders. The reply parser, the path builder and the
// eligibility filter are pure; the sweep runs against the REAL settings and chat
// stores (throwaway paths from tests/setup-unit.ts) with only the model and the
// chat listing stubbed, so the once-per-chat mark, the user-owns-it rule and the
// mid-call race all get exercised the way they run in the server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatMessage, ChatSummary, Folder } from '../../src/shared/types';
import {
  autoFileCandidates,
  autoFileSweep,
  folderPaths,
  IDLE_MS,
  parseFolderReply,
  WINDOW_MS,
  type FilingSnapshot
} from '../../src/server/chats/autofile';
import {
  autoFileChat,
  createFolder,
  getAssignments,
  getFilingState,
  removeChat,
  setChatFolder,
  setChatPrivate
} from '../../src/server/workspace/chats';
import { updateChatsSettings } from '../../src/server/workspace/settings';
import { chatStorePath, settingsStorePath } from '../../src/server/workspace/paths';

const chatPath = chatStorePath();
const settingsPath = settingsStorePath();

beforeEach(() => {
  mkdirSync(dirname(chatPath), { recursive: true });
  rmSync(chatPath, { force: true });
  rmSync(settingsPath, { force: true });
});
afterEach(() => {
  rmSync(chatPath, { force: true });
  rmSync(settingsPath, { force: true });
});

const NOW = Date.UTC(2026, 8, 30, 12);
const HOUR = 60 * 60_000;
/** A chat row as the listing hands it over; `idleMs` back from NOW, in Unix seconds like the real one. */
const chat = (threadId: string, idleMs: number, extra: Partial<ChatSummary> = {}): ChatSummary => ({
  threadId,
  title: `Chat ${threadId}`,
  folderId: null,
  createdAt: Math.floor((NOW - idleMs) / 1000),
  updatedAt: Math.floor((NOW - idleMs) / 1000),
  ...extra
});

const folder = (id: string, name: string, parentId: string | null = null): Folder => ({ id, name, parentId, order: 0 });
const TREE: Folder[] = [folder('w', 'Work'), folder('cf', 'Cloudfarms', 'w'), folder('home', 'Home')];

describe('folderPaths', () => {
  it('spells nested folders root first, and survives a loop in a hand-edited file', () => {
    expect(Object.fromEntries(folderPaths(TREE))).toEqual({ w: 'Work', cf: 'Work / Cloudfarms', home: 'Home' });
    const loop = [folder('a', 'A', 'b'), folder('b', 'B', 'a')];
    expect(Object.fromEntries(folderPaths(loop))).toEqual({ a: 'B / A', b: 'A / B' });
  });
});

describe('parseFolderReply', () => {
  it('accepts a full path, however the model dressed it up', () => {
    expect(parseFolderReply('Work / Cloudfarms', TREE)).toBe('cf');
    expect(parseFolderReply('"Work / Cloudfarms".', TREE)).toBe('cf');
    expect(parseFolderReply('Folder: `work/cloudfarms`\nbecause it is about work', TREE)).toBe('cf');
    expect(parseFolderReply('- Home', TREE)).toBe('home');
    expect(parseFolderReply('**Work**', TREE)).toBe('w');
  });

  it('reads NONE, an invented folder, a bare leaf and a blank as root', () => {
    expect(parseFolderReply('NONE', TREE)).toBeNull();
    expect(parseFolderReply('none.', TREE)).toBeNull();
    expect(parseFolderReply('Taxes', TREE)).toBeNull();
    // Strict: only a full path names a folder, so a leaf that happens to be unique still doesn't.
    expect(parseFolderReply('Cloudfarms', TREE)).toBeNull();
    expect(parseFolderReply('', TREE)).toBeNull();
    expect(parseFolderReply('I think this belongs in Work / Cloudfarms', TREE)).toBeNull();
  });

  it('refuses a path two folders share — it cannot say which one it meant', () => {
    const twins = [...TREE, folder('w2', 'Work')];
    expect(parseFolderReply('Work', twins)).toBeNull();
    expect(parseFolderReply('Home', twins)).toBe('home');
  });
});

describe('autoFileCandidates', () => {
  const snapshot = (over: Partial<FilingSnapshot> = {}): FilingSnapshot => ({
    folders: TREE,
    assignments: {},
    filing: {},
    private: new Set(),
    ...over
  });

  it('takes chats idle a day but active within the window, newest first', () => {
    const chats = [
      chat('fresh', 2 * HOUR),
      chat('old', WINDOW_MS + HOUR),
      chat('day', IDLE_MS + HOUR),
      chat('week', 7 * 24 * HOUR)
    ];
    expect(autoFileCandidates(chats, snapshot(), NOW).map((c) => c.threadId)).toEqual(['day', 'week']);
  });

  it('skips chats already in a folder, already looked at or placed, and private ones', () => {
    const chats = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => chat(id, 2 * IDLE_MS));
    chats[5].private = true;
    const state = snapshot({
      assignments: { a: 'home' },
      filing: { b: 'user', c: 'none', d: 'auto' },
      private: new Set(['e'])
    });
    expect(autoFileCandidates(chats, state, NOW)).toEqual([]);
  });

  it('has nothing to do without folders', () => {
    expect(autoFileCandidates([chat('a', 2 * IDLE_MS)], snapshot({ folders: [] }), NOW)).toEqual([]);
  });
});

describe('the filing mark in the chat store', () => {
  it('a manual move marks the chat as the user’s, root included', async () => {
    const [f] = await createFolder('Work', null);
    await setChatFolder('t-1', f.id);
    await setChatFolder('t-2', null);
    expect((await getFilingState()).filing).toEqual({ 't-1': 'user', 't-2': 'user' });
    // …and the filer leaves both alone from then on.
    expect(await autoFileChat('t-2', f.id)).toBe(false);
    expect(await getAssignments()).toEqual({ 't-1': f.id });
    expect((await getFilingState()).filing['t-2']).toBe('user');
  });

  it('records a verdict once, whatever it was, and the mark goes with the chat', async () => {
    const [f] = await createFolder('Work', null);
    expect(await autoFileChat('t-1', f.id)).toBe(true);
    expect(await autoFileChat('t-2', null)).toBe(false);
    expect((await getFilingState()).filing).toEqual({ 't-1': 'auto', 't-2': 'none' });
    // A second verdict on a looked-at chat is refused.
    expect(await autoFileChat('t-2', f.id)).toBe(false);
    expect(await getAssignments()).toEqual({ 't-1': f.id });
    await removeChat('t-1');
    expect((await getFilingState()).filing).toEqual({ 't-2': 'none' });
  });

  it('an older file without the map reads as nothing filed; junk entries are dropped', async () => {
    writeFileSync(chatPath, JSON.stringify({ version: 1, folders: [], assignments: {} }));
    expect((await getFilingState()).filing).toEqual({});
    writeFileSync(chatPath, JSON.stringify({ version: 1, folders: [], assignments: {}, filing: { a: 'auto', b: 'maybe', c: 1 } }));
    expect((await getFilingState()).filing).toEqual({ a: 'auto' });
  });
});

describe('autoFileSweep', () => {
  const messages: ChatMessage[] = [
    { id: 'm1', role: 'user', content: 'Why did the Cloudfarms sync job fail last night?' },
    { id: 'm2', role: 'assistant', content: 'The farm sync timed out talking to the barn API.' }
  ];

  /** A folder tree in the real store, and the ids it got. */
  async function tree(): Promise<{ work: string; cf: string }> {
    const [work] = await createFolder('Work', null);
    const folders = await createFolder('Cloudfarms', work.id);
    return { work: work.id, cf: folders.find((f) => f.name === 'Cloudfarms')!.id };
  }

  function stub(chats: ChatSummary[], reply: string | (() => Promise<string>) = 'Work / Cloudfarms') {
    const complete = vi.fn(async (_prompt: string, _opts: { model?: string | null; effort?: string | null; timeoutMs?: number }) =>
      typeof reply === 'string' ? reply : reply()
    );
    const onFiled = vi.fn();
    return {
      complete,
      onFiled,
      prompt: () => complete.mock.calls[0]?.[0] ?? '',
      deps: { complete, listChats: async () => chats, readMessages: async () => messages, onFiled }
    };
  }

  it('files an idle chat into the folder the model named, once', async () => {
    const { cf } = await tree();
    await setChatFolder('ex', cf);
    const s = stub([chat('ex', 3 * IDLE_MS, { title: 'Barn API outage', folderId: cf }), chat('t', 2 * IDLE_MS)]);
    const result = await autoFileSweep(s.deps, { nowMs: NOW });
    expect(result.filed).toEqual([{ title: 'Chat t', folder: 'Work / Cloudfarms' }]);
    expect((await getAssignments()).t).toBe(cf);
    expect(s.onFiled).toHaveBeenCalledWith('t');
    // The prompt shows the nested paths and what already lives in each folder.
    expect(s.prompt()).toContain('- Work / Cloudfarms\n    · Barn API outage');
    expect(s.prompt()).toContain('- Work (no chats in it yet)');
    expect(s.prompt()).toContain('Cloudfarms sync job');
    // A second sweep has nothing left to ask about.
    await autoFileSweep(s.deps, { nowMs: NOW });
    expect(s.complete).toHaveBeenCalledTimes(1);
  });

  it('leaves a chat at root on NONE or a made-up folder, and never asks again', async () => {
    await tree();
    const s = stub([chat('t', 2 * IDLE_MS), chat('u', 2 * IDLE_MS)], 'Taxes 2026');
    await autoFileSweep(s.deps, { nowMs: NOW });
    expect(await getAssignments()).toEqual({});
    expect((await getFilingState()).filing).toEqual({ t: 'none', u: 'none' });
    expect(s.onFiled).not.toHaveBeenCalled();
    await autoFileSweep(s.deps, { nowMs: NOW });
    expect(s.complete).toHaveBeenCalledTimes(2);
  });

  it('does nothing without folders — and marks nothing, so folders made later still get used', async () => {
    const s = stub([chat('t', 2 * IDLE_MS)]);
    await autoFileSweep(s.deps, { nowMs: NOW });
    expect(s.complete).not.toHaveBeenCalled();
    expect((await getFilingState()).filing).toEqual({});
  });

  it('does nothing when switched off', async () => {
    await tree();
    await updateChatsSettings({ autoFile: false });
    const s = stub([chat('t', 2 * IDLE_MS)]);
    await autoFileSweep(s.deps, { nowMs: NOW });
    expect(s.complete).not.toHaveBeenCalled();
    expect((await getFilingState()).filing).toEqual({});
  });

  it('skips private chats', async () => {
    await tree();
    await setChatPrivate('t');
    const s = stub([chat('t', 2 * IDLE_MS)]);
    await autoFileSweep(s.deps, { nowMs: NOW });
    expect(s.complete).not.toHaveBeenCalled();
  });

  it('a failed model call marks nothing and ends the sweep', async () => {
    await tree();
    const s = stub([chat('t', 2 * IDLE_MS), chat('u', 3 * IDLE_MS)], async () => {
      throw new Error('timed out');
    });
    const result = await autoFileSweep(s.deps, { nowMs: NOW });
    expect(result).toEqual({ filed: [], considered: 0 });
    expect(s.complete).toHaveBeenCalledTimes(1);
    expect((await getFilingState()).filing).toEqual({});
  });

  it('a chat the user moved while the model was thinking stays where they put it', async () => {
    await tree();
    const s = stub([chat('t', 2 * IDLE_MS)], async () => {
      await setChatFolder('t', null);
      return 'Work / Cloudfarms';
    });
    const result = await autoFileSweep(s.deps, { nowMs: NOW });
    expect(result.filed).toEqual([]);
    expect(await getAssignments()).toEqual({});
    expect(JSON.parse(readFileSync(chatPath, 'utf8')).filing).toEqual({ t: 'user' });
  });
});
