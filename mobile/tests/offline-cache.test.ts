// The offline cache's decisions, with a real SQL engine behind them.
//
// expo-sqlite cannot load in Node, so the injected database here is node:sqlite
// wearing expo-sqlite's method names. That is deliberately a stand-in rather than
// a mock: what is worth asserting about this file is what SURVIVES — which row
// wins an upsert, which rows the eviction statement deletes, what a vanished
// thread does — and a hand-written fake that answered from a Map would be
// asserting about the fake.

import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatListResult, ChatSummary } from '@shared/types';
import {
  createOfflineCache,
  staleByUpdatedAt,
  type CacheDatabase,
  type OfflineCache,
  type PrefetchCall
} from '../src/offline/cache';

function memoryDatabase(): CacheDatabase {
  const db = new DatabaseSync(':memory:');
  return {
    execSync: (source) => db.exec(source),
    runSync: (source, params) => db.prepare(source).run(...(params as never[])),
    getFirstSync: <T,>(source: string, params: unknown[]) =>
      (db.prepare(source).get(...(params as never[])) as T | undefined) ?? null,
    getAllSync: <T,>(source: string, params: unknown[]) =>
      db.prepare(source).all(...(params as never[])) as T[],
    closeSync: () => db.close()
  };
}

function chat(threadId: string, updatedAt: number): ChatSummary {
  return { threadId, title: threadId, updatedAt } as ChatSummary;
}

function list(...chats: ChatSummary[]): ChatListResult {
  return { chats } as ChatListResult;
}

function history(threadId: string, text = 'hello'): unknown {
  return { threadId, title: threadId, messages: [{ role: 'user', text }] };
}

let cache: OfflineCache;

beforeEach(() => {
  cache = createOfflineCache({ open: memoryDatabase });
});

describe('what is kept and what is served', () => {
  it('replays the chat list it was given, flagged as offline', () => {
    cache.record('chats:list', [], list(chat('a', 10)));

    const replayed = cache.replay('chats:list', []) as ChatListResult;
    expect(replayed.chats.map((c) => c.threadId)).toEqual(['a']);
    // The flag exists so the screen can say where the answer came from rather
    // than inferring it from the shape of what it got.
    expect(replayed.offline).toBe(true);
  });

  it('replays a transcript for either channel that answers with one', () => {
    cache.record('chats:list', [], list(chat('a', 10)));
    cache.record('chats:open', ['a'], history('a'));

    expect(cache.replay('chats:open', ['a'])).toMatchObject({ threadId: 'a', offline: true });
    // chats:history is the same transcript without the backend pre-warm, so a
    // thread cached by one is served to the other.
    expect(cache.replay('chats:history', ['a'])).toMatchObject({ threadId: 'a', offline: true });
  });

  it('has nothing to say about a thread it never saw, or a channel it does not keep', () => {
    expect(cache.replay('chats:open', ['missing'])).toBeUndefined();
    expect(cache.replay('chats:list', [])).toBeUndefined();
    // Settings is deliberately not cached: the phone reads it only to fill in an
    // approval it could not submit offline anyway.
    cache.record('settings:get', [], { customInstructions: {} });
    expect(cache.replay('settings:get', [])).toBeUndefined();
  });

  it('ignores an empty answer rather than caching it over a good one', () => {
    cache.record('chats:list', [], list(chat('a', 10)));
    cache.record('chats:list', [], null);
    expect((cache.replay('chats:list', []) as ChatListResult).chats).toHaveLength(1);
  });

  it('forgets a thread the server has stopped listing', () => {
    cache.record('chats:list', [], list(chat('a', 10), chat('b', 9)));
    cache.record('chats:open', ['a'], history('a'));
    cache.record('chats:open', ['b'], history('b'));

    // 'b' was deleted at the desk. A cache that went on showing it would be
    // contradicting a server it can perfectly well reach.
    cache.record('chats:list', [], list(chat('a', 11)));

    expect(cache.replay('chats:open', ['a'])).toBeTruthy();
    expect(cache.replay('chats:open', ['b'])).toBeUndefined();
  });

  it('keeps the newest transcript when a thread is opened twice', () => {
    cache.record('chats:list', [], list(chat('a', 10)));
    cache.record('chats:open', ['a'], history('a', 'first'));
    cache.record('chats:open', ['a'], history('a', 'second'));

    const replayed = cache.replay('chats:open', ['a']) as { messages: { text: string }[] };
    expect(replayed.messages[0].text).toBe('second');
  });
});

describe('the bound', () => {
  it('keeps the fifty most recently updated threads and drops the rest', () => {
    const chats = Array.from({ length: 60 }, (_, i) => chat(`t${i}`, i));
    cache.record('chats:list', [], list(...chats));
    for (const c of chats) cache.record('chats:open', [c.threadId], history(c.threadId));

    // Newest by updatedAt survive; the ten oldest are gone, and the bound holds
    // at every instant because pruning happens on the write rather than on a timer.
    expect(cache.replay('chats:open', ['t59'])).toBeTruthy();
    expect(cache.replay('chats:open', ['t10'])).toBeTruthy();
    expect(cache.replay('chats:open', ['t9'])).toBeUndefined();
    expect(cache.replay('chats:open', ['t0'])).toBeUndefined();
  });
});

describe('when there is no database', () => {
  it('degrades to no cache instead of breaking the call', () => {
    const broken = createOfflineCache({
      open: () => {
        throw new Error('no space left on device');
      }
    });

    expect(() => broken.record('chats:list', [], list(chat('a', 1)))).not.toThrow();
    expect(broken.replay('chats:list', [])).toBeUndefined();
    expect(() => broken.clear()).not.toThrow();
    expect(() => broken.close()).not.toThrow();
  });

  it('only ever tries to open once', () => {
    const open = vi.fn(() => {
      throw new Error('nope');
    });
    const broken = createOfflineCache({ open });
    broken.record('chats:list', [], list(chat('a', 1)));
    broken.replay('chats:list', []);
    broken.record('chats:open', ['a'], history('a'));
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('unpairing', () => {
  it('empties the cache, because it belonged to a server this phone no longer has', () => {
    cache.record('chats:list', [], list(chat('a', 10)));
    cache.record('chats:open', ['a'], history('a'));

    cache.clear();

    expect(cache.replay('chats:list', [])).toBeUndefined();
    expect(cache.replay('chats:open', ['a'])).toBeUndefined();
  });
});

describe('the catch-up run', () => {
  it('coalesces a burst of triggers into one run, and walks chats:history', async () => {
    vi.useFakeTimers();
    const seen: [string, unknown[]][] = [];
    const call: PrefetchCall = async (channel, args) => {
      seen.push([channel, args]);
      const answer = channel === 'chats:list' ? list(chat('a', 10), chat('b', 9)) : history(String(args[0]));
      // The real one writes through as it goes (see connection.ts), which is what
      // puts the watermarks in place before the run diffs against them.
      cache.record(channel, args, answer);
      return answer;
    };

    cache.schedulePrefetch(call);
    cache.schedulePrefetch(call);
    cache.schedulePrefetch(call);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(seen.map(([channel]) => channel)).toEqual(['chats:list', 'chats:history', 'chats:history']);
    expect(cache.replay('chats:open', ['a'])).toBeTruthy();
    vi.useRealTimers();
  });

  it('fetches only what is missing or stale on the next run', async () => {
    vi.useFakeTimers();
    cache.record('chats:list', [], list(chat('a', 10), chat('b', 9)));
    cache.record('chats:open', ['a'], history('a'));
    cache.record('chats:open', ['b'], history('b'));

    const seen: string[] = [];
    const call: PrefetchCall = async (channel, args) => {
      if (channel !== 'chats:list') seen.push(String(args[0]));
      // 'a' moved on since it was cached; 'b' did not.
      const answer = channel === 'chats:list' ? list(chat('a', 11), chat('b', 9)) : history(String(args[0]));
      cache.record(channel, args, answer);
      return answer;
    };

    cache.schedulePrefetch(call);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(seen).toEqual(['a']);
    vi.useRealTimers();
  });

  it('does not run at all once cancelled', async () => {
    vi.useFakeTimers();
    const call = vi.fn<PrefetchCall>(async () => list());
    cache.schedulePrefetch(call);
    cache.cancel();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(call).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('staleByUpdatedAt', () => {
  const cached = new Map([
    ['fresh', 100],
    ['stale', 50]
  ]);

  it('asks for what was never cached and what has moved since', () => {
    expect(
      staleByUpdatedAt([chat('fresh', 100), chat('stale', 90), chat('new', 80)], cached, 25)
    ).toEqual(['stale', 'new']);
  });

  it('takes the most recently updated first, and stops at the limit', () => {
    const chats = [chat('old', 1), chat('newest', 9), chat('middle', 5)];
    expect(staleByUpdatedAt(chats, new Map(), 2)).toEqual(['newest', 'middle']);
  });
});
