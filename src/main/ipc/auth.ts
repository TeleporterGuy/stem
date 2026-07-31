import { handleIpc } from './guard';
import type { IpcDeps } from './deps';
import { markOnboardingCompleted, readSettings, updateDefaultModel, updateLocalProvider } from '../workspace/settings';
import { probeLocalProvider, syncModelsConfig } from '../pi/models-config';
import { isLocalProviderId } from '../../shared/providers';
import type {
  ApiKeyProviderId,
  AuthProviderId,
  LocalProviderId,
  LocalProviderSettings
} from '../../shared/types';

/** Provider sign-in (onboarding wizard) + local providers (Ollama / LM Studio / custom). */
export function registerAuthIpc(deps: IpcDeps): void {
  handleIpc('auth:providerLogin', async (_e, provider: AuthProviderId) => {
    if (deps.e2e) {
      // Scripted fake: surface the URL step, then complete, so the wizard's
      // whole state machine is exercised without a browser or network. The
      // fake backend flips to authenticated via its login().
      deps.sendToMain('auth:event', { kind: 'auth-url', url: 'https://oauth.example.test/authorize' });
      const status = await deps.runtime().login();
      deps.sendToMain('auth:event', { kind: 'done', ok: true, provider });
      void deps.scheduler()?.start(); // mirror onAuthenticated()
      return { ok: true, status };
    }
    const res = await deps.providerAuth()!.login(provider);
    if (!res.ok) return res;
    return { ok: true, status: await deps.onAuthenticated() };
  });
  handleIpc('auth:setApiKey', async (_e, provider: ApiKeyProviderId, key: string) => {
    if (deps.e2e) {
      const status = await deps.runtime().login();
      void deps.scheduler()?.start(); // mirror onAuthenticated()
      return { ok: true, status };
    }
    try {
      await deps.providerAuth()!.setApiKey(provider, key);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, status: await deps.onAuthenticated() };
  });
  handleIpc('auth:respond', (_e, requestId: string, value: string) => {
    deps.providerAuth()?.respond(requestId, value);
  });
  // Authoritative liveness probe for a stored credential — used reactively to
  // classify a failed turn (expired/revoked OAuth token vs. a transient error).
  handleIpc('auth:check', async (_e, provider: string) => {
    if (deps.e2e) return { alive: true };
    return { alive: await deps.providerAuth()!.isAlive(provider) };
  });
  handleIpc('providers:testLocal', async (_e, _id: LocalProviderId, baseUrl: string, apiKey?: string) => {
    if (deps.e2e) return { ok: true, models: ['stem-e2e-model'] };
    return probeLocalProvider(baseUrl, apiKey);
  });
  handleIpc('providers:updateLocal', async (_e, id: LocalProviderId, patch: Partial<LocalProviderSettings>) => {
    if (deps.e2e) return { ok: true, status: await deps.runtime().login() };
    try {
      const settings = await updateLocalProvider(id, patch);
      const cfg = settings.localProviders[id];
      // models.json first: the credential write goes through pi's provider
      // login, which only knows providers already present in models.json.
      // syncModelsConfig re-reads settings under its own lock — the patch above
      // is already persisted, so it sees this change or a newer one, never older.
      await syncModelsConfig();
      // The endpoint's own key, or the placeholder for keyless local servers
      // (see ProviderAuth.setApiKey).
      if (cfg.enabled) await deps.providerAuth()!.setApiKey(id, cfg.apiKey?.trim() || 'local');
      else await deps.providerAuth()!.removeProvider(id);
      // pi reads models.json and auth.json only at spawn — restart before
      // onAuthenticated() lists models so the new registry is visible to it.
      await deps.runtime().restart();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, status: await deps.onAuthenticated() };
  });
  handleIpc('providers:disconnect', async (_e, providerId: string) => {
    if (deps.e2e) return { ok: true, status: await deps.runtime().status() };
    try {
      await deps.providerAuth()!.removeProvider(providerId);
      if (isLocalProviderId(providerId)) {
        // Drop the endpoint's secret with it — re-adding asks for the key again.
        await updateLocalProvider(providerId, { enabled: false, apiKey: '', models: [] });
        await syncModelsConfig();
      }
      // The default model must not outlive the provider that served it: pi refuses
      // to start when a spawn names a provider it no longer knows, which would
      // brick the backend for every remaining provider. Cleared here rather than
      // left to onAuthenticated()'s re-pick, which needs a live model list — and
      // therefore the very backend the stale default keeps from starting.
      const { defaults } = await readSettings();
      if (defaults.model?.startsWith(`${providerId}/`)) await updateDefaultModel(null);
      await deps.runtime().restart();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, status: await deps.onAuthenticated() };
  });
  handleIpc('auth:cancel', () => {
    deps.providerAuth()?.cancel();
  });
  handleIpc('auth:completeOnboarding', () => markOnboardingCompleted());
}
