// The browser half of relay/PROTOCOL.md "Share links" (server half:
// src/server/share/seal.ts). WebCrypto + DecompressionStream, nothing else.
import { SHARE_SNAPSHOT_VERSION, type ShareSnapshot } from '../shared/share';

export class NewerShareError extends Error {}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gunzip(data: Uint8Array): Promise<string> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export async function openShare(blob: Uint8Array, keyB64Url: string): Promise<ShareSnapshot> {
  const raw = fromBase64Url(keyB64Url);
  if (raw.length !== 32) throw new Error('bad key');
  if (blob[0] !== 1 || blob.length < 1 + 12 + 16) throw new NewerShareError('unknown blob version');
  const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: blob.subarray(1, 13) as BufferSource, additionalData: new TextEncoder().encode('stem-share-v1') },
    key,
    blob.subarray(13) as BufferSource
  );
  const snap = JSON.parse(await gunzip(new Uint8Array(plain))) as ShareSnapshot;
  if (typeof snap?.v !== 'number' || snap.v > SHARE_SNAPSHOT_VERSION) throw new NewerShareError('newer snapshot');
  if (!Array.isArray(snap.messages)) throw new Error('not a snapshot');
  return snap;
}
