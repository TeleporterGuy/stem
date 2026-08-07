import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { host } from '../server/host';
import { log } from '../server/log';

// What this CLIENT knows about itself: its row in the server's device registry,
// and the bearer token that proves it.
//
// This file is new in Phase 2, and it is the first client-side state Stem has
// ever had. It exists because the server stopped keeping tokens: devices.json
// holds hashes now, so the credential has to live on the device it belongs to or
// nowhere at all. A client learns its token exactly once — minting it off a
// shared state root, or spending a pairing code — and this is where it keeps it.
//
// The token is wrapped with the host's key wrapper (Electron safeStorage → the
// macOS Keychain) when one is available, and written as plaintext 0600 when it is
// not — the same documented degradation pi/secrets.ts takes, for the same reason:
// a Linux box with no keyring must still be able to run Stem, and 0600 in a
// directory that already holds the chat database is not a new exposure.
//
// Phase 2 step 2 grows this file rather than adding another: the server URL, and
// the settings that are properly about this machine rather than about Stem (the
// Quick Chat hotkey and its geometry, the release-notes seen-state).

/** This client's identity as far as the server is concerned. */
export interface ClientIdentity {
  deviceId: string;
  /** The bearer token, in the clear. In memory and in this file, nowhere else. */
  token: string;
}

interface StoredClient {
  version: 1;
  deviceId: string;
  /** Present when no key wrapper was available. */
  token?: string;
  /** Base64 of the wrapped token; preferred when present. */
  tokenEnc?: string;
}

export function clientStorePath(): string {
  // STEM_CLIENT_FILE lets tests point at a throwaway file, like its neighbours
  // under server/workspace/paths.ts.
  return process.env.STEM_CLIENT_FILE ?? join(host().stateRoot(), 'client.json');
}

/** This client's stored identity, or null if it has never had one. */
export async function readClientIdentity(): Promise<ClientIdentity | null> {
  let stored: StoredClient;
  try {
    stored = JSON.parse(await readFile(clientStorePath(), 'utf8')) as StoredClient;
  } catch {
    return null; // absent, or unreadable — either way we have no identity
  }
  if (typeof stored?.deviceId !== 'string' || !stored.deviceId) return null;

  if (typeof stored.tokenEnc === 'string') {
    const wrapper = host().keyWrapper();
    try {
      if (!wrapper) throw new Error('no key wrapper');
      const token = wrapper.unwrap(Buffer.from(stored.tokenEnc, 'base64'));
      if (token) return { deviceId: stored.deviceId, token };
    } catch (e) {
      // A keychain reset, or a profile copied to another machine. The credential
      // is simply gone; say so and let the caller acquire a new one rather than
      // failing to start.
      log('client', 'could not unwrap the stored token', { error: String((e as Error)?.message ?? e) });
      return null;
    }
  }
  if (typeof stored.token === 'string' && stored.token) {
    return { deviceId: stored.deviceId, token: stored.token };
  }
  return null;
}

/** Persist an identity acquired by minting or pairing. Overwrites any previous one. */
export async function writeClientIdentity(identity: ClientIdentity): Promise<void> {
  const path = clientStorePath();
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const wrapper = host().keyWrapper();
  let stored: StoredClient = { version: 1, deviceId: identity.deviceId, token: identity.token };
  if (wrapper) {
    try {
      stored = {
        version: 1,
        deviceId: identity.deviceId,
        tokenEnc: wrapper.wrap(identity.token).toString('base64')
      };
    } catch (e) {
      // Wrapping failed at the last moment (a locked keychain): fall back to the
      // plaintext form rather than leaving the device with no credential at all.
      log('client', 'could not wrap the token; storing it 0600 instead', {
        error: String((e as Error)?.message ?? e)
      });
    }
  }
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}
