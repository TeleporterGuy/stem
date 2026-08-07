// The desktop's end of the wire, driven over a real loopback socket: the whole
// path from `proxy.invoke(channel, args)` out through POST /rpc, into the real
// handler registry, and back — plus the SSE stream in the other direction and the
// fan-out table that decides which window a push belongs to.
//
// Nothing here is faked but the windows. The server is the real transport with the
// real device registry in front of it, and the client is the real
// createServerProxy, because the point of the step this covers is that the desktop
// stopped having a private path to its handlers. The server end of the same wire,
// driven without a client, is transport-http.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { registerServer } from '../../src/server/ipc';
import { isUploadHandle, resolveUploadHandle } from '../../src/server/files/staging';
import { forgetCachedDevices, readDevices, resolveDevice } from '../../src/server/transport/auth';
import { createPairingCode } from '../../src/server/transport/pairing';
import { readClientIdentity, writeClientIdentity } from '../../src/desktop/client-store';
import {
  closeTransport,
  pushToClients,
  startTransport,
  type TransportEndpoint
} from '../../src/server/startup/transport';
import { createServerProxy, type ServerProxy } from '../../src/desktop/proxy';
import { clientCredentials } from '../../src/desktop/server-endpoint';
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
  rmSync(process.env.STEM_CLIENT_FILE!, { force: true });
  forgetCachedDevices();

  registerServer('chats:rename', (_e, threadId, name) => `${String(threadId)}:${String(name)}`);
  registerServer('chats:open', (_e, threadId) => {
    clientSide.push(`server:chats:open(${String(threadId)})`);
    return { threadId, title: 'A thread', messages: [] };
  });
  // A stand-in for the real handler, which persists the fields settings.json
  // still holds and answers with the whole document. Note what it does NOT
  // answer with: the hotkey, which is the client's (see the split below).
  registerServer('settings:updateQuickChat', (_e, patch) => ({
    quickChat: { ...(patch as object), defaultEffort: 'high' }
  }));
  registerServer('backend:newConversation', () => Promise.reject(new Error('pi is not running')));
  // The two channels that carry client paths, echoing back exactly what landed —
  // which is the only thing the remote-upload rewrite is about.
  registerServer('backend:startTurn', (_e, input) => input);
  registerServer('files:add', (_e, paths, subdir) => [paths, subdir]);

  endpoint = await startTransport({ devUrl: null });
  // The server publishes no credential any more: this client mints its own off
  // the state root they share, exactly as the desktop does at startup.
  proxy = createServerProxy({
    ...(await clientCredentials(endpoint.url, { external: false })),
    // The embedded shape: this process started the server, so paths still mean
    // the same thing on both sides and nothing is uploaded before a turn.
    remote: false,
    sendToMain: (channel, payload) => routed.push({ to: 'main', channel, payload }),
    sendToOverlay: (channel, payload) => routed.push({ to: 'overlay', channel, payload }),
    revealIfOwns: (threadId) => routed.push({ to: 'revealIfOwns', channel: '', payload: threadId }),
    routeBackendEvent: (event) => routed.push({ to: 'route', channel: 'backend:event', payload: event }),
    revealMainWindow: () => routed.push({ to: 'revealMainWindow', channel: '', payload: null }),
    requestAttention: () => routed.push({ to: 'requestAttention', channel: '', payload: null }),
    // Nothing here signs in, so the courier only has to exist (see proxy.ts).
    oauthCourier: { expectSignIn: () => undefined, offer: () => undefined, close: () => undefined },
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
    const patch: Partial<QuickChatSettings> = { shortcut: 'Alt+Space', showOnAllDisplays: false };
    const next = (await proxy.invoke('settings:updateQuickChat', [patch])) as AppSettings;

    // One patch, two files, one document back. The hotkey the server never saw
    // came from this machine's own store; the rest came off the wire.
    expect(next.quickChat.shortcut).toBe('Alt+Space');
    expect(next.quickChat.showOnAllDisplays).toBe(false);
    expect(next.quickChat.defaultEffort).toBe('high');
    // The accelerator grab is not a setting — it is a claim on an OS — so it is
    // re-registered from the merged answer, never from what was asked for.
    expect(clientSide).toEqual([
      'client:applyQuickChat({"shortcut":"Alt+Space","showOnAllDisplays":false}→Alt+Space)'
    ]);
  });
});

// The one place a client changes what it puts on the wire depending on WHERE the
// server is. Everything above is identical either way, and has to stay that way —
// so this is driven through a second proxy rather than by making the first one
// behave differently.
describe('when the server is somewhere else', () => {
  let far: ServerProxy;
  const localFile = join(tmpdir(), `stem-attach-${process.pid}.txt`);

  beforeAll(async () => {
    writeFileSync(localFile, 'the contents of a file on the client');
    far = createServerProxy({
      ...(await clientCredentials(endpoint.url, { external: false })),
      // The whole difference: a server this process did not start may not share
      // this disk, so a path in an argument means nothing to it.
      remote: true,
      sendToMain: () => undefined,
      sendToOverlay: () => undefined,
      revealIfOwns: () => undefined,
      routeBackendEvent: () => undefined,
      revealMainWindow: () => undefined,
      requestAttention: () => undefined,
      oauthCourier: { expectSignIn: () => undefined, offer: () => undefined, close: () => undefined },
      threadOpened: async () => undefined,
      applyQuickChatSettings: () => undefined
    });
  });

  afterAll(() => {
    far.close();
    rmSync(localFile, { force: true });
  });

  it('uploads a turn\'s attachments and sends handles in place of paths', async () => {
    const result = (await far.invoke('backend:startTurn', [
      { input: 'what does this say?', attachments: [{ name: 'note.txt', path: localFile }] }
    ])) as { attachments: { name: string; path: string }[] };

    // The path the renderer supplied never reached the server; a handle did.
    const [att] = result.attachments;
    expect(att.name).toBe('note.txt');
    expect(att.path).not.toBe(localFile);
    expect(isUploadHandle(att.path)).toBe(true);

    // …and it stands for the bytes that were on the client's disk, which is the
    // whole claim. The server resolves it exactly as pi/attachments.ts does.
    const staged = await resolveUploadHandle(att.path);
    expect(readFileSync(staged!, 'utf8')).toBe('the contents of a file on the client');
    // The name is preserved through the round trip, so the file lands as itself.
    expect(basename(staged!)).toBe(basename(localFile));
  });

  it('leaves a pasted image in the envelope, where it already is', async () => {
    // Only a PATH is meaningless remotely. Base64 is already on the wire, and
    // uploading it separately would be strictly more work for the same bytes.
    const result = (await far.invoke('backend:startTurn', [
      { input: 'look', attachments: [{ name: 'shot.png', mime: 'image/png', dataBase64: 'aGk=' }] }
    ])) as { attachments: { dataBase64: string; path?: string }[] };
    expect(result.attachments[0]).toEqual({ name: 'shot.png', mime: 'image/png', dataBase64: 'aGk=' });
  });

  it('uploads a drop onto the Files panel the same way', async () => {
    const paths = (await far.invoke('files:add', [[localFile], 'Recipes'])) as [string[], string];
    expect(paths[0]).toHaveLength(1);
    expect(isUploadHandle(paths[0][0])).toBe(true);
    expect(paths[1]).toBe('Recipes');
  });

  it('fails the send rather than dropping the attachment out of it', async () => {
    // A message that quietly went without the file the user attached reads as the
    // assistant ignoring them. The refusal keeps the draft in the composer with
    // the reason on screen instead.
    await expect(
      far.invoke('backend:startTurn', [
        { input: 'hi', attachments: [{ name: 'gone.txt', path: join(tmpdir(), 'stem-no-such-file') }] }
      ])
    ).rejects.toThrow(/could not be read from this computer/);
  });

  it('changes nothing for the client that started its own server', async () => {
    // The embedded default must keep handing over paths: an extra copy through
    // loopback for every pasted screenshot would be a real cost with nothing on
    // the other side of it.
    const result = (await proxy.invoke('backend:startTurn', [
      { input: 'local', attachments: [{ name: 'note.txt', path: localFile }] }
    ])) as { attachments: { path: string }[] };
    expect(result.attachments[0].path).toBe(localFile);
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

// How a client gets a credential at all, now that the server keeps none to hand
// out: a token this machine already holds, one minted off a shared state root, or
// a pairing code spent over the wire.
describe('acquiring a credential', () => {
  it('reuses the identity it stored the first time, rather than minting again', async () => {
    // beforeAll already went through this path once. A second call must be a
    // read: minting per launch would fill Settings → Devices with one row per
    // start of the app.
    const again = await clientCredentials(`${endpoint.url}/`, { external: false });
    expect(again.token).toBe((await readClientIdentity())!.token);
    expect((await readDevices()).length).toBe(1);
    // A trailing slash must not survive into `${url}/rpc`.
    expect(again.url).toBe(endpoint.url);
  });

  it('prefers STEM_SERVER_TOKEN, and does not persist it', async () => {
    const stored = (await readClientIdentity())!.token;
    process.env.STEM_SERVER_TOKEN = 'e'.repeat(64);
    try {
      expect((await clientCredentials(endpoint.url, { external: false })).token).toBe('e'.repeat(64));
    } finally {
      delete process.env.STEM_SERVER_TOKEN;
    }
    // An override is for one run; it must not overwrite what this device owns.
    expect((await readClientIdentity())!.token).toBe(stored);
  });

  it('spends a pairing code when it has nothing stored, and keeps what comes back', async () => {
    const identity = await readClientIdentity();
    rmSync(process.env.STEM_CLIENT_FILE!, { force: true });
    const { code } = await createPairingCode('A machine far away');
    process.env.STEM_PAIRING_CODE = code;
    try {
      const paired = await clientCredentials(endpoint.url, { external: false });
      // The token came back over POST /pair — the one unauthenticated route —
      // and works against the same server the desktop is already talking to.
      expect(paired.token).not.toBe(identity!.token);
      expect((await resolveDevice(paired.token))?.label).toBe('A machine far away');
      // …and was written down, so the next launch is a read.
      expect((await readClientIdentity())?.token).toBe(paired.token);
    } finally {
      delete process.env.STEM_PAIRING_CODE;
      // Put the original identity back: later files in this suite share the registry.
      await writeClientIdentity(identity!);
    }
  });

  it('refuses to guess when there is no credential and no way to make one', async () => {
    const identity = await readClientIdentity();
    rmSync(process.env.STEM_CLIENT_FILE!, { force: true });
    const endpointFile = process.env.STEM_SERVER_ENDPOINT_FILE;
    // No published endpoint in our state root = a server whose disk we cannot
    // see, which is exactly when minting a record would be writing into the void.
    process.env.STEM_SERVER_ENDPOINT_FILE = join(tmpdir(), `stem-no-such-endpoint-${process.pid}.json`);
    try {
      await expect(clientCredentials('http://192.0.2.10:8443', { external: true })).rejects.toThrow(/Pair instead/);
    } finally {
      if (endpointFile) process.env.STEM_SERVER_ENDPOINT_FILE = endpointFile;
      else delete process.env.STEM_SERVER_ENDPOINT_FILE;
      await writeClientIdentity(identity!);
    }
  });
});
