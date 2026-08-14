// What a pairing code is made of, and what a typed one means — in one file,
// because both ends of the wire have to agree about it exactly.
//
// The server hashes the NORMALIZED code and compares hashes (see redeemPairingCode
// in src/server/transport/pairing.ts). A client that normalized even slightly
// differently would send something that hashes to nothing and be told its
// perfectly good code was wrong — a failure with no symptom anyone can act on,
// on the one screen where the user has no other way in. The rule therefore lives
// here and is imported by the minter, the redeemer and the phone alike, rather
// than being written out three times and kept in step by hope.
//
// Deliberately dependency-free: this is imported by the Electron main process,
// by the server, and by the React Native bundle through Metro's `@shared` alias.

/**
 * Crockford-ish: no 0/1/I/L/O/U, so nothing in a code can be misheard or
 * mistyped into a different valid character. 30 symbols over 8 characters is
 * ~2^39, which the server's lockout turns into an unguessable ten-minute window.
 */
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Eight characters, ungrouped. Shown as `ABCD-EFGH`; normalized back to eight. */
export const PAIRING_CODE_LENGTH = 8;

/**
 * What a typed code means. Case and punctuation are the user's business, not
 * ours: dashes, spaces and lowercase all normalize away. Characters outside the
 * alphabet are NOT rewritten — an `O` for a `Q` is a wrong code, and pretending
 * otherwise would quietly widen the code space. They are dropped rather than
 * kept so that the length check below reads as "how many usable characters did
 * you give me", which is the number a person can act on.
 */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^2-9A-Z]/g, '');
}
