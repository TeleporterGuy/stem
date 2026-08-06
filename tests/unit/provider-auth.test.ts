// ProviderAuth suite — the in-app OAuth bridge, with pi's ModelRuntime mocked so
// no network or real auth.json is touched. Exercises the interaction→event
// bridge, the manual-input round-trip, cancellation, API-key writes, and the
// persisted-despite-error tolerance around pi's trailing catalog refresh.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from 'electron';
import type { AuthUiEvent } from '../../src/shared/types';
import { ProviderAuth } from '../../src/server/pi/provider-auth';

type AuthPrompt = {
  type: 'text' | 'secret' | 'select' | 'manual_code';
  message: string;
  placeholder?: string;
  options?: { id: string; label: string }[];
};
type AuthEvent =
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string }
  | { type: 'progress' | 'info'; message: string };
type Interaction = {
  signal?: AbortSignal;
  prompt: (prompt: AuthPrompt) => Promise<string>;
  notify: (event: AuthEvent) => void;
};

const loginMock = vi.fn<(provider: string, type: string, interaction: Interaction) => Promise<unknown>>();
const logoutMock = vi.fn(async () => undefined);
const listCredentialsMock = vi.fn(async () => [{ providerId: 'anthropic', type: 'oauth' }]);
const getAuthMock = vi.fn(async () => ({ auth: {} }));
const readStoredCredentialMock = vi.fn<(provider: string, authPath?: string) => unknown>(() => undefined);

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: {
    create: vi.fn(async () => ({
      login: loginMock,
      logout: logoutMock,
      listCredentials: listCredentialsMock,
      getAuth: getAuthMock
    }))
  },
  readStoredCredential: (provider: string, authPath?: string) => readStoredCredentialMock(provider, authPath)
}));

function makeAuth(): { auth: ProviderAuth; events: AuthUiEvent[] } {
  const events: AuthUiEvent[] = [];
  const auth = new ProviderAuth('/tmp/fake-auth.json', (e) => events.push(e));
  return { auth, events };
}

beforeEach(() => {
  loginMock.mockReset();
  logoutMock.mockClear();
  getAuthMock.mockReset();
  readStoredCredentialMock.mockReset();
  readStoredCredentialMock.mockReturnValue(undefined);
});

describe('ProviderAuth.login', () => {
  it('opens the auth URL in the browser and emits auth-url then done', async () => {
    const openExternal = vi.spyOn(shell, 'openExternal');
    loginMock.mockImplementation(async (_p, _t, interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://claude.ai/oauth/authorize?x=1' });
    });
    const { auth, events } = makeAuth();
    const res = await auth.login('anthropic');
    expect(res.ok).toBe(true);
    expect(loginMock).toHaveBeenCalledWith('anthropic', 'oauth', expect.anything());
    expect(openExternal).toHaveBeenCalledWith('https://claude.ai/oauth/authorize?x=1');
    expect(events.map((e) => e.kind)).toEqual(['auth-url', 'done']);
    expect(events[1]).toMatchObject({ kind: 'done', ok: true, provider: 'anthropic' });
  });

  // xAI signs in by device code: there is no redirect, so the verification page
  // has to be opened for the user (pi passes the prefilled URI) AND the code has
  // to reach the UI — the page asks the user to confirm it matches.
  it('opens the device verification URI and emits device-code then done', async () => {
    const openExternal = vi.spyOn(shell, 'openExternal');
    loginMock.mockImplementation(async (_p, _t, interaction) => {
      interaction.notify({
        type: 'device_code',
        userCode: 'WDJB-MJHT',
        verificationUri: 'https://auth.x.ai/device?code=WDJB-MJHT'
      });
    });
    const { auth, events } = makeAuth();
    const res = await auth.login('xai');
    expect(res.ok).toBe(true);
    expect(loginMock).toHaveBeenCalledWith('xai', 'oauth', expect.anything());
    expect(openExternal).toHaveBeenCalledWith('https://auth.x.ai/device?code=WDJB-MJHT');
    expect(events.map((e) => e.kind)).toEqual(['device-code', 'done']);
    expect(events[0]).toMatchObject({ userCode: 'WDJB-MJHT', verificationUri: 'https://auth.x.ai/device?code=WDJB-MJHT' });
  });

  it('bridges a prompt through an input-request event and respond()', async () => {
    let answered: string | null = null;
    loginMock.mockImplementation(async (_p, _t, interaction) => {
      answered = await interaction.prompt({ type: 'text', message: 'Paste the code' });
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
    loginMock.mockImplementation(async (_p, _t, interaction) => {
      selected = await interaction.prompt({
        type: 'select',
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
      (_p, _t, interaction) =>
        new Promise((_res, rej) => {
          interaction.signal?.addEventListener('abort', () => rej(new Error('Login cancelled.')));
          void interaction.prompt({ type: 'manual_code', message: 'code?' }).catch(() => undefined);
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

  it('treats a persisted credential as success when only the trailing refresh failed', async () => {
    // ModelRuntime.login persists the token, then refreshes catalogs; a refresh
    // failure after the write must not read as a failed sign-in.
    loginMock.mockImplementation(async () => {
      readStoredCredentialMock.mockReturnValue({ type: 'oauth', access: 'tok', refresh: 'r', expires: 9 });
      throw new Error('catalog refresh failed');
    });
    const { auth, events } = makeAuth();
    const res = await auth.login('anthropic');
    expect(res.ok).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'done', ok: true, provider: 'anthropic' });
  });

  it('a second login supersedes the first', async () => {
    loginMock.mockImplementation(
      (provider, _t, interaction) =>
        new Promise((res, rej) => {
          if (interaction.signal?.aborted) return rej(new Error('aborted'));
          interaction.signal?.addEventListener('abort', () => rej(new Error('aborted')));
          // The first attempt (anthropic) stays pending until superseded/aborted;
          // the second (openai-codex) completes immediately.
          if (provider === 'openai-codex') res(undefined);
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
  it('writes the trimmed key through the api_key login prompt', async () => {
    let entered: string | null = null;
    loginMock.mockImplementation(async (_p, _t, interaction) => {
      entered = await interaction.prompt({ type: 'secret', message: 'Enter Anthropic API key' });
    });
    const { auth } = makeAuth();
    await auth.setApiKey('anthropic', '  sk-test-123  ');
    expect(loginMock).toHaveBeenCalledWith('anthropic', 'api_key', expect.anything());
    expect(entered).toBe('sk-test-123');
  });

  it('rejects an empty key without touching storage', async () => {
    const { auth } = makeAuth();
    await expect(auth.setApiKey('openai', '   ')).rejects.toThrow('API key is empty.');
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('tolerates a login error when the key landed in the store anyway', async () => {
    loginMock.mockImplementation(async () => {
      readStoredCredentialMock.mockReturnValue({ type: 'api_key', key: 'sk-x' });
      throw new Error('catalog refresh failed');
    });
    const { auth } = makeAuth();
    await expect(auth.setApiKey('openrouter', 'sk-x')).resolves.toBeUndefined();
  });
});

describe('ProviderAuth.removeProvider', () => {
  it('logs the provider out', async () => {
    const { auth } = makeAuth();
    await auth.removeProvider('anthropic');
    expect(logoutMock).toHaveBeenCalledWith('anthropic');
  });
});

describe('ProviderAuth.listProviders', () => {
  it('returns the stored provider ids', async () => {
    const { auth } = makeAuth();
    await expect(auth.listProviders()).resolves.toEqual(['anthropic']);
  });
});

describe('ProviderAuth.isAlive', () => {
  it('is false without a stored credential, even if ambient auth would resolve', async () => {
    const { auth } = makeAuth();
    await expect(auth.isAlive('anthropic')).resolves.toBe(false);
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it('is true for a stored non-empty API key without hitting the runtime', async () => {
    readStoredCredentialMock.mockReturnValue({ type: 'api_key', key: 'sk-x' });
    const { auth } = makeAuth();
    await expect(auth.isAlive('openrouter')).resolves.toBe(true);
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it('is true for a stored OAuth credential that getAuth can resolve (refresh ok)', async () => {
    readStoredCredentialMock.mockReturnValue({ type: 'oauth', access: 'tok', refresh: 'r', expires: 9 });
    const { auth } = makeAuth();
    await expect(auth.isAlive('anthropic')).resolves.toBe(true);
  });

  it('is false when the OAuth refresh fails', async () => {
    readStoredCredentialMock.mockReturnValue({ type: 'oauth', access: 'tok', refresh: 'r', expires: 9 });
    getAuthMock.mockRejectedValue(new Error('OAuth refresh failed for anthropic'));
    const { auth } = makeAuth();
    await expect(auth.isAlive('anthropic')).resolves.toBe(false);
  });
});
