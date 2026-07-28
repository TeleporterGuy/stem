import type { TurnAttachment } from '../../shared/types';

// Attaching a photo or a file from the phone.
//
// The desktop composer attaches by PATH: its renderer and the backend share a
// filesystem, so it hands over a filename and pi reads the bytes itself. The
// phone shares nothing with the Mac, so it sends the bytes — pi/attachments.ts
// accepts `dataBase64` for ANY file, not just pasted images, which is why this
// needs no upload endpoint and no second transport.
//
// The ceilings below are the reason this module exists at all. Attachments ride
// inside the /rpc JSON body, which the bridge caps at 25 MB and refuses on the
// DECLARED Content-Length — so an over-sized photo would fail as an opaque 413
// with the send already under way. Refusing it here, before the read, turns that
// into a sentence the user can act on.

/**
 * Per-file ceiling, on the file's own bytes. Base64 adds a third, so ten
 * megabytes is ~13.3 MB on the wire — a phone photo is 2-5 MB, a burst of them
 * still fits, and a video that never had a chance is rejected in the picker
 * rather than after a long upload.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Ceiling on one turn's attachments once encoded. The prompt, the JSON framing
 * and the base64 all share the bridge's 25 MB body cap, so the attachments get
 * 20 of it and the rest of the request keeps its headroom.
 */
export const MAX_TURN_ENCODED_BYTES = 20 * 1024 * 1024;

/** Bytes a base64 encoding of `raw` occupies: four characters per three bytes. */
export function encodedSize(raw: number): number {
  return Math.ceil(raw / 3) * 4;
}

/** Human size for a refusal message — the user thinks in MB, not in bytes. */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb >= 10 ? Math.round(mb) : Number(mb.toFixed(1))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** What a file picker hands back. A DOM File satisfies it; a test object also does. */
export interface PickedFile {
  name: string;
  size: number;
  type: string;
}

/**
 * Why this file cannot be attached, in words for the composer; null when it can.
 * `already` is what the composer is holding — the turn budget is per message, so
 * three photos that each pass on their own can still be too much together.
 */
export function attachmentProblem(
  file: PickedFile,
  already: readonly TurnAttachment[]
): string | null {
  const name = file.name || 'That file';
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `${name} is ${formatBytes(file.size)} — the phone can send files up to ${formatBytes(
      MAX_ATTACHMENT_BYTES
    )}. Send it from your Mac instead.`;
  }
  const pending = already.reduce((sum, att) => sum + (att.dataBase64?.length ?? 0), 0);
  if (pending + encodedSize(file.size) > MAX_TURN_ENCODED_BYTES) {
    return `Adding ${name} would make this message too big to send. Send what you have attached first.`;
  }
  return null;
}

/** Read a picked file as a data URL. Injectable: FileReader is a browser thing. */
export type DataUrlReader = (file: PickedFile) => Promise<string>;

const readAsDataUrl: DataUrlReader = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file as unknown as Blob);
  });

/** Base64 a picked file into a sendable attachment. Call attachmentProblem first. */
export async function fileToAttachment(
  file: PickedFile,
  read: DataUrlReader = readAsDataUrl
): Promise<TurnAttachment> {
  const dataUrl = await read(file);
  const comma = dataUrl.indexOf(',');
  const dataBase64 = comma === -1 ? '' : dataUrl.slice(comma + 1);
  if (!dataBase64) {
    throw new Error(`${file.name || 'That file'} came back empty — try picking it again.`);
  }
  // Safari hands back a File with an empty `type` often enough to matter (iCloud
  // downloads, some HEIC flows); the data URL still carries whatever type the
  // browser decided on, which is closer to the truth than nothing.
  const declared = /^data:([^;,]+)/.exec(dataUrl)?.[1];
  return {
    name: file.name || 'attachment',
    mime: file.type || declared || 'application/octet-stream',
    dataBase64
  };
}
