import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  b64,
  certSigningString,
  checkKeyBlob,
  edPrivate,
  edSign,
  envelopeSigningString,
  fingerprint,
  makeKeyBlob,
  open,
  powOk,
  rawPublic,
  requestSigningString,
  seal,
  signEnvelope,
  unb64,
  validAddress,
  verifyEnvelope,
  xPrivate,
  type Envelope,
} from '../../src/server/interstem/proto';

// The Go relay writes these (relay/internal/proto/vectors_test.go); matching
// them byte for byte is the contract between the two implementations.
const V = JSON.parse(readFileSync(join(__dirname, '../../relay/testdata/vectors.json'), 'utf8'));
const hex = (s: string) => Buffer.from(s, 'hex');

describe('inter-Stem protocol vectors', () => {
  const stemSeed = hex(V.keys.stemSeed);
  const relayPub = unb64(V.keys.relayPub);
  const issuerKeys = async () => ({ issuer: 'https://relay.test', keys: { k1: relayPub } });

  it('derives the same public keys and fingerprint', () => {
    expect(b64(rawPublic(edPrivate(stemSeed)))).toBe(V.keys.stemPub);
    expect(b64(rawPublic(edPrivate(hex(V.keys.relaySeed))))).toBe(V.keys.relayPub);
    expect(b64(rawPublic(xPrivate(hex(V.keys.recipientEncPriv))))).toBe(V.keys.recipientEncPub);
    expect(fingerprint(unb64(V.keys.stemPub))).toBe(V.keys.stemFp);
  });

  it('builds the same key blob signature', () => {
    // The vector's blob is for the recipient enc key, signed by the stem key.
    const blob = makeKeyBlob(stemSeed, hex(V.keys.recipientEncPriv));
    expect(blob.enc).toBe(V.keyBlob.enc);
    expect(blob.encSig).toBe(V.keyBlob.encSig);
    expect(checkKeyBlob(V.keys.stemPub, JSON.stringify(blob))).not.toBeNull();
    expect(checkKeyBlob(V.keys.relayPub, JSON.stringify(blob))).toBeNull();
  });

  it('signs requests identically', () => {
    const r = V.request;
    const s = requestSigningString(r.method, r.path, r.time, r.body);
    expect(s).toBe(r.signingString);
    expect(edSign(stemSeed, s)).toBe(r.sig);
  });

  it('agrees on the certificate signing string', () => {
    expect(certSigningString(V.cert.cert)).toBe(V.cert.signingString);
  });

  it('seals and signs the envelope byte for byte', () => {
    const want: Envelope = V.envelope.envelope;
    const sealed = seal(
      unb64(V.keys.recipientEncPub),
      Buffer.from(V.envelope.plaintext),
      want.id,
      want.from,
      want.to,
      hex(V.keys.ephemeralPriv),
    );
    expect(b64(sealed)).toBe(want.sealed);
    const signed = signEnvelope({ v: 1, id: want.id, ts: want.ts, from: want.from, to: want.to, cert: want.cert, sealed: want.sealed }, stemSeed);
    expect(envelopeSigningString(want, sealed)).toBe(V.envelope.signingString);
    expect(signed.sig).toBe(want.sig);
    expect(signed.signer).toBe(want.signer);
  });

  it('verifies and opens the Go-made envelope', async () => {
    const env: Envelope = V.envelope.envelope;
    const res = await verifyEnvelope(env, env.ts + 60_000, issuerKeys);
    if ('error' in res) throw new Error(res.error);
    const plain = open(hex(V.keys.recipientEncPriv), res.sealed, env.id, env.from, env.to);
    expect(plain.toString()).toBe(V.envelope.plaintext);
    expect(() => open(hex(V.keys.recipientEncPriv), res.sealed, env.id, env.from, 'eve@acme.test')).toThrow();
  });

  it('rejects wrong issuers, stale envelopes and swapped signers', async () => {
    const env: Envelope = V.envelope.envelope;
    const other = async () => ({ issuer: 'https://other.test', keys: { k1: relayPub } });
    expect(await verifyEnvelope(env, env.ts, other)).toHaveProperty('error');
    expect(await verifyEnvelope(env, env.ts + 9 * 86_400_000, issuerKeys)).toHaveProperty('error');
    const forged = { ...env, signer: V.keys.relayPub };
    expect(await verifyEnvelope(forged, env.ts, issuerKeys)).toHaveProperty('error');
  });

  it('checks proof-of-work the same way', () => {
    expect(powOk(V.pow.address, V.pow.key, V.pow.nonce, V.pow.bits)).toBe(true);
  });

  it('validates addresses like the relay', () => {
    expect(validAddress('a@b.co')).toBe(true);
    for (const bad of ['A@b.co', 'a@b', '@b.co', 'a@@b.co', 'a b@c.co']) expect(validAddress(bad)).toBe(false);
  });
});

describe('relay URLs this server may contact', () => {
  it('takes only https hostnames, so a DNS record cannot aim requests at the local network', async () => {
    const { acceptableRelayUrl, parseRecord } = await import('../../src/server/interstem/relay-client');
    expect(acceptableRelayUrl('https://relay.acme.com')).toBe(true);
    for (const bad of [
      'http://relay.acme.com',
      'https://127.0.0.1',
      'https://169.254.169.254',
      'https://[::1]',
      'https://localhost',
      'https://user:pw@relay.acme.com',
      'file:///etc/passwd',
      'not a url'
    ]) {
      expect(acceptableRelayUrl(bad)).toBe(false);
    }
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(parseRecord(`v=stem1; relay=https://relay.acme.com; k=k1:${key}`)?.relay).toBe('https://relay.acme.com');
    expect(parseRecord(`v=stem1; relay=http://10.0.0.5:8080; k=k1:${key}`)).toBeNull();
    expect(parseRecord(`v=stem1; relay=https://relay.acme.com; k=k1:${key}`)?.closed).toBeUndefined();
    expect(parseRecord(`v=stem1; relay=https://relay.acme.com; k=k1:${key}; access=closed`)?.closed).toBe(true);
  });
});
