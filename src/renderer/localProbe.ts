import type { LocalProviderApi, LocalProviderId } from '../shared/types';

/** The endpoint identity a "Test connection" probe was actually sent to. */
export type LocalProbeTarget = {
  server: LocalProviderId;
  baseUrl: string;
  apiKey: string;
  api: LocalProviderApi;
};

/**
 * Reduce an add-server form to the endpoint it addresses. The URL is trimmed the
 * way the enable path sends it, and the key + API flavor only count for a custom
 * endpoint — that's the only branch that puts either on the wire.
 */
export function localProbeTarget(
  server: LocalProviderId,
  baseUrl: string,
  apiKey: string,
  api: LocalProviderApi = 'openai-completions'
): LocalProbeTarget {
  return {
    server,
    baseUrl: baseUrl.trim(),
    apiKey: server === 'custom' ? apiKey.trim() : '',
    api: server === 'custom' ? api : 'openai-completions'
  };
}

/**
 * Whether a finished probe still describes the form it is about to land in. The
 * probe takes up to 2.5s against a URL the user may keep editing, and its answer
 * — a status badge and, for a custom endpoint, an auto-filled model list — names
 * one specific server. The key and API flavor are part of the identity, not
 * details: the same URL under a different token or protocol can serve a
 * different catalog (or none at all).
 */
export function probeStillDescribes(sent: LocalProbeTarget, form: LocalProbeTarget): boolean {
  return (
    sent.server === form.server &&
    sent.baseUrl === form.baseUrl &&
    sent.apiKey === form.apiKey &&
    sent.api === form.api
  );
}
