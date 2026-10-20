// The byte-exact half of relay/PROTOCOL.md on Stem's side: signing strings,
// certificates, envelopes, sealing, request signatures, proof-of-work. It
// must reproduce relay/testdata/vectors.json (tests/unit/interstem-proto.test.ts)
// and uses only node:crypto, like the Go relay uses only its standard crypto.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject
} from 'node:crypto';

export const MAX_SKEW_MS = 5 * 60_000;
/** Relays hold mail 7 days; a day of slack for clocks and redelivery. */
export const HOLD_MAX_MS = 8 * 86_400_000;

export const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
export const unb64 = (s: string): Buffer => Buffer.from(s, 'base64');
export const sha256Hex = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

export function normalizeAddress(a: string): string {
  return a.trim().toLowerCase();
}

/** Loose check mirroring proto.ValidAddress in Go. */
export function validAddress(a: string): boolean {
  if (a.length > 254 || a !== normalizeAddress(a)) return false;
  const at = a.lastIndexOf('@');
  if (at <= 0 || at === a.length - 1 || a.indexOf('@') !== at) return false;
  for (let i = 0; i < a.length; i++) if (a.charCodeAt(i) <= 0x20 || a.charCodeAt(i) === 0x7f) return false;
  if (/\s/.test(a)) return false;
  return a.slice(at + 1).includes('.');
}

export const domainOf = (a: string): string => a.slice(a.lastIndexOf('@') + 1);

// ---- raw keys <-> KeyObjects ----

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

export const edPrivate = (seed: Uint8Array): KeyObject =>
  createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' });
export const edPublic = (raw: Uint8Array): KeyObject =>
  createPublicKey({ key: Buffer.concat([ED_SPKI, raw]), format: 'der', type: 'spki' });
export const xPrivate = (raw: Uint8Array): KeyObject =>
  createPrivateKey({ key: Buffer.concat([X_PKCS8, raw]), format: 'der', type: 'pkcs8' });
export const xPublic = (raw: Uint8Array): KeyObject =>
  createPublicKey({ key: Buffer.concat([X_SPKI, raw]), format: 'der', type: 'spki' });

/** The raw 32-byte public key of an Ed25519 or X25519 key. */
export function rawPublic(key: KeyObject): Buffer {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  return (pub.export({ format: 'der', type: 'spki' }) as Buffer).subarray(12);
}

export function newSeed(): Buffer {
  return randomBytes(32);
}

/** A fresh X25519 private key as its raw 32 bytes. */
export function newX25519Raw(): Buffer {
  const { privateKey } = generateKeyPairSync('x25519');
  return (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(16);
}

export const fingerprint = (edPubRaw: Uint8Array): string => sha256Hex(edPubRaw);

export const edSign = (seed: Uint8Array, msg: string | Uint8Array): string =>
  b64(sign(null, Buffer.from(msg), edPrivate(seed)));

export function edVerify(pubRaw: Uint8Array, msg: string | Uint8Array, sigB64: string): boolean {
  try {
    const sig = unb64(sigB64);
    return pubRaw.length === 32 && sig.length === 64 && verify(null, Buffer.from(msg), edPublic(pubRaw), sig);
  } catch {
    // quiet: a malformed key or signature is simply "doesn't verify".
    return false;
  }
}

// ---- key blob ----

export interface KeyBlob {
  v: 1;
  sig: string;
  enc: string;
  encSig: string;
}

export function makeKeyBlob(seed: Uint8Array, encPrivRaw: Uint8Array): KeyBlob {
  const sig = b64(rawPublic(edPrivate(seed)));
  const enc = b64(rawPublic(xPrivate(encPrivRaw)));
  return { v: 1, sig, enc, encSig: edSign(seed, `stem-key-v1\n${enc}`) };
}

/** Parse and check a looked-up key blob against the authKey beside it. */
export function checkKeyBlob(authKey: string, blobJson: string): { sigPub: Buffer; encPub: Buffer } | null {
  let blob: KeyBlob;
  try {
    blob = JSON.parse(blobJson) as KeyBlob;
  } catch {
    // quiet: an unparseable blob is the same answer as a bad one, null.
    return null;
  }
  if (blob?.v !== 1 || blob.sig !== authKey || typeof blob.enc !== 'string') return null;
  const sigPub = unb64(blob.sig);
  const encPub = unb64(blob.enc);
  if (sigPub.length !== 32 || encPub.length !== 32) return null;
  if (!edVerify(sigPub, `stem-key-v1\n${blob.enc}`, blob.encSig)) return null;
  return { sigPub, encPub };
}

// ---- certificates ----

export interface Cert {
  v: 1;
  address: string;
  keyFp: string;
  issuer: string;
  kid: string;
  iat: number;
  exp: number;
  sig: string;
}

export const certSigningString = (c: Cert): string =>
  `stem-cert-v1\n${c.address}\n${c.keyFp}\n${c.issuer}\n${c.iat}\n${c.exp}\n${c.kid}`;

export const certString = (c: Cert): string => `${certSigningString(c)}\n${c.sig}`;

/** Relay keys allowed to certify an address: its authority's URL and kid → raw key. */
export type IssuerKeys = (address: string) => Promise<{ issuer: string; keys: Record<string, Buffer> }>;

export async function verifyCert(c: Cert, now: number, issuerKeys: IssuerKeys): Promise<string | null> {
  if (!c || c.v !== 1 || typeof c.address !== 'string' || !validAddress(c.address)) return 'malformed certificate';
  const { issuer, keys } = await issuerKeys(c.address);
  if (issuer !== c.issuer || !keys[c.kid]) return 'certificate issuer is not the authority for this address';
  if (!edVerify(keys[c.kid], certSigningString(c), c.sig)) return 'certificate signature invalid';
  if (c.iat > now + MAX_SKEW_MS || now >= c.exp) return 'certificate expired or not yet valid';
  return null;
}

// ---- envelopes ----

export interface Envelope {
  v: 1;
  id: string;
  ts: number;
  from: string;
  to: string;
  cert: Cert;
  signer: string;
  sealed: string;
  sig: string;
}

export const envelopeSigningString = (e: Omit<Envelope, 'sig' | 'signer'>, sealed: Uint8Array): string =>
  `stem-env-v1\n${e.id}\n${e.ts}\n${e.from}\n${e.to}\n${sha256Hex(sealed)}\n${sha256Hex(certString(e.cert))}`;

export function signEnvelope(e: Omit<Envelope, 'sig' | 'signer'>, seed: Uint8Array): Envelope {
  const sealed = unb64(e.sealed);
  return {
    ...e,
    signer: b64(rawPublic(edPrivate(seed))),
    sig: edSign(seed, envelopeSigningString(e, sealed))
  };
}

export const newId = (): string => randomBytes(16).toString('hex');

/**
 * Check an envelope the way the relay does, plus the recipient's own check
 * (a Stem never takes its relay's word). Returns the sealed bytes or an error.
 */
export async function verifyEnvelope(
  e: Envelope,
  now: number,
  issuerKeys: IssuerKeys,
  opts: { checkTimestamp?: boolean } = {}
): Promise<{ sealed: Buffer; signer: Buffer } | { error: string }> {
  if (e?.v !== 1 || !/^[0-9a-f]{32}$/.test(e.id ?? '') || !validAddress(e.from) || !validAddress(e.to) || !e.cert) {
    return { error: 'malformed envelope' };
  }
  // Held mail can arrive days later, so only the relay checks freshness.
  if (opts.checkTimestamp && Math.abs(now - e.ts) > MAX_SKEW_MS) return { error: 'envelope timestamp out of range' };
  if (e.cert.address !== e.from) return { error: 'certificate is for a different address' };
  // A recipient verifies against the cert's validity at sending time, which
  // the relay checked on arrival; ts can't be older than the relay holds mail.
  if (!opts.checkTimestamp && (now - e.ts > HOLD_MAX_MS || e.ts - now > MAX_SKEW_MS)) {
    return { error: 'envelope is older than any relay holds mail' };
  }
  const certErr = await verifyCert(e.cert, opts.checkTimestamp ? now : e.ts, issuerKeys);
  if (certErr) return { error: certErr };
  const signer = unb64(e.signer ?? '');
  if (signer.length !== 32 || fingerprint(signer) !== e.cert.keyFp)
    return { error: 'signer does not match certificate' };
  const sealed = unb64(e.sealed ?? '');
  if (sealed.length < 32 + 16) return { error: 'bad sealed payload' };
  if (!edVerify(signer, envelopeSigningString(e, sealed), e.sig)) return { error: 'envelope signature invalid' };
  return { sealed, signer };
}

// ---- sealing ----

const sealAad = (id: string, from: string, to: string): Buffer => Buffer.from(`stem-seal-v1\n${id}\n${from}\n${to}`);

function sealKey(shared: Buffer, ephPub: Buffer, recipPub: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephPub, recipPub]), 'stem-seal-v1', 32));
}

// AES-256-GCM, not ChaCha20-Poly1305: Electron's BoringSSL (the desktop app's
// embedded server) has no ChaCha20 cipher. The key is single-use, so the fixed
// nonce is safe.
const ZERO_NONCE = Buffer.alloc(12);

export function seal(
  recipientEncPub: Uint8Array,
  plaintext: Uint8Array,
  id: string,
  from: string,
  to: string,
  ephPrivRaw: Uint8Array = newX25519Raw()
): Buffer {
  const eph = xPrivate(ephPrivRaw);
  const ephPub = rawPublic(eph);
  const recip = Buffer.from(recipientEncPub);
  const shared = diffieHellman({ privateKey: eph, publicKey: xPublic(recip) });
  const cipher = createCipheriv('aes-256-gcm', sealKey(shared, ephPub, recip), ZERO_NONCE, { authTagLength: 16 });
  cipher.setAAD(sealAad(id, from, to), { plaintextLength: plaintext.length });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ephPub, ct, cipher.getAuthTag()]);
}

/** Inverse of seal; throws when the payload doesn't open (tampered, wrong key). */
export function open(encPrivRaw: Uint8Array, sealed: Uint8Array, id: string, from: string, to: string): Buffer {
  const buf = Buffer.from(sealed);
  if (buf.length < 48) throw new Error('sealed payload too short');
  const ephPub = buf.subarray(0, 32);
  const priv = xPrivate(encPrivRaw);
  const shared = diffieHellman({ privateKey: priv, publicKey: xPublic(ephPub) });
  const decipher = createDecipheriv('aes-256-gcm', sealKey(shared, ephPub, rawPublic(priv)), ZERO_NONCE, {
    authTagLength: 16
  });
  const ct = buf.subarray(32, buf.length - 16);
  decipher.setAAD(sealAad(id, from, to), { plaintextLength: ct.length });
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ---- request signatures ----

export const requestSigningString = (
  method: string,
  pathQuery: string,
  ts: number,
  body: Uint8Array | string
): string => `stem-req-v1\n${method}\n${pathQuery}\n${ts}\n${sha256Hex(body)}`;

export function signRequestHeaders(
  seed: Uint8Array,
  method: string,
  pathQuery: string,
  body: string | Uint8Array,
  now = Date.now()
): Record<string, string> {
  return {
    'Stem-Key': b64(rawPublic(edPrivate(seed))),
    'Stem-Time': String(now),
    'Stem-Sig': edSign(seed, requestSigningString(method, pathQuery, now, body))
  };
}

// ---- proof of work ----

function leadingZeroBits(h: Buffer): number {
  let n = 0;
  for (const byte of h) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

export function powOk(address: string, keyB64: string, nonce: string, bits: number): boolean {
  if (bits <= 0) return true;
  const h = createHash('sha256').update(`stem-pow-v1\n${address}\n${keyB64}\n${nonce}`).digest();
  return leadingZeroBits(h) >= bits;
}

/** Brute-force a nonce; ~2^bits hashes (20 bits ≈ a second). */
export function solvePow(address: string, keyB64: string, bits: number): string {
  for (let i = 0; ; i++) {
    const n = String(i);
    if (powOk(address, keyB64, n, bits)) return n;
  }
}

/** solvePow without blocking the event loop: yields every 20k hashes. */
export async function solvePowAsync(address: string, keyB64: string, bits: number): Promise<string> {
  for (let i = 0; ; i++) {
    const n = String(i);
    if (powOk(address, keyB64, n, bits)) return n;
    if (i % 20_000 === 19_999) await new Promise((r) => setImmediate(r));
  }
}
