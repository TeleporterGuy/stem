// What this phone knows about itself: which server it talks to, its row in that
// server's device registry, and the bearer token that proves it.
//
// The mobile counterpart of src/desktop/client-store.ts, and it keeps that
// file's load-bearing rule: `serverUrl` and the identity are ONE unit, always
// written and cleared together. A token means nothing to a server that never
// issued it, so carrying one across a change of address is not a saving — it is
// a 401 loop with no way out but reinstalling the app. On the desktop that rule
// is upheld by three deletes in a row inside one write; here it is upheld by
// there being one key holding one JSON object, which is the same rule with no
// way to get it wrong.
//
// The store is expo-secure-store, i.e. the iOS Keychain — the same class of
// place the desktop puts its token via Electron's safeStorage. There is no
// plaintext fallback and there does not need to be one: unlike the Linux box
// with no keyring that client-store.ts has to degrade for, every device this app
// runs on has a Keychain.
//
// AFTER_FIRST_UNLOCK rather than the default WHEN_UNLOCKED, because a push is a
// wake-up tap (Phase 4 decision 6) and the app may be launched into the
// background to resync before the user has unlocked the phone since boot. A
// credential that cannot be read then would turn a notification into a blank
// screen.

import * as SecureStore from 'expo-secure-store';

/** This client's identity as far as the server is concerned, plus where it lives. */
export interface StoredPairing {
  /** Origin, normalized (no trailing slash) — see ./pairing.ts. */
  serverUrl: string;
  deviceId: string;
  /** The bearer token, in the clear. In the Keychain and in memory, nowhere else. */
  token: string;
}

const KEY = 'stem.pairing';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK
};

/** The stored pairing, or null when this phone has never been paired. */
export async function readPairing(): Promise<StoredPairing | null> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(KEY, OPTIONS);
  } catch {
    // A Keychain that will not answer (a restored backup, a reset) is the same
    // situation as never having paired: there is nothing to recover and asking
    // the user to pair again is the only useful behavior.
    return null;
  }
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<StoredPairing>;
    if (!stored?.serverUrl || !stored.deviceId || !stored.token) return null;
    return { serverUrl: stored.serverUrl, deviceId: stored.deviceId, token: stored.token };
  } catch {
    return null;
  }
}

/** Persist a pairing, replacing any previous one. */
export async function writePairing(pairing: StoredPairing): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(pairing), OPTIONS);
}

/** Forget the server and the credential that went with it, in one act. */
export async function clearPairing(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY, OPTIONS);
}
