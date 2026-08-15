// POST /pair — the transport's only unauthenticated route, and the one call this
// app makes before it has a credential.
//
// A short code, said once, spent once (src/server/transport/pairing.ts). What
// comes back is a device id and a bearer token, and from then on this phone is
// an ordinary client. The code is normalized here to exactly what the server
// hashes — see normalizePairingCode in ./pairing.ts — so a code typed with the
// dash the desktop shows it with is the same code.
//
// Kept apart from ./credentials.ts on purpose: this file speaks HTTP and can be
// tested with an injected fetch, that one speaks to the Keychain and cannot.
// The screen calls this and then writes what it returns, which is also the order
// that guarantees nothing is ever stored for a pairing that did not happen.

import { normalizePairingCode, normalizeServerUrl, pairingCodeProblem, serverUrlProblem } from './pairing';
import type { StoredPairing } from './credentials';

/** A pairing attempt is a person waiting at a screen; it does not get ten minutes. */
const PAIR_TIMEOUT_MS = 30_000;

/**
 * Spend `code` at `rawUrl`. Throws with a sentence a person can act on — the
 * server's own refusal text when it refused ("that code has expired", "too many
 * attempts"), ours when the address never answered.
 */
export async function redeemPairingCode(
  rawUrl: string,
  rawCode: string,
  doFetch: typeof globalThis.fetch = globalThis.fetch
): Promise<StoredPairing> {
  const urlProblem = serverUrlProblem(rawUrl);
  if (urlProblem) throw new Error(urlProblem);
  const codeProblem = pairingCodeProblem(rawCode);
  if (codeProblem) throw new Error(codeProblem);
  const serverUrl = normalizeServerUrl(rawUrl);
  const code = normalizePairingCode(rawCode);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAIR_TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(`${serverUrl}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: controller.signal
    });
  } catch (e) {
    throw new Error(`Could not reach ${serverUrl} to pair: ${String((e as Error)?.message ?? e)}`);
  } finally {
    clearTimeout(timer);
  }

  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; result?: { deviceId?: string; token?: string }; error?: string }
    | null;
  const grant = body?.result;
  if (!res.ok || !body?.ok || !grant?.deviceId || !grant.token) {
    throw new Error(body?.error ?? `Pairing was refused (HTTP ${res.status}).`);
  }
  return { serverUrl, deviceId: grant.deviceId, token: grant.token };
}
