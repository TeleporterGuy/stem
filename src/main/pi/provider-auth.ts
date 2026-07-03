import { randomUUID } from 'node:crypto';
import { shell } from 'electron';
import type { AuthProviderId, ApiKeyProviderId, AuthUiEvent, LocalProviderId } from '../../shared/types';

// In-app provider sign-in. pi's TUI is NOT required for login: the pi package
// exports AuthStorage, whose login(providerId, callbacks) runs the full PKCE
// OAuth flow (anthropic → 127.0.0.1:53692/callback, openai-codex →
// localhost:1455/auth/callback) and persists the credential to auth.json with
// file locking. This class bridges those callbacks to the renderer's wizard:
// events go out as AuthUiEvent pushes; text answers (manual code paste) come
// back via respond(). One login at a time — a new attempt supersedes.
//
// The pi package is pure ESM and rollup-external; import it lazily so app
// startup never pays for it.

type PiModule = typeof import('@earendil-works/pi-coding-agent');

interface ActiveLogin {
  controller: AbortController;
  pending: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>;
}

export class ProviderAuth {
  private active: ActiveLogin | null = null;
  private piModule: Promise<PiModule> | null = null;

  constructor(
    private readonly authPath: string,
    private readonly emit: (event: AuthUiEvent) => void
  ) {}

  get busy(): boolean {
    return this.active !== null;
  }

  /**
   * Run the OAuth flow for a provider. Resolves once the credential is written
   * to auth.json (ok:true) or the flow failed/was cancelled (ok:false). Emits
   * progress AuthUiEvents throughout, including the final `done`.
   */
  async login(providerId: AuthProviderId): Promise<{ ok: boolean; error?: string }> {
    if (this.active) this.cancel(); // supersede a stale attempt
    const controller = new AbortController();
    const active: ActiveLogin = { controller, pending: new Map() };
    this.active = active;
    try {
      const { AuthStorage } = await this.loadPi();
      const store = AuthStorage.create(this.authPath);
      await store.login(providerId, {
        onAuth: ({ url, instructions }) => {
          void shell.openExternal(url);
          this.emit({ kind: 'auth-url', url, ...(instructions ? { instructions } : {}) });
        },
        onDeviceCode: (info) =>
          this.emit({ kind: 'device-code', userCode: info.userCode, verificationUri: info.verificationUri }),
        onProgress: (message) => this.emit({ kind: 'progress', message }),
        onPrompt: (prompt) => this.awaitInput(active, prompt.message, prompt.placeholder),
        onManualCodeInput: () => this.awaitInput(active, 'Paste the code from your browser'),
        // openai-codex offers browser vs device-code; the wizard always drives
        // the browser flow (device-code is a possible follow-up).
        onSelect: async (sel) => sel.options.find((o) => o.id === 'browser')?.id ?? sel.options[0]?.id,
        signal: controller.signal
      });
      this.emit({ kind: 'done', ok: true, provider: providerId });
      return { ok: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.emit({ kind: 'done', ok: false, provider: providerId, error });
      return { ok: false, error };
    } finally {
      if (this.active === active) this.active = null;
    }
  }

  /** Answer an `input-request` event (manual code paste, etc.). */
  respond(requestId: string, value: string): void {
    const req = this.active?.pending.get(requestId);
    if (!req) return;
    this.active!.pending.delete(requestId);
    req.resolve(value);
  }

  /** Abort the in-flight login (tears down pi's localhost callback server). */
  cancel(): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    for (const req of active.pending.values()) req.reject(new Error('Login cancelled.'));
    active.pending.clear();
    active.controller.abort();
  }

  /**
   * Save a plain API key; written through AuthStorage so the file lock is honored.
   * Local providers (Ollama, LM Studio) get a placeholder key — their servers are
   * keyless, but the entry makes pi's availability check, Stem's provider filter,
   * and the authenticated gate all treat them as signed in.
   */
  async setApiKey(provider: ApiKeyProviderId | LocalProviderId, key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) throw new Error('API key is empty.');
    const { AuthStorage } = await this.loadPi();
    AuthStorage.create(this.authPath).set(provider, { type: 'api_key', key: trimmed });
  }

  /** Remove a provider's stored credential (Disconnect). Missing entries are a no-op. */
  async removeProvider(provider: string): Promise<void> {
    const { AuthStorage } = await this.loadPi();
    AuthStorage.create(this.authPath).remove(provider);
  }

  /** Provider ids with stored credentials. */
  async listProviders(): Promise<string[]> {
    const { AuthStorage } = await this.loadPi();
    return AuthStorage.create(this.authPath).list();
  }

  private awaitInput(active: ActiveLogin, message: string, placeholder?: string): Promise<string> {
    const requestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      active.pending.set(requestId, { resolve, reject });
      this.emit({ kind: 'input-request', requestId, message, ...(placeholder ? { placeholder } : {}) });
    });
  }

  private loadPi(): Promise<PiModule> {
    // Cached: the module is stateless for our use, and re-importing on every
    // call is wasted work (pi's index pulls a sizable dependency tree).
    this.piModule ??= import('@earendil-works/pi-coding-agent');
    return this.piModule;
  }
}
