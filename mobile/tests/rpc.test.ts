import { describe, expect, it, vi } from 'vitest';
import { rpc, rpcRaw, UnreachableError } from '../src/transport/rpc';

const endpoint = { serverUrl: 'https://stem.example', token: 'tok' };

function answering(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
}

describe('rpcRaw', () => {
  it('sends the transport envelope with the bearer token', async () => {
    const doFetch = answering(200, { ok: true, result: { chats: [] } });
    const result = await rpcRaw(endpoint, 'chats:list', [], { fetch: doFetch });
    expect(result).toEqual({ chats: [] });
    const [url, init] = (doFetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe('https://stem.example/rpc');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(String(init.body))).toEqual({ channel: 'chats:list', args: [] });
  });

  it('throws the server’s own error text, verbatim', async () => {
    const doFetch = answering(200, { ok: false, error: 'Rejected local call to files:reveal: no window here' });
    await expect(rpcRaw(endpoint, 'files:reveal', [], { fetch: doFetch })).rejects.toThrow(
      'Rejected local call to files:reveal: no window here'
    );
  });

  it('falls back to the status when the body says nothing useful', async () => {
    const doFetch = answering(500, null);
    await expect(rpcRaw(endpoint, 'chats:list', [], { fetch: doFetch })).rejects.toThrow('chats:list failed (HTTP 500)');
  });

  describe('reachability', () => {
    // The rule this whole file exists to keep: only a fetch that threw means the
    // server is gone. Anything that answered — however badly — means it is up.
    it('is true for a refusal', async () => {
      const onReachable = vi.fn();
      const doFetch = answering(403, { ok: false, error: 'nope' });
      await expect(rpcRaw(endpoint, 'chats:list', [], { fetch: doFetch, onReachable })).rejects.toThrow('nope');
      expect(onReachable).toHaveBeenCalledWith(true);
      expect(onReachable).not.toHaveBeenCalledWith(false);
    });

    it('is false only when nothing answered at all', async () => {
      const onReachable = vi.fn();
      const doFetch = vi.fn(async () => {
        throw new Error('Network request failed');
      }) as unknown as typeof fetch;
      await expect(rpcRaw(endpoint, 'chats:list', [], { fetch: doFetch, onReachable })).rejects.toBeInstanceOf(
        UnreachableError
      );
      expect(onReachable).toHaveBeenCalledWith(false);
    });
  });
});

describe('rpc', () => {
  it('is the same call, typed against StemApi', async () => {
    const doFetch = answering(200, {
      ok: true,
      result: { chats: [{ threadId: 't1', title: 'Groceries', folderId: null, createdAt: 1, updatedAt: 2 }], folders: [], inbox: {} }
    });
    const list = await rpc(endpoint, 'chats:list', [], { fetch: doFetch });
    // The typing is the point: `list.chats[0].title` only compiles because the
    // channel table names StemApi['listChats'] as this channel's signature.
    expect(list.chats[0].title).toBe('Groceries');
  });
});
