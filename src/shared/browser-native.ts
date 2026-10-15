import type { BrowserAction } from './types';

// The wire between the Stem desktop app and the Stem browser extension.
//
//   desktop (src/desktop/browser-host) ⇄ unix socket ⇄ native host ⇄ native messaging ⇄ extension
//
// Both legs carry the same JSON messages, each framed as a 4-byte little-endian
// length followed by UTF-8 JSON — Chrome's native-messaging framing, reused on
// the socket so the native host can relay frames without understanding them.
// Chrome caps a message from the host to the extension at 1 MB, so nothing the
// desktop sends carries file bytes: uploads travel as paths on this Mac.
//
// The native host (browser-host/native-host-main.ts) adds exactly two things:
// the first frame on the socket is its own `host-hello` (with the token that
// proves it was installed by this Stem profile), and it copies finished
// downloads out of the user's Downloads folder into Stem's spool before
// relaying a result — it runs as the browser's child, so macOS attributes that
// read to the browser rather than asking the user to let Stem into Downloads.
//
// The extension source (src/browser-extension/) is plain JS and cannot import
// this file; keep the two in step by hand. Bump BROWSER_PROTOCOL when a change
// is not backward compatible.

export const BROWSER_PROTOCOL = 1;

/** Native-messaging host name, as registered in each browser's NativeMessagingHosts folder. */
export const BROWSER_NATIVE_HOST = 'com.stem.browser';

/**
 * The Linux browsers Stem knows, by where their packages install the browser
 * binary. A known browser is the only thing Stem will start or hand a URL to:
 * the path arrives from the native host, and a peer that claimed some other
 * program must not get Stem to run it. System folders only, so a same-named
 * file in the user's home never qualifies. Snap and Flatpak are not here (their
 * sandbox will not start Stem's host anyway).
 */
const LINUX_BROWSERS: { name: string; exe: RegExp }[] = [
  { name: 'Google Chrome', exe: /^\/opt\/google\/chrome(-beta|-unstable)?\/chrome$/ },
  { name: 'Brave', exe: /^\/opt\/brave[^/]*(\/brave[^/]*)?\/brave$/ },
  { name: 'Microsoft Edge', exe: /^\/opt\/microsoft\/msedge(-beta|-dev)?\/msedge$/ },
  { name: 'Chromium', exe: /^\/usr\/lib(64)?\/chromium(-browser)?\/chrom(e|ium)(-browser)?$/ }
];

/** The commands Set up may hand the extensions page to on Linux (found on PATH). */
export const LINUX_BROWSER_COMMANDS = [
  'google-chrome',
  'google-chrome-stable',
  'brave-browser',
  'brave',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'microsoft-edge-stable'
];

/** A known Linux browser's name from its executable, or null when Stem does not know it. */
export function linuxBrowserName(exe: string): string | null {
  return LINUX_BROWSERS.find((b) => b.exe.test(exe))?.name ?? null;
}

/** Is this something Stem may start on Linux: a known browser binary, or one of the known commands? */
export function launchableOnLinux(app: string): boolean {
  return linuxBrowserName(app) !== null || LINUX_BROWSER_COMMANDS.includes(app);
}

/** An upload as the extension receives it: files already on this Mac. */
export type ExtensionAction =
  | Exclude<BrowserAction, { kind: 'upload' }>
  | { kind: 'upload'; tab?: number; ref: string; paths: string[] };

/** A download the extension saw finish, by its path on this Mac. */
export interface ExtensionDownload {
  path: string;
  name: string;
  size: number;
  mime?: string;
}

export type ExtensionResult =
  | {
      ok: true;
      text?: string;
      screenshot?: { jpegBase64: string; width: number; height: number };
      tab?: number;
      downloads?: ExtensionDownload[];
      /** `tabs` only: every loaded tab's URL, so the desktop can add Arc's unloaded sidebar tabs. Never forwarded. */
      urls?: string[];
    }
  | { ok: false; error: string; stopped?: true };

/** desktop → extension */
export type ToExtension =
  | { type: 'request'; id: string; threadId: string; action: ExtensionAction }
  /** The run is over: detach from its tabs, take the markers down, forget its bookkeeping. */
  | { type: 'end'; threadId: string }
  /** The extension's files on disk changed (a Stem update): reload to pick them up. */
  | { type: 'reload' }
  /** From the native host only: whether it currently reaches the Stem app. */
  | { type: 'host'; connected: boolean };

/** extension → desktop */
export type FromExtension =
  | { type: 'hello'; protocol: number; extensionId: string; extensionVersion: string; userAgent: string }
  | { type: 'result'; id: string; result: ExtensionResult }
  /** The user pressed Stop for a run: the marker's button, the popup, or cancelling the debugging bar. */
  | { type: 'stopped'; threadId: string };

/** native host → desktop, first frame on the socket. */
export interface HostHello {
  type: 'host-hello';
  token: string;
  /** The browser's app bundle, from the host's parent process ("/Applications/Arc.app"). */
  appPath: string;
  /** Display name ("Arc"). */
  appName: string;
}

/** Largest frame either side accepts (screenshots ride extension → desktop). */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** Chrome's own cap on host → extension messages. */
export const MAX_TO_EXTENSION_BYTES = 1024 * 1024;

/** One length-prefixed frame. */
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * Incremental decoder: feed it chunks, get whole frames back (as raw bodies, so
 * a relay can forward without re-serialising). Throws on a frame over the cap —
 * the caller drops that connection.
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly max = MAX_FRAME_BYTES) {}

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > this.max) throw new Error(`frame of ${len} bytes is over the ${this.max}-byte cap`);
      if (this.buf.length < 4 + len) break;
      out.push(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

/** The extension's id, derived from the `key` in src/browser-extension/manifest.json (tests/unit/browser-extension-id.test.ts checks it). */
export const BROWSER_EXTENSION_ID = 'bbadcpfklblgjocjcaemcmojkikjnoao';
