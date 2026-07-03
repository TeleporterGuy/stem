// ProviderAuth suite — the in-app OAuth bridge, with pi's AuthStorage mocked so
// no network or real auth.json is touched. Exercises the callback→event bridge,
// the manual-input round-trip, cancellation, and API-key writes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from 'electron';
import type { AuthUiEvent } from '../../src/shared/types';
import { ProviderAuth } from '../../src/main/pi/provider-auth';

type LoginCallbacks = {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onDeviceCode: (info: { userCode: string; verificationUri: string }) => void;
  onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  onSelect: (prompt: { message: string; options: { id: string; label: string }[] }) => Promise<string | undefined>;
  signal?: AbortSignal;
};

const loginMock = vi.fn<(provider: string, callbacks: LoginCallbacks) => Promise<void>>();
const setMock = vi.fn();
const listMock = vi.fn(() => ['anthropic']);

vi.mock('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: {
    create: vi.fn(() => ({ login: loginMock, set: setMock, list: listMock }))
  }
}));

function makeAuth(): { auth: ProviderAuth; events: AuthUiEvent[] } {
  const events: AuthUiEvent[] = [];
  const auth = new ProviderAuth('/tmp/fake-auth.json', (e) => events.push(e));
  return { auth, events };
}

beforeEach(() => {
  loginMock.mockReset();
  setMock.mockReset();
});

describe('ProviderAuth.login', () => {
  it('opens the auth URL in the browser and emits auth-url then done', async () => {
    const openExternal = vi.spyOn(shell, 'openExternal');
    loginMock.mockImplementation(async (_p, cb) => {
      cb.onAuth({ url: 'https://claude.ai/oauth/authorize?x=1' });
    });
    const { auth, events } = makeAuth();
    const res = await auth.login('anthropic');
    expect(res.ok).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://claude.ai/oauth/authorize?x=1');
    expect(events.map((e) => e.kind)).toEqual(['auth-url', 'done']);
    expect(events[1]).toMatchObject({ kind: 'done', ok: true, provider: 'anthropic' });
  });

  it('bridges onPrompt through an input-request event and respond()', async () => {
    let answered: string | null = null;
    loginMock.mockImplementation(async (_p, cb) => {
      answered = await cb.onPrompt({ message: 'Paste the code' });
    });
    const { auth, events } = makeAuth();
    const login = auth.login('anthropic');
    await vi.waitFor(() => {
      expect(events.some((e) => e.kind === 'input-request')).toBe(true);
    });
    const req = events.find((e) => e.kind === 'input-request') as Extract<AuthUiEvent, { kind: 'input-request' }>;
    expect(req.message).toBe('Paste the code');
    auth.respond(req.requestId, 'the-code');
    const res = await login;
    expect(res.ok).toBe(true);
    expect(answered).toBe('the-code');
  });

  it('answers the openai-codex method select with browser', async () => {
    let selected: string | undefined;
    loginMock.mockImplementation(async (_p, cb) => {
      selected = await cb.onSelect({
        message: 'How do you want to sign in?',
        options: [
          { id: 'device_code', label: 'Device code' },
          { id: 'browser', label: 'Browser' }
        ]
      });
    });
    const { auth } = makeAuth();
    await auth.login('openai-codex');
    expect(selected).toBe('browser');
  });

  it('cancel() aborts the flow and rejects pending input', async () => {
    loginMock.mockImplementation(
      (_p, cb) =>
        new Promise<void>((_res, rej) => {
          cb.signal?.addEventListener('abort', () => rej(new Error('Login cancelled.')));
          void cb.onPrompt({ message: 'code?' }).catch(() => undefined);
        })
    );
    const { auth, events } = makeAuth();
    const login = auth.login('anthropic');
    await vi.waitFor(() => {
      expect(events.some((e) => e.kind === 'input-request')).toBe(true);
    });
    auth.cancel();
    const res = await login;
    expect(res.ok).toBe(false);
    const done = events.find((e) => e.kind === 'done') as Extract<AuthUiEvent, { kind: 'done' }>;
    expect(done.ok).toBe(false);
  });

  it('reports a failed flow as done ok:false with the error text', async () => {
    loginMock.mockRejectedValue(new Error('port 1455 already in use'));
    const { auth, events } = makeAuth();
    const res = await auth.login('openai-codex');
    expect(res).toEqual({ ok: false, error: 'port 1455 already in use' });
    expect(events).toEqual([{ kind: 'done', ok: false, provider: 'openai-codex', error: 'port 1455 already in use' }]);
  });

  it('a second login supersedes the first', async () => {
    loginMock.mockImplementation(
      (provider, cb) =>
        new Promise<void>((res, rej) => {
          if (cb.signal?.aborted) return rej(new Error('aborted'));
          cb.signal?.addEventListener('abort', () => rej(new Error('aborted')));
          // The first attempt (anthropic) stays pending until superseded/aborted;
          // the second (openai-codex) completes immediately.
          if (provider === 'openai-codex') res();
        })
    );
    const { auth } = makeAuth();
    const first = auth.login('anthropic');
    const second = auth.login('openai-codex');
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(true);
  });
});

describe('ProviderAuth.setApiKey', () => {
  it('writes through AuthStorage.set as a type:api_key credential', async () => {
    const { auth } = makeAuth();
    await auth.setApiKey('anthropic', '  sk-test-123  ');
    expect(setMock).toHaveBeenCalledWith('anthropic', { type: 'api_key', key: 'sk-test-123' });
  });

  it('rejects an empty key without touching storage', async () => {
    const { auth } = makeAuth();
    await expect(auth.setApiKey('openai', '   ')).rejects.toThrow('API key is empty.');
    expect(setMock).not.toHaveBeenCalled();
  });
});

describe('ProviderAuth.listProviders', () => {
  it('returns the stored provider ids', async () => {
    const { auth } = makeAuth();
    await expect(auth.listProviders()).resolves.toEqual(['anthropic']);
  });
});
