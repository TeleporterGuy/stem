// The proof of the split: the app driven against a `stem-server` that is somebody
// else's process.
//
// Every other spec in this directory runs the embedded configuration, where the
// server is started inside the Electron main process. That already speaks real
// HTTP over a real socket — there is no in-process short-circuit — so it covers
// the wire format. What it cannot cover is the thing Phase 1 is actually for: that
// nothing in src/server needs to be in the same process as a window. A bug that
// only appears when the two halves are separated (an import that only resolves
// because Electron is underneath, a piece of state one side assumed the other
// would have already written) is invisible until something separates them.
//
// So: `node dist/main/server.js` on its own, against an isolated state dir, and
// the app launched with STEM_SERVER_URL pointing at it. Two processes, one
// machine, one state root. No TLS, no remote host, no service manager — those are
// Phase 2.
//
// This is deliberately a FOCUSED set rather than a second copy of the suite. It
// runs one app launch through the paths where a process boundary could plausibly
// break something the embedded configuration would never notice:
//
//   - the connect handshake (GET /channels) and the fact that the desktop bound
//     the channels the OTHER process reported
//   - a turn: request out over /rpc, deltas back over SSE, rendered
//   - the chat list, and re-opening a thread — chats:open, one of the two wrapped
//     channels, where client behavior runs before the call is forwarded
//   - an approval: a decision made in the server process that has to reach a
//     window, be answered by a click, and come back
//
// What it does NOT cover, on purpose: the other ~46 specs. Quick Chat's handoff
// choreography, onboarding, the Manage panel, memory, tasks, release notes and
// web search all run embedded only. Their coverage of the transport is the same
// coverage this configuration would give them, minus the process boundary, and
// duplicating them here would roughly double a serial Electron suite to re-test
// one `if` in desktop/index.ts.
import { expect, closeApp, launchApp, mainWindowOf, test, type LaunchedApp } from './electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

async function send(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
}

// One launch for the whole file: booting a server and an Electron app costs more
// than every assertion below put together, and the tests are a sequence through
// one session anyway (the thread the first one starts is what the later ones open).
test.describe.configure({ mode: 'serial' });

test.describe('against an externally started stem-server', () => {
  let launched: LaunchedApp;
  let win: Page;

  test.beforeAll(async () => {
    launched = await launchApp({
      externalServer: true,
      seedSettings: {
        onboarding: { completed: true },
        // A "What's new" modal over the composer would block every send below.
        releaseNotes: { showOnUpdate: false, lastSeenVersion: null },
        // Manual approval: every command goes to the card, with no LLM judge in
        // the way. That is what makes the approval path hermetic.
        exec: { enabled: true, approvalMode: 'manual', judgeModel: null, allowlist: [] }
      }
    });
    win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test('the app got in by pairing, not by reading a credential off the disk', async () => {
    // The server printed a one-shot code when it found its registry empty, the
    // harness handed it to the app, and the app spent it on POST /pair. That is
    // the path a genuinely remote client takes, and this configuration is where
    // it gets walked end to end.
    expect(launched.server!.pairingCode).toBeTruthy();

    const registry = JSON.parse(readFileSync(join(launched.userDataDir, 'devices.json'), 'utf8')) as {
      devices: { id: string; label: string; tokenHash?: string; token?: string }[];
    };
    expect(registry.devices).toHaveLength(1);
    // The property the whole rewrite is for: what is on disk cannot be replayed.
    expect(registry.devices[0].token).toBeUndefined();
    expect(registry.devices[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // And the app kept its half — the token the server no longer has.
    const client = JSON.parse(readFileSync(join(launched.userDataDir, 'client.json'), 'utf8')) as {
      deviceId: string;
    };
    expect(client.deviceId).toBe(registry.devices[0].id);
  });

  test('the server really is a separate process', async () => {
    // The load-bearing assertion of this whole file. Everything else here would
    // pass just as well against an embedded server with a different label.
    const endpoint = JSON.parse(readFileSync(join(launched.userDataDir, 'server.json'), 'utf8')) as {
      url: string;
      pid: number;
    };
    const mainPid = await launched.app.evaluate(() => process.pid);
    expect(endpoint.pid).not.toBe(mainPid);
    // What the server published is its OWN socket, which is not the address the
    // app was given: everything the app sends goes through the harness's proxy
    // (see tests/e2e/stem-server.ts), the way a deployed client reaches Caddy
    // rather than Stem.
    expect(endpoint.url).toBe(launched.server!.directUrl);

    // …and the app knows it: STEM_SERVER_URL is the one `if` in desktop/index.ts
    // that decides whether it starts a server or connects to one.
    const seen = await launched.app.evaluate(() => process.env.STEM_SERVER_URL);
    expect(seen).toBe(launched.server!.url);
    expect(seen).not.toBe(endpoint.url);
  });

  test('the renderer reaches channels the other process registered', async () => {
    // The desktop binds to ipcMain whatever GET /channels reported — it keeps no
    // copy of the registry. So a working `window.stem` call is proof of the whole
    // handshake: token read off the shared state root, /channels fetched,
    // ipcMain bound, and the call round-tripped over /rpc.
    const settings = await win.evaluate(() => (window as any).stem.getSettings());
    expect(settings?.defaults).toBeTruthy();
    expect(settings?.exec?.approvalMode).toBe('manual');
  });

  test('a turn streams back across the socket', async () => {
    await send(win, 'Hello from another process');

    await expect(win.locator('.message-user').last()).toContainText('Hello from another process');
    const reply = win.locator('.message-assistant:not(.activity-row) .message-body').last();
    // Every delta of this was serialized to JSON, written to a socket by one
    // process, and parsed by another before it reached React.
    await expect(reply).toContainText('Echo: Hello from another process');

    // The turn settled: no Stop, and the idle-only action row is attached.
    await expect(win.getByTitle('Stop')).toHaveCount(0);
    await expect(win.locator('.message-user').last().locator('.message-actions')).toBeAttached();
  });

  test('the chat list and re-opening a thread cross the wire', async () => {
    // chats:list is the plainest possible RPC; the sidebar row is the server's
    // answer rendered.
    await expect(win.locator('.chat-row')).toHaveCount(1);

    // A second thread, so opening the first is a real navigation rather than a
    // no-op that would pass without the call being made at all.
    await win.getByTitle('New conversation').click();
    await send(win, 'second thread');
    await expect(win.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText(
      'Echo: second thread'
    );
    await expect(win.locator('.chat-row')).toHaveCount(2);

    // chats:open — a WRAPPED channel: the desktop runs the Quick Chat hand-off
    // check locally and only then forwards the open. The messages that come back
    // are the server's, read from its disk.
    await win.locator('.chat-row').filter({ hasText: 'Hello from another process' }).click();
    await expect(win.locator('.message-user').first()).toContainText('Hello from another process');
    await expect(win.locator('.message-assistant:not(.activity-row) .message-body').first()).toContainText(
      'Echo: Hello from another process'
    );
  });

  test('an approval card crosses in both directions', async () => {
    // The one path where the server has to reach a WINDOW and be answered. The
    // decision is made in the other process (ExecService), pushed down the SSE
    // stream, mounted as a modal, clicked, and sent back over /rpc — and the
    // server holds the tool call open across all of it.
    await win.getByTitle('New conversation').click();
    await send(win, '[e2e:exec] run something');

    const card = win.getByText('Run this command?');
    await expect(card).toBeVisible();
    await expect(win.locator('.exec-approval-command')).toContainText('echo stem-e2e-approved');

    await win.getByRole('button', { name: 'Allow once' }).click();

    // The command actually ran, in the server's workspace, and its output came
    // back through the tool call and into the streamed reply.
    await expect(win.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText(
      'stem-e2e-approved'
    );
    await expect(win.getByText('Run this command?')).toHaveCount(0);
    await expect(win.getByTitle('Stop')).toHaveCount(0);
  });

  test('the app recovers when the network under it is cut', async () => {
    // Everything above runs over a socket that has never once misbehaved, which
    // is exactly the blind spot in building all of Phase 2 against a server on
    // this machine and deploying last. So: destroy every connection through the
    // proxy — the event stream and any request in flight — and then carry on.
    //
    // The app is given no help. It has to notice the stream ended, reconnect on
    // its own backoff, and answer the next thing typed into it.
    launched.server!.cutConnections();

    await win.getByTitle('New conversation').click();
    await send(win, 'still there?');
    await expect(win.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText(
      'Echo: still there?',
      // Generous: the reconnect runs on a backoff, and the send may itself be the
      // request that discovers the socket is gone.
      { timeout: 30_000 }
    );
  });

  test('the app survives the server being killed outright and coming back', async () => {
    // SIGKILL: no shutdown, no drain — what an OOM-killed container does. The app
    // stays up, because a client that dies with its server is a client that has
    // to be restarted every time a deployment rolls.
    await launched.server!.kill();
    await launched.server!.restart();

    await win.getByTitle('New conversation').click();
    await send(win, 'after the crash');
    await expect(win.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText(
      'Echo: after the crash',
      { timeout: 30_000 }
    );

    // Its credential outlived the process, because the credential is a record on
    // disk and a token this machine holds — not session state in the server.
    const settings = await win.evaluate(() => (window as any).stem.getSettings());
    expect(settings?.exec?.approvalMode).toBe('manual');
  });
});
