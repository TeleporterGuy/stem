import { hostname } from 'node:os';
import { access } from 'node:fs/promises';
import { mintDevice } from '../server/transport/auth';
import { serverEndpointPath } from '../server/workspace/paths';
import { log } from '../server/log';
import { readClientIdentity, writeClientIdentity } from './client-store';

// How this client gets a credential for the server it is about to talk to.
//
// The server no longer hands one out. It keeps hashes, so a token exists only on
// the device that owns it, and there are exactly four ways this machine can be
// holding one — tried in this order, most explicit first:
//
//   1. STEM_SERVER_TOKEN — an override for a harness or a one-off. Never stored.
//   2. client.json — we have been here before. The ordinary path after first run.
//   3. STEM_PAIRING_CODE — a one-shot code, spent on POST /pair. This is the
//      remote path: the code is the only thing that has to travel by hand, and
//      what comes back is stored for next time.
//   4. Mint one directly, which only works because the server reads the same
//      state root we are writing (an embedded server always does; a `stem-server`
//      that published its endpoint here does too). No pairing step, because there
//      is no trust boundary to cross: anything that can write that registry could
//      read the chat database beside it.
//
// A remote server with no code and no stored identity is a hard failure with a
// sentence saying so, rather than a mysterious 401 loop.

/** Everything the proxy needs to reach the server. */
export interface ServerCredentials {
  url: string;
  token: string;
}

/** How this machine will appear in Settings → Devices. */
function deviceLabel(): string {
  try {
    return hostname() || 'This machine';
  } catch {
    return 'This machine';
  }
}

/** Whether the server reads the state root we write — see reason 4 above. */
async function sharesStateRoot(): Promise<boolean> {
  try {
    await access(serverEndpointPath());
    return true;
  } catch {
    return false;
  }
}

/** Spend a pairing code and keep what comes back. */
async function pair(url: string, code: string): Promise<ServerCredentials> {
  let res: Response;
  try {
    res = await fetch(`${url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(30_000)
    });
  } catch (e) {
    throw new Error(`could not reach ${url} to pair: ${String((e as Error)?.message ?? e)}`);
  }
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; result?: { deviceId?: string; token?: string }; error?: string }
    | null;
  const grant = body?.result;
  if (!res.ok || !body?.ok || !grant?.deviceId || !grant.token) {
    throw new Error(body?.error ?? `pairing was refused (HTTP ${res.status})`);
  }
  await writeClientIdentity({ deviceId: grant.deviceId, token: grant.token });
  log('client', 'paired with the server', { deviceId: grant.deviceId });
  return { url, token: grant.token };
}

/**
 * Resolve this client's credentials for `serverUrl`, acquiring one if this is the
 * first time. Throws when there is no way to get one, because a client that
 * cannot authenticate has nothing useful to do next.
 */
export async function clientCredentials(serverUrl: string): Promise<ServerCredentials> {
  const url = serverUrl.replace(/\/$/, '');

  const fromEnv = process.env.STEM_SERVER_TOKEN?.trim();
  if (fromEnv) return { url, token: fromEnv };

  const stored = await readClientIdentity();
  if (stored) return { url, token: stored.token };

  const code = process.env.STEM_PAIRING_CODE?.trim();
  if (code) return pair(url, code);

  if (await sharesStateRoot()) {
    const minted = await mintDevice(deviceLabel());
    await writeClientIdentity({ deviceId: minted.device.id, token: minted.token });
    log('client', 'minted this machine a device record', { deviceId: minted.device.id });
    return { url, token: minted.token };
  }

  throw new Error(
    `no credential for ${url}, and none can be minted here — that server keeps its state somewhere ` +
      'this machine cannot see. Pair instead: run `stem-server pair` where the server is, and start ' +
      'Stem with STEM_PAIRING_CODE set to the code it prints.'
  );
}
