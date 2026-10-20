// The organization's inter-Stem policy: a machine-wide file an administrator
// (or MDM) installs, which the user cannot loosen from inside Stem.
//
//   { "interStem": { "enabled": false } }
//     No inter-Stem mail at all, and nothing is sent to any relay
//     (the push gateway included).
//
//   { "interStem": { "domains": ["acme.com"],
//                    "relay": "https://stem-relay.acme.com",
//                    "relayKeys": ["k1:<base64 Ed25519 public key>"] } }
//     Mail only with addresses in those domains, only through that relay.
//     The global relay is never contacted. Without "relay", each domain's
//     _stem TXT record names its relay, and a domain without one is
//     unreachable (never handed to the global relay).
//
// No file means no restriction. A file that exists but can't be read or
// parsed turns inter-Stem mail off: a broken lockdown must not fail open.
//
// Where: macOS /Library/Application Support/Stem/policy.json, Linux
// /etc/stem/policy.json, Windows %ProgramData%\Stem\policy.json. A headless
// server (no machine-wide file) takes the same JSON in STEM_POLICY; the file
// wins when both exist.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { degrade } from '../degrade';
import { domainOf, unb64 } from './proto';

export type InterStemPolicy =
  | { mode: 'open' }
  | { mode: 'off' }
  | {
      mode: 'restricted';
      /** Lowercased domains the organization allows mail with. */
      domains: string[];
      /** The one relay every address in those domains lives on, when pinned. */
      relay?: { url: string; keys: Record<string, Buffer> };
    };

/** Why an address is refused, phrased for the person who tried. */
export class PolicyError extends Error {}

export function policyFilePath(platform: NodeJS.Platform = process.platform, env = process.env): string {
  if (platform === 'darwin') return '/Library/Application Support/Stem/policy.json';
  if (platform === 'win32') return join(env.ProgramData ?? 'C:\\ProgramData', 'Stem', 'policy.json');
  return '/etc/stem/policy.json';
}

/** Parse the policy JSON. Anything malformed is "off", never "open". */
export function parsePolicy(text: string): InterStemPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    degrade('interstem', 'policy file is not valid JSON; inter-Stem mail is off', err);
    return { mode: 'off' };
  }
  const p = (raw as { interStem?: unknown })?.interStem as
    | {
        enabled?: unknown;
        domains?: unknown;
        relay?: unknown;
        relayKeys?: unknown;
      }
    | undefined;
  if (p === undefined) return { mode: 'open' };
  const bad = (why: string): InterStemPolicy => {
    degrade('interstem', `policy file: ${why}; inter-Stem mail is off`, new Error(why));
    return { mode: 'off' };
  };
  if (!p || typeof p !== 'object') return bad('"interStem" is not an object');
  if (p.enabled === false) return { mode: 'off' };
  if (p.enabled !== undefined && p.enabled !== true) return bad('"enabled" is not true or false');
  if (p.domains === undefined) {
    if (p.relay !== undefined || p.relayKeys !== undefined) return bad('"relay" needs "domains"');
    return { mode: 'open' };
  }
  if (
    !Array.isArray(p.domains) ||
    !p.domains.length ||
    !p.domains.every((d) => typeof d === 'string' && d.includes('.'))
  )
    return bad('"domains" must list domain names');
  const domains = [...new Set(p.domains.map((d: string) => d.trim().toLowerCase()))];
  if (p.relay === undefined) {
    if (p.relayKeys !== undefined) return bad('"relayKeys" needs "relay"');
    return { mode: 'restricted', domains };
  }
  if (typeof p.relay !== 'string' || !/^https?:\/\/[^/]+/.test(p.relay)) return bad('"relay" is not a URL');
  const keys: Record<string, Buffer> = {};
  for (const entry of Array.isArray(p.relayKeys) ? p.relayKeys : []) {
    const colon = typeof entry === 'string' ? entry.indexOf(':') : -1;
    const pub = colon > 0 ? unb64((entry as string).slice(colon + 1)) : Buffer.alloc(0);
    if (pub.length !== 32) return bad(`relay key ${JSON.stringify(entry)} is not "kid:<base64 Ed25519 key>"`);
    keys[(entry as string).slice(0, colon)] = pub;
  }
  if (!Object.keys(keys).length) return bad('"relay" needs "relayKeys"');
  return {
    mode: 'restricted',
    domains,
    relay: { url: p.relay.replace(/\/+$/, ''), keys }
  };
}

export function loadPolicy(path = policyFilePath(), env = process.env): InterStemPolicy {
  let text: string | null = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // A file that exists but can't be read is a lockdown we can't see: off.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      degrade('interstem', `could not read the policy file ${path}; inter-Stem mail is off`, err);
      return { mode: 'off' };
    }
  }
  if (text !== null) return parsePolicy(text);
  return env.STEM_POLICY?.trim() ? parsePolicy(env.STEM_POLICY) : { mode: 'open' };
}

let cached: InterStemPolicy | null = null;

/** The policy for this process, read once (a changed file applies on restart). */
export function interStemPolicy(): InterStemPolicy {
  cached ??= loadPolicy();
  return cached;
}

/** Tests set a policy directly (null re-reads the file next time). */
export function setInterStemPolicy(next: InterStemPolicy | null): void {
  cached = next;
}

/** Throws PolicyError unless the policy lets this Stem mail (or hold) the address at all. */
export function assertAddressAllowed(policy: InterStemPolicy, address: string): void {
  if (policy.mode === 'open') return;
  if (policy.mode === 'off') throw new PolicyError('Your organization has turned off mail with other Stems.');
  if (!policy.domains.includes(domainOf(address)))
    throw new PolicyError(`Your organization only allows Stem mail with ${policy.domains.join(', ')}.`);
}

/**
 * Whether a stored address on `relay` may still be used under the policy.
 * `globalUrl` is the global relay's: an address that was verified there
 * before the organization published its own record is never used under a
 * restriction, pinned relay or not.
 */
export function addressUsable(policy: InterStemPolicy, address: string, relay: string, globalUrl: string): boolean {
  if (policy.mode === 'open') return true;
  if (policy.mode === 'off' || !policy.domains.includes(domainOf(address))) return false;
  if (policy.relay) return policy.relay.url === relay;
  return relay !== globalUrl;
}
