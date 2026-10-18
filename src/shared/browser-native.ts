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
// the first frames on the socket are its handshake with the desktop (each side
// proves it holds this profile's token, see browser-host/handshake.ts), and it copies finished
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

/**
 * The Windows browsers Stem knows, by where their installers put the browser:
 * Program Files for a machine-wide install, the user's AppData\Local for a
 * per-user one (Chrome without admin rights, Chromium). Anything else a native
 * host claims is never started.
 */
const WINDOWS_PROGRAMS = String.raw`^[a-z]:\\Program Files( \(x86\))?\\`;
// The user segment may not be `.`/`..` or hold a `/` (Windows takes either
// slash), or `C:\Users\..\AppData\…` would name a folder under C:\ itself,
// which any user can create.
const WINDOWS_LOCAL = String.raw`^[a-z]:\\Users\\(?!\.\.?\\)[^\\/]+\\AppData\\Local\\`;
const windowsExe = (tail: string) => new RegExp(`(${WINDOWS_PROGRAMS}|${WINDOWS_LOCAL})${tail}$`, 'i');
const WINDOWS_BROWSERS: { name: string; exe: RegExp }[] = [
  { name: 'Google Chrome', exe: windowsExe(String.raw`Google\\Chrome( Beta| Dev| SxS)?\\Application\\chrome\.exe`) },
  { name: 'Microsoft Edge', exe: windowsExe(String.raw`Microsoft\\Edge( Beta| Dev| SxS)?\\Application\\msedge\.exe`) },
  { name: 'Brave', exe: windowsExe(String.raw`BraveSoftware\\Brave-Browser( Beta| Nightly)?\\Application\\brave\.exe`) },
  { name: 'Chromium', exe: windowsExe(String.raw`Chromium\\Application\\chrome\.exe`) }
];

/** A known Windows browser's name from its executable, or null when Stem does not know it. */
export function windowsBrowserName(exe: string): string | null {
  return WINDOWS_BROWSERS.find((b) => b.exe.test(exe))?.name ?? null;
}

/**
 * May Stem start this browser here? The id arrives from a native host's word,
 * so off a Mac (where `open -a` only opens apps) it must be a browser Stem
 * knows. A Mac opens bundles by name and needs no list.
 */
export function launchableBrowser(app: string, platform: NodeJS.Platform): boolean {
  if (platform === 'linux') return launchableOnLinux(app);
  if (platform === 'win32') return windowsBrowserName(app) !== null;
  return true;
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
  /** What Stem calls this browser profile ("Work", "Arc 2"), for the popup. */
  | { type: 'profile'; name: string }
  /** From the native host only: whether it currently reaches the Stem app. */
  | { type: 'host'; connected: boolean };

/** extension → desktop */
export type FromExtension =
  | {
      type: 'hello';
      protocol: number;
      extensionId: string;
      extensionVersion: string;
      userAgent: string;
      /**
       * A random id the extension keeps in its own storage, so one per browser
       * profile: how two profiles of one app (Arc's work and personal) are
       * told apart. Absent from extensions older than 0.7.0.
       */
      profileId?: string;
      /** The sites most open in the profile ("mail.google.com, github.com"), to tell unnamed profiles apart. */
      hint?: string;
    }
  | { type: 'result'; id: string; result: ExtensionResult }
  /** The user pressed Stop for a run: the marker's button, the popup, or cancelling the debugging bar. */
  | { type: 'stopped'; threadId: string };

/** native host → desktop, first frame on the socket. */
/** The native host's first frame. */
export interface HostHello {
  type: 'host-hello';
  /** The desktop answers it with a proof that it holds the token. */
  nonce: string;
  /** The browser's app bundle, from the host's parent process ("/Applications/Arc.app"). */
  appPath: string;
  /** Display name ("Arc"). */
  appName: string;
}

/** The desktop's answer to a host-hello: its proof, and a nonce for the host's. */
export interface ServerHello {
  type: 'server-hello';
  nonce: string;
  proof: string;
}

/** The native host's proof, after which frames are relayed. */
export interface HostProof {
  type: 'host-proof';
  proof: string;
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

/**
 * A list of browser profile ids (BrowserInfo.id); undefined when there is no
 * list — every profile. An empty list stays empty: it allows none.
 */
export function coerceBrowserProfiles(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = raw
    .filter((v): v is string => typeof v === 'string' && !!v.trim() && v.length <= 600)
    .map((v) => v.trim());
  return [...new Set(ids)].slice(0, 32);
}
