import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { log } from '../log';
import { globalRelay } from '../interstem/relay-client';
import { newSeed, signRequestHeaders } from '../interstem/proto';
import { userDataRoot } from '../workspace/paths';
import type { ApnsResult } from './apns';
import type { WakeUp } from './index';

// The push gateway: how a Stem without the app's APNs key still wakes its
// phone. Only Awantech holds that key, so every other Stem hands the device
// token and the wake-up to the global relay, which signs and sends it.
//
// What crosses: the token and the WakeUp ids, never a label — the relay
// writes the alert from its own fixed wording (relay/internal/server/push.go),
// so the lock screen says "Approval needed", not the thread's title.
//
// Signed with a key of its own (push-gateway.key), not the inter-Stem
// identity, so the relay cannot tie push traffic to a mail address. The relay
// binds each token to the first key that pushes to it; losing this file means
// another key is refused for that phone until the old one has been idle a week.
//
// On whenever no STEM_APNS_* value is set; STEM_PUSH_GATEWAY=off turns it off.

/** Whether to send through the relay. False when any direct APNs value is set, even half of them. */
export function gatewayEnabled(): boolean {
  if (process.env.STEM_PUSH_GATEWAY?.trim() === 'off') return false;
  return !['STEM_APNS_KEY_PATH', 'STEM_APNS_KEY_ID', 'STEM_APNS_TEAM_ID', 'STEM_APNS_BUNDLE_ID'].some((k) =>
    process.env[k]?.trim()
  );
}

function gatewayUrl(): string {
  return (process.env.STEM_PUSH_GATEWAY_URL?.trim() || globalRelay().url).replace(/\/+$/, '');
}

const keyPath = (): string => process.env.STEM_PUSH_GATEWAY_KEY ?? join(userDataRoot(), 'push-gateway.key');

let seed: Promise<Buffer> | null = null;

/**
 * The signing seed, created on first use. Plain hex at 0600 rather than under
 * the data key: all it can do is wake this Stem's own phones, and an
 * unreadable data key would otherwise lock those phones out for a week.
 */
function loadSeed(): Promise<Buffer> {
  seed ??= (async () => {
    const path = keyPath();
    const hex = (
      await readFile(path, 'utf8').catch(() => {
        // quiet: no key yet (first push) or an unreadable one; a fresh key is made below.
        return '';
      })
    ).trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
    const fresh = newSeed();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, fresh.toString('hex') + '\n', { mode: 0o600 });
    await chmod(path, 0o600).catch(() => {
      // quiet: writeFile already set 0600; chmod only tightens an older file.
    });
    return fresh;
  })();
  seed.catch(() => {
    // quiet: the send that awaited this logs the failure; forget it so the next one retries.
    seed = null;
  });
  return seed;
}

export type GatewayPost = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>;

let post: GatewayPost | null = null;

/** Tests replace the HTTP call (null restores fetch). */
export function setGatewayPost(next: GatewayPost | null): void {
  post = next;
}

/** Forget the cached seed (tests). */
export function resetGateway(): void {
  seed = null;
}

async function fetchPost(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  return { status: res.status, body: await res.text() };
}

/** Wake one device through the relay. Never throws, like sendApns. */
export async function sendViaGateway(deviceToken: string, wake: WakeUp): Promise<ApnsResult> {
  const path = '/v1/push';
  // Sandbox only for an Xcode dev build pointed here on purpose.
  const env = process.env.STEM_PUSH_GATEWAY_ENV?.trim() === 'sandbox' ? 'sandbox' : 'production';
  const body = JSON.stringify({ token: deviceToken, env, wake });
  try {
    const headers = { 'Content-Type': 'application/json', ...signRequestHeaders(await loadSeed(), 'POST', path, body) };
    const res = await (post ?? fetchPost)(gatewayUrl() + path, headers, body);
    if (res.status === 200) return /"gone"/.test(res.body) ? 'gone' : 'sent';
    log('push', 'push gateway refused a push', { status: res.status, body: res.body.slice(0, 200) });
  } catch (e) {
    log('push', 'push gateway unreachable', { error: String((e as Error)?.message ?? e) });
  }
  return 'failed';
}
