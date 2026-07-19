import { afterEach, describe, expect, it } from 'vitest';
import { ipcMain } from '../electron-stub';
import { a, argsProblem, handleIpc, senderProblem } from '../../src/main/ipc';

// The renderer → main IPC guard: trusted-sender check + per-channel structural
// argument validation (see src/main/ipc.ts).

/** A minimal IpcMainInvokeEvent stand-in: one top-level frame at `url`. */
function eventFrom(url: string) {
  const frame = { url };
  return { senderFrame: frame, sender: { mainFrame: frame } };
}

afterEach(() => {
  delete process.env.ELECTRON_RENDERER_URL;
});

describe('senderProblem', () => {
  it('trusts only our own top-level frames', () => {
    expect(senderProblem(eventFrom('file:///Applications/Stem.app/renderer/index.html') as never)).toBeNull();
    expect(senderProblem(eventFrom('https://evil.example/page') as never)).toMatch(/untrusted sender/);

    // The dev server origin is trusted only when electron-vite advertises it.
    const dev = eventFrom('http://localhost:5173/index.html');
    expect(senderProblem(dev as never)).toMatch(/untrusted sender/);
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';
    expect(senderProblem(dev as never)).toBeNull();

    // A subframe never gets IPC, whatever it displays.
    const sub = { senderFrame: { url: 'file:///x.html' }, sender: { mainFrame: { url: 'file:///x.html' } } };
    expect(senderProblem(sub as never)).toBe('IPC from a subframe');
    expect(senderProblem({ senderFrame: null, sender: { mainFrame: null } } as never)).toBe('no sender frame');
  });
});

describe('argsProblem', () => {
  it('checks arity and shallow types, honoring optional and nullish', () => {
    expect(argsProblem([a.string, a.boolean], ['x', true])).toBeNull();
    expect(argsProblem([a.string], ['x', 'extra'])).toMatch(/at most 1/);
    expect(argsProblem([a.string], [42])).toBe('argument 1 must be a string');
    expect(argsProblem([a.number], [Number.NaN])).toMatch(/finite number/);
    expect(argsProblem([a.object], [['not', 'plain']])).toMatch(/an object/);
    expect(argsProblem([a.stringArray], [['ok', 'fine']])).toBeNull();
    expect(argsProblem([a.oneOf(['on', 'off'])], ['dim'])).toMatch(/one of on\|off/);
    expect(argsProblem([a.nullish(a.string)], [null])).toBeNull();
    expect(argsProblem([a.nullish(a.string)], [undefined])).toBeNull();
    expect(argsProblem([a.string, a.optional(a.string)], ['just-one'])).toBeNull();
    // A required argument cannot simply be omitted.
    expect(argsProblem([a.string], [])).toBe('argument 1 must be a string');
  });
});

describe('handleIpc', () => {
  it('rejects bad senders and bad args before the handler runs; passes good calls through', () => {
    let ran = 0;
    handleIpc('chats:rename', (_e, threadId, name) => {
      ran += 1;
      return `${String(threadId)}:${String(name)}`;
    });
    const trusted = eventFrom('file:///app/index.html');

    expect(ipcMain._invoke('chats:rename', trusted, 't-1', 'New name')).toBe('t-1:New name');
    expect(ran).toBe(1);

    expect(() => ipcMain._invoke('chats:rename', eventFrom('https://evil.example'), 't-1', 'x'))
      .toThrow(/untrusted sender/);
    expect(() => ipcMain._invoke('chats:rename', trusted, 't-1', 42)).toThrow(/argument 2 must be a string/);
    expect(ran).toBe(1); // neither rejected call reached the handler

    // A channel with no spec entry takes no arguments at all.
    handleIpc('runtime:status', () => 'ok');
    expect(ipcMain._invoke('runtime:status', trusted)).toBe('ok');
    expect(() => ipcMain._invoke('runtime:status', trusted, 'sneaky')).toThrow(/at most 0/);
    ipcMain.removeHandler('chats:rename');
    ipcMain.removeHandler('runtime:status');
  });
});
