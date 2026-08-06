// The desktop's end of the wire, driven over a real loopback socket: the whole
// path from `proxy.invoke(channel, args)` out through POST /rpc, into the real
// handler registry, and back — plus the SSE stream in the other direction and the
// fan-out table that decides which window a push belongs to.
//
// Nothing here is faked but the windows. The server is the real transport with the
// real device registry in front of it, and the client is the real
// createServerProxy, because the point of the step this covers is that the desktop
// stopped having a private path to its handlers. The phone's end of the same
// server is mobile-bridge.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { registerServer } from '../../src/server/ipc';
import { forgetCachedDevices } from '../../src/server/transport/auth';
import {
  closeTransport,
  pushToClients,
  startTransport,
  type TransportEndpoint
} from '../../src/server/startup/transport';
import { createServerProxy, type ServerProxy } from '../../src/desktop/proxy';
import { readServerCredentials } from '../../src/desktop/server-endpoint';
import type { AppSettings, BackendEventEnvelope, QuickChatSettings } from '../../src/shared/types';

let endpoint: TransportEndpoint;
let proxy: ServerProxy;
let channels: string[];

/** Everything the fan-out did, in order, so routing can be asserted as a whole. */
const routed: { to: string; channel: string; payload: unknown }[] = [];
/** Wrapped-channel bookkeeping: what ran on this side, and when. */
const clientSide: string[] = [];
/** Set to make the `chats:open` hand-off refuse, as a live one can. */
let refuseHandoff: Error | null = null;

/** Wait for `check` to hold — the SSE stream delivers on its own schedule. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  rmSync(process.env.STEM_DEVICES_FILE!, { force: true });
  forgetCachedDevices();

  registerServer('chats:rename', (_e, threadId, name) => `${String(threadId)}:${String(name)}`);
  registerServer('chats:open', (_e, threadId) => {
    clientSide.push(`server:chats:open(${String(threadId)})`);
    return { threadId, title: 'A thread', messages: [] };
  });
  registerServer('settings:updateQuickChat', (_e, patch) => ({
    quickChat: { ...(patch as object), shortcut: 'Alt+Space' }
  }));
  registerServer('backend:newConversation', () => Promise.reject(new Error('pi is not running')));

  endpoint = await startTransport({ rendererDir: '/nonexistent', devUrl: null });
  proxy = createServerProxy({
    ...endpoint,
    sendToMain: (channel, payload) => routed.push({ to: 'main', channel, payload }),
    sendToOverlay: (channel, payload) => routed.push({ to: 'overlay', channel, payload }),
    revealIfOwns: (threadId) => routed.push({ to: 'revealIfOwns', channel: '', payload: threadId }),
    routeBackendEvent: (event) => routed.push({ to: 'route', channel: 'backend:event', payload: event }),
    revealMainWindow: () => routed.push({ to: 'revealMainWindow', channel: '', payload: null }),
    requestAttention: () => routed.push({ to: 'requestAttention', channel: '', payload: null }),
    threadOpened: async (threadId) => {
      clientSide.push(`client:threadOpened(${threadId})`);
      if (refuseHandoff) throw refuseHandoff;
    },
    applyQuickChatSettings: (patch, next) => {
      clientSide.push(`client:applyQuickChat(${JSON.stringify(patch)}→${next.shortcut})`);
    }
  });
  channels = await proxy.start();
});

afterAll(async () => {
  proxy.close();
  await closeTransport();
});

describe('what the desktop may call', () => {
  it('is the server registry itself, asked for at connect time', () => {
    // No allowlist on this side: the channels are whatever the server registered,
    // which is the property that keeps adding a handler a one-line change.
    expect(channels).toContain('chats:rename');
    expect(channels).toContain('settings:updateQuickChat');
    expect(channels).not.toContain('nope:notAThing');
    // Client-owned channels are not the server's to answer and never appear.
    expect(channels).not.toContain('dialog:openFiles');
    expect(channels).not.toContain('quickchat:run');
  });
});

describe('POST /rpc', () => {
  it('round-trips a real handler over the socket', async () => {
    await expect(proxy.invoke('chats:rename', ['t-1', 'New name'])).resolves.toBe('t-1:New name');
  });

  it('hands the guard rejection back in the guard\'s own words', async () => {
    // The renderer's error handling must not be able to tell which side answered,
    // so the message crosses the wire untouched — prefix, punctuation and all.
    await expect(proxy.invoke('chats:rename', ['t-1', 42])).rejects.toThrow(
      'Rejected local call to chats:rename: argument 2 must be a string.'
    );
    await expect(proxy.invoke('nope:notAThing', [])).rejects.toThrow(
      'Rejected local call to nope:notAThing: no handler registered.'
    );
  });

  it('surfaces a handler failure as the handler wrote it', async () => {
    await expect(proxy.invoke('backend:newConversation', [])).rejects.toThrow('pi is not running');
  });

  it('refuses a token that is not in the registry', async () => {
    const res = await fetch(`${endpoint.url}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer a'.repeat(1) },
      body: JSON.stringify({ channel: 'chats:rename', args: ['t-1', 'x'] })
    });
    expect(res.status).toBe(401);
  });
});

// The two channels with behavior on both sides of the wire, in a fixed order.
// They are a named table in proxy.ts rather than an `if` in the invoke path
// precisely so that a third one cannot appear without somebody deciding to add it.
describe('wrapped channels', () => {
  it('runs the Quick Chat hand-off before chats:open is forwarded', async () => {
    clientSide.length = 0;
    await proxy.invoke('chats:open', ['t-7']);
    expect(clientSide).toEqual(['client:threadOpened(t-7)', 'server:chats:open(t-7)']);
  });

  it('never sends the open when the hand-off refuses it', async () => {
    clientSide.length = 0;
    refuseHandoff = new Error('Quick Chat did not return a handoff snapshot. Try Open in Stem again.');
    try {
      await expect(proxy.invoke('chats:open', ['t-8'])).rejects.toThrow(/did not return a handoff snapshot/);
    } finally {
      refuseHandoff = null;
    }
    // The refusal is the whole answer: the server never heard about this open.
    expect(clientSide).toEqual(['client:threadOpened(t-8)']);
  });

  it('applies Quick Chat settings only after the write has landed', async () => {
    clientSide.length = 0;
    const patch: Partial<QuickChatSettings> = { showOnAllDisplays: false };
    const next = (await proxy.invoke('settings:updateQuickChat', [patch])) as AppSettings;
    expect(next.quickChat.shortcut).toBe('Alt+Space');
    // The accelerator grab is not a setting — it is a claim on an OS — so it is
    // re-registered from what came BACK, never from what was asked for.
    expect(clientSide).toEqual(['client:applyQuickChat({"showOnAllDisplays":false}→Alt+Space)']);
  });
});

describe('the event stream', () => {
  it('fans a push out to the window the channel belongs to', async () => {
    routed.length = 0;
    pushToClients('activity:changed', { running: 1 });
    await until(() => routed.length > 0, 'the main-window push');
    expect(routed).toEqual([{ to: 'main', channel: 'activity:changed', payload: { running: 1 } }]);

    routed.length = 0;
    pushToClients('exec:approvalRequest', { id: 'ap-1', threadId: 't-1' });
    await until(() => routed.length >= 3, 'the approval fan-out');
    expect(routed.map((r) => r.to)).toEqual(['revealIfOwns', 'main', 'overlay']);
  });

  it('hands a backend event to the client\'s own routing, unopened', async () => {
    routed.length = 0;
    const event: BackendEventEnvelope = {
      method: 'item/agentMessage/delta',
      params: { threadId: 't-1', delta: 'line one\nline "two"' },
      receivedAt: new Date().toISOString()
    } as BackendEventEnvelope;
    pushToClients('backend:event', event);
    await until(() => routed.length > 0, 'the backend event');
    // Whether the overlay owns this thread is client state; the proxy does not
    // second-guess it, it just delivers. A payload with a newline and a quote in
    // it has to survive as one SSE frame.
    expect(routed).toEqual([{ to: 'route', channel: 'backend:event', payload: event }]);
  });

  it('turns the two window gestures back into calls on this machine', async () => {
    routed.length = 0;
    // Raising a window and bouncing a dock cannot be RPCs into the client — a
    // server has nothing to call — so they arrive as pushes and land here.
    pushToClients('client:revealMainWindow', null);
    pushToClients('client:requestAttention', null);
    await until(() => routed.length >= 2, 'the window gestures');
    expect(routed.map((r) => r.to)).toEqual(['revealMainWindow', 'requestAttention']);
  });
});

// STEM_SERVER_URL: the desktop connects to a server it did not start. Phase 1 only
// ever puts that process on this machine sharing this state root, so the
// credential comes out of the registry the server already wrote.
describe('connecting to a server we did not start', () => {
  it('reads this device\'s token out of the shared registry', async () => {
    const credentials = await readServerCredentials(`${endpoint.url}/`);
    // Same token the embedded path was handed — one desktop record, not two.
    expect(credentials.token).toBe(endpoint.token);
    // A trailing slash must not survive into `${url}/rpc`.
    expect(credentials.url).toBe(endpoint.url);
  });

  it('prefers STEM_SERVER_TOKEN when the two stop sharing a disk', async () => {
    process.env.STEM_SERVER_TOKEN = 'e'.repeat(64);
    try {
      expect((await readServerCredentials(endpoint.url)).token).toBe('e'.repeat(64));
    } finally {
      delete process.env.STEM_SERVER_TOKEN;
    }
  });
});
