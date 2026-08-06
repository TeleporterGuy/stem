// Do the two ends of the wire still agree about who may do what?
//
// Since the headless split there are three tables describing one decision, and
// they live in three files that are edited for different reasons:
//
//   src/server/transport/roles.ts        what each ROLE may invoke and receive
//   src/renderer/mobile/transport.ts     what the phone client actually calls
//   src/desktop/proxy.ts                 which channels never reach a server at all
//
// Drift between them is quiet. A phone channel dropped from the server allowlist
// is a 403 the user reads as "Stem is broken"; one left in with no caller is
// blast radius for free; a client-owned channel that turns up on the phone's list
// is a channel nobody can answer. None of that fails a type check — the tables
// are string maps, and strings agree with nothing.
//
// The phone half of this started life inside mobile-client.test.ts, next to the
// transport it was checking. It is here now because the same question has a
// second half: the `desktop` role, which deliberately has no table at all.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PHONE_INVOKE_CHANNELS,
  PHONE_PUSH_CHANNELS,
  channelPolicy,
  channelsFor,
  mayInvoke,
  mayReceive
} from '../../src/server/transport/roles';
import { hasLocalHandler, registerServer, serverChannels } from '../../src/server/ipc';
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '../../src/renderer/mobile/transport';

/**
 * Channels the desktop answers itself — the client-owned bucket of the table in
 * src/desktop/proxy.ts. Copied here rather than imported because importing it
 * would drag Electron into a unit test, and because a copy is exactly what this
 * file is for: if the two ever disagree, that is the finding.
 */
const CLIENT_OWNED = [
  'dialog:openFiles',
  'dialog:openDirectory',
  'files:reveal',
  'files:preview',
  'cfolders:reveal',
  'cfolders:revealWorkspace',
  'quickchat:newThread',
  'quickchat:handoff',
  'quickchat:reveal',
  'quickchat:hide',
  'quickchat:shortcutStatus',
  'main:reveal'
];

describe('the phone role', () => {
  it('only maps channels the server actually allows', () => {
    // The client's table and the server's allowlist are two halves of one
    // decision about what a phone may do; drift between them is a 403 at best.
    for (const [member, channel] of Object.entries(INVOKE_CHANNELS)) {
      expect(`${member} → ${channel}`).toBe(
        `${member} → ${PHONE_INVOKE_CHANNELS.has(channel) ? channel : 'NOT ALLOWLISTED'}`
      );
    }
    expect(Object.values(INVOKE_CHANNELS)).toContain('backend:startTurn');
  });

  it('leaves nothing allowlisted that the client cannot reach', () => {
    // The other direction, and the one that rots quietly: a channel the server
    // permits with no client member behind it is blast radius for free. Both
    // tables are edited together or this fails.
    const mapped = new Set(Object.values(INVOKE_CHANNELS));
    expect([...PHONE_INVOKE_CHANNELS].filter((c) => !mapped.has(c))).toEqual([]);
  });

  it('subscribes only to push channels the server actually sends', () => {
    // The mirror of the invoke check: a listener on a channel the server never
    // pushes is a feature that silently never fires.
    for (const [member, channel] of Object.entries(EVENT_CHANNELS)) {
      expect(`${member} → ${channel}`).toBe(
        `${member} → ${PHONE_PUSH_CHANNELS.has(channel) ? channel : 'NOT PUSHABLE'}`
      );
    }
    expect(EVENT_CHANNELS.onBackendEvent).toBe('backend:event');
    // And nothing pushed that no listener is wired to receive.
    const subscribed = new Set(Object.values(EVENT_CHANNELS));
    expect([...PHONE_PUSH_CHANNELS].filter((c) => !subscribed.has(c))).toEqual([]);
  });

  it('resolves every mapped channel through mayInvoke, not just the raw set', () => {
    // The set is the data; mayInvoke is what the transport actually calls. They
    // are checked separately because a role predicate is where a "just for now"
    // exception would be added.
    for (const channel of Object.values(INVOKE_CHANNELS)) {
      expect(`${channel}: ${mayInvoke('phone', channel)}`).toBe(`${channel}: true`);
    }
    for (const channel of Object.values(EVENT_CHANNELS)) {
      expect(`${channel}: ${mayReceive('phone', channel)}`).toBe(`${channel}: true`);
    }
  });

  it('keeps the documented omissions out', () => {
    // roles.ts argues at length for each of these staying off the phone. The
    // argument is only worth having if something notices when it stops being true.
    //
    // Every name below is checked against the preload first. A refusal test names
    // channels it expects to be ABSENT from a set, so a renamed channel would go
    // on passing while testing nothing at all; the preload is the desktop's full
    // surface, so a name missing from it is a stale test rather than a safe one.
    const preload = readFileSync(fileURLToPath(new URL('../../src/preload/index.ts', import.meta.url)), 'utf8');
    const refused = [
      'auth:providerLogin', // sign-in happens at the desk
      'providers:disconnect',
      'mcp:add',
      'mcp:login',
      'settings:updateMobile', // a phone never turns the bridge off from itself
      'settings:updateExec',
      'memory:forget', // destructive, and hard to undo on a phone
      'memory:resetFacts',
      'files:add',
      'files:preview', // read-any-image-on-the-Mac, with no caller on the phone
      'cfolders:add',
      'chats:delete',
      'chats:search',
      'runtime:restart',
      'backend:listModels'
    ];
    for (const channel of refused) {
      expect(`${channel} in preload: ${preload.includes(`'${channel}'`)}`).toBe(`${channel} in preload: true`);
      expect(`${channel}: ${mayInvoke('phone', channel)}`).toBe(`${channel}: false`);
    }
    for (const channel of ['auth:event', 'activity:changed', 'tasks:changed']) {
      expect(`${channel} in preload: ${preload.includes(`'${channel}'`)}`).toBe(`${channel} in preload: true`);
      expect(`${channel}: ${mayReceive('phone', channel)}`).toBe(`${channel}: false`);
    }
    // The two channels that exist only BETWEEN the server and the desktop and so
    // are absent from the preload: one a client tells the server about itself,
    // one the server tells a machine with a screen to do. Neither is a phone's.
    expect(mayInvoke('phone', 'client:claimThread')).toBe(false);
    expect(mayReceive('phone', 'client:revealMainWindow')).toBe(false);
  });

  it('never lists a channel the desktop answers itself', () => {
    // A client-owned channel is not the server's to allow. Allowlisting one
    // would not grant the phone anything — it would produce a 400 from a
    // registry that has never heard of it.
    for (const channel of CLIENT_OWNED) {
      expect(`${channel}: ${PHONE_INVOKE_CHANNELS.has(channel)}`).toBe(`${channel}: false`);
    }
  });
});

describe('the desktop role', () => {
  // The whole point of the desktop role is that it has NO table: the server's
  // handler registry IS the surface. These check that it still resolves that way
  // rather than to a second list that would have to be kept in step with it.

  it('follows the registry, including channels registered after the fact', () => {
    const channel = 'conformance:latecomer';
    expect(hasLocalHandler(channel)).toBe(false);
    expect(mayInvoke('desktop', channel)).toBe(false);

    registerServer(channel, () => 'ok');

    expect(hasLocalHandler(channel)).toBe(true);
    // Registering a handler is the ONLY act that exposes it to the desk. If this
    // ever needs a second edit somewhere, the property the split rests on is gone.
    expect(mayInvoke('desktop', channel)).toBe(true);
  });

  it('offers exactly what is registered and nothing more', () => {
    registerServer('conformance:one', () => 1);
    registerServer('conformance:two', () => 2);
    const registered = serverChannels();
    // GET /channels is derived from the predicate, not a third list.
    expect(channelsFor('desktop', registered)).toEqual([...registered]);
    // …and a channel nobody registered is not smuggled in by naming it.
    expect(channelsFor('desktop', [...registered, 'conformance:unregistered'])).not.toContain(
      'conformance:unregistered'
    );
  });

  it('receives every push and has nothing projected out of its answers', () => {
    // A phone gets a curated push list and a projected settings document; the
    // desk gets what the server sends, unchanged. The asymmetry is the design.
    for (const channel of ['backend:event', 'auth:event', 'activity:changed', 'anything:at:all']) {
      expect(`${channel}: ${mayReceive('desktop', channel)}`).toBe(`${channel}: true`);
    }
    for (const channel of ['settings:get', 'backend:startTurn']) {
      expect(channelPolicy('desktop', channel)).toBeUndefined();
      // …whereas the phone's two policies are still in force.
      expect(channelPolicy('phone', channel)).toBeDefined();
    }
  });

  it('does not answer the channels the desktop answers itself', () => {
    // Client-owned channels are absent from the registry by construction — they
    // are registered with handleLocal (src/desktop/ipc-bridge.ts), which never
    // touches it. Registering one on the server would put a native file picker
    // on the phone's reachable surface the moment the allowlist grew.
    for (const channel of CLIENT_OWNED) {
      expect(`${channel}: ${hasLocalHandler(channel)}`).toBe(`${channel}: false`);
    }
  });
});
