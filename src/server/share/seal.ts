// Share blob encryption (relay/PROTOCOL.md, "Share links"). The key never
// leaves this Stem except in the link's fragment, which browsers don't send.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

const VERSION = 1;
const AAD = Buffer.from('stem-share-v1');

export function sealShare(plain: string, key: Buffer = randomBytes(32)): { blob: Buffer; key: Buffer } {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(gzipSync(Buffer.from(plain, 'utf8'))), c.final(), c.getAuthTag()]);
  return { blob: Buffer.concat([Buffer.from([VERSION]), nonce, ct]), key };
}

/** The inverse, for tests and for checking an upload round-trips. */
export function openShare(blob: Uint8Array, key: Buffer): string {
  const b = Buffer.from(blob);
  if (b[0] !== VERSION || b.length < 1 + 12 + 16) throw new Error('not a share blob');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(1, 13));
  d.setAAD(AAD);
  d.setAuthTag(b.subarray(b.length - 16));
  return gunzipSync(Buffer.concat([d.update(b.subarray(13, b.length - 16)), d.final()])).toString('utf8');
}

export const keyFragment = (key: Buffer): string => key.toString('base64url');
