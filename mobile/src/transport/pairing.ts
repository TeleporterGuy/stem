// Everything about a pairing that is a string transformation rather than a
// network call: what a server address has to look like, what a code has to look
// like, and how to read the QR the desktop shows.
//
// Split out from ./credentials.ts and ./client.ts so it can be tested without
// Expo and without a socket — and because the two normalizations here have to
// agree with code that lives on the other side of the wire. `normalizePairingCode`
// is deliberately the same transformation as normalizeCode() in
// src/server/transport/pairing.ts: the server hashes the NORMALIZED code, so a
// client that normalized differently would send something that hashes to nothing
// and would be told, unhelpfully, that a perfectly good code was wrong.
//
// The trailing-slash rule for the URL is client-store.ts's rule, for its reason:
// the stored form and the compared form must agree, or the same server reached
// via "https://x/" and "https://x" looks like two servers and the second one
// throws away the first one's credential.

/** What the QR the desktop renders decodes to, and what the manual form fills in. */
export interface PairingTarget {
  serverUrl: string;
  code: string;
}

/** Codes are eight characters; see ALPHABET in src/server/transport/pairing.ts. */
export const PAIRING_CODE_LENGTH = 8;

/** Trailing slashes off, whitespace off. */
export function normalizeServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Why this address cannot be used, phrased for a person, or null when it can.
 *
 * The wording follows pairWithServer() in src/desktop/server-endpoint.ts — the
 * same mistake should read the same on both clients.
 */
export function serverUrlProblem(raw: string): string | null {
  const url = normalizeServerUrl(raw);
  if (!url) return 'Enter the address your desktop shows, like https://stem.example.com.';
  if (!/^https?:\/\/[^/]+/i.test(url)) {
    return `"${raw.trim()}" is not a server address — it needs to start with http:// or https://.`;
  }
  return null;
}

/**
 * A typed code as the server will read it: dashes, spaces and lowercase all fall
 * away, because a code is meant to be read aloud and `abcd-efgh` is the same code
 * as `ABCDEFGH`.
 */
export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/[^2-9A-Z]/g, '');
}

/** Why this code cannot be spent, phrased for a person, or null when it can. */
export function pairingCodeProblem(raw: string): string | null {
  const code = normalizePairingCode(raw);
  if (!code) return 'Enter the eight-character code your desktop shows.';
  if (code.length !== PAIRING_CODE_LENGTH) {
    return `A pairing code is ${PAIRING_CODE_LENGTH} characters; this one has ${code.length}.`;
  }
  return null;
}

/**
 * Read a scanned QR payload.
 *
 * The payload is a URL rather than JSON so that a phone with no Stem on it yet
 * still does something sensible with the scan (iOS offers to open `stem://`,
 * which the App Store handles) and so the desktop can hand the same string to a
 * "copy link" button. Anything that is not that URL returns null and the scanner
 * keeps looking — a camera pointed at a wall sees a great many things.
 *
 * Hand-parsed rather than run through `new URL()`: React Native's URL is a
 * polyfill with a history of surprises around non-http schemes, and this is
 * three fields.
 */
export function parsePairPayload(text: string): PairingTarget | null {
  const match = /^stem:\/\/pair\/?\?(.+)$/i.exec(text.trim());
  if (!match) return null;
  const params = new Map<string, string>();
  for (const pair of match[1].split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      params.set(decodeURIComponent(key), decodeURIComponent(value.replace(/\+/g, ' ')));
    } catch {
      return null; // a malformed escape is a malformed payload
    }
  }
  // `url` is the name the desktop's QR uses; `serverUrl` is accepted because it
  // is the name the same value carries everywhere else in this codebase, and a
  // pairing that fails over which of two spellings was chosen would be a poor
  // way to spend somebody's ten-minute code.
  const serverUrl = normalizeServerUrl(params.get('url') ?? params.get('serverUrl') ?? '');
  const code = normalizePairingCode(params.get('code') ?? '');
  if (serverUrlProblem(serverUrl) || pairingCodeProblem(code)) return null;
  return { serverUrl, code };
}
