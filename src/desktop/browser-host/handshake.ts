import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// How the native host and the desktop prove to each other that both hold the
// token Set up wrote to this profile's config, without the token ever crossing
// the socket. Each side sends a fresh nonce and answers the other's with an
// HMAC under the token:
//
//   host → desktop   host-hello   { nonce: h, appPath, appName }
//   desktop → host   server-hello { nonce: s, proof: mac("stem", h) }
//   host → desktop   host-proof   { proof: mac("host", s) }
//
// The desktop goes first with its proof, so a native host relays nothing, not
// even the extension's hello, to a peer that cannot show the token. That peer
// is the case this exists for: on Windows a named pipe's name can be listed by
// any process, which can take the name once Stem quits and wait for the host's
// reconnect. On a Mac and Linux the socket sits in a 0700 folder, and the same
// handshake costs nothing there.

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

export function handshakeProof(token: string, role: 'stem' | 'host', nonce: string): string {
  return createHmac('sha256', token).update(`${role}\0${nonce}`).digest('hex');
}

/** Constant-time check of a proof the peer sent. */
export function proofMatches(token: string, role: 'stem' | 'host', nonce: string, proof: unknown): boolean {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return timingSafeEqual(Buffer.from(handshakeProof(token, role, nonce), 'hex'), Buffer.from(proof, 'hex'));
}

export const isNonce = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
