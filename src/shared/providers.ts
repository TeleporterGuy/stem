import type { AuthProviderId, ApiKeyProviderId, LocalProviderId } from './types';

// Provider identity shared by main (runtime, models-config) and the renderer
// (settings, onboarding): one place for ids and friendly display names.

/** Friendly provider names for the UI (model picker, provider rows, toggles). */
export const PROVIDER_NAMES: Record<string, string> = {
  'openai-codex': 'ChatGPT',
  anthropic: 'Claude',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  lmstudio: 'LM Studio'
};

export const providerName = (p: string): string => PROVIDER_NAMES[p] ?? p;

/** Wizard/settings OAuth choices. */
export const AUTH_PROVIDER_IDS: AuthProviderId[] = ['openai-codex', 'anthropic'];

/** API-key providers offered in the key form. */
export const API_KEY_PROVIDER_IDS: ApiKeyProviderId[] = ['anthropic', 'openai', 'openrouter'];

/** Local keyless model servers Stem can register with the backend. */
export const LOCAL_PROVIDER_IDS: LocalProviderId[] = ['ollama', 'lmstudio'];

export function isLocalProviderId(id: string): id is LocalProviderId {
  return (LOCAL_PROVIDER_IDS as string[]).includes(id);
}
