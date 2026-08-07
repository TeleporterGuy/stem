import { ensureDevice } from '../server/transport/auth';
import type { TransportEndpoint } from '../server/startup/transport';

// How the desktop finds a server it did not start.
//
// In the embedded case none of this runs: startServer() hands back the URL and
// the token directly. STEM_SERVER_URL is the other case — a `stem-server` process
// already listening — and then the URL is given but the credential is not.
//
// Phase 1 only ever puts that process on the same machine, sharing the same state
// root, so this machine's device record is simply read from the registry the
// server already wrote (ensureDevice is a read once the record exists).
// STEM_SERVER_TOKEN is the escape hatch for the day the two stop sharing a disk —
// which is Phase 2's one-shot pairing flow, not a second env var.

export async function readServerCredentials(url: string): Promise<TransportEndpoint> {
  const fromEnv = process.env.STEM_SERVER_TOKEN?.trim();
  if (fromEnv) return { url: url.replace(/\/$/, ''), token: fromEnv };
  const device = await ensureDevice('device', 'This machine');
  return { url: url.replace(/\/$/, ''), token: device.token };
}
