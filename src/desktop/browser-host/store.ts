import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { host } from '../../server/host';
import { log } from '../../server/log';

// Whether THIS Mac lets its Stem server drive its browser, and which browser.
// Same design sentence as computer-host/store.ts: it lives on this disk and
// never goes on the wire — the machine whose browser would be driven holds the
// decision. Off by default; only a window on this machine can flip it.

export interface KnownBrowser {
  /**
   * The app bundle the native host was launched from, then "#" and the
   * profile id the extension keeps ("/Applications/Arc.app#3f2a…"). Entries
   * written before profiles were told apart are the bare bundle path; the
   * first profile of that app to connect takes the entry over.
   */
  id: string;
  /** The app's display name ("Arc"). */
  name: string;
  /** What the user called this profile ("Work"). */
  label?: string;
  /** A few sites open in it when it last connected. */
  hint?: string;
}

/** The app bundle a known browser is launched from. */
export function appOf(id: string): string {
  const at = id.indexOf('#');
  return at >= 0 ? id.slice(0, at) : id;
}

export interface BrowserHostSettings {
  enabled: boolean;
  /** The browser Stem uses here; absent = the first one that connects. */
  chosen?: string;
  /** Every browser whose extension has connected here, so a closed one can be launched. */
  known: KnownBrowser[];
}

interface Stored extends Partial<BrowserHostSettings> {
  version: 1;
}

export function browserHostStorePath(): string {
  return process.env.STEM_BROWSER_HOST_FILE ?? join(host().stateRoot(), 'browser-host.json');
}

/** Read fresh — absent or unreadable both mean the safe answer: off, nothing known. */
export async function readBrowserHostSettings(): Promise<BrowserHostSettings> {
  try {
    const parsed = JSON.parse(await readFile(browserHostStorePath(), 'utf8')) as Stored;
    const known = Array.isArray(parsed?.known)
      ? parsed.known.filter(
          (b): b is KnownBrowser => !!b && typeof b.id === 'string' && !!b.id && typeof b.name === 'string'
        ).map((b) => ({
          id: b.id,
          name: b.name,
          ...(typeof b.label === 'string' && b.label.trim() ? { label: b.label.trim() } : {}),
          ...(typeof b.hint === 'string' && b.hint ? { hint: b.hint } : {})
        }))
      : [];
    return {
      enabled: parsed?.enabled === true,
      ...(typeof parsed?.chosen === 'string' && parsed.chosen ? { chosen: parsed.chosen } : {}),
      known
    };
  } catch {
    return { enabled: false, known: [] };
  }
}

/** Serialised so a connect and a click on the switch cannot interleave their read-modify-writes. */
let tail: Promise<unknown> = Promise.resolve();

export function updateBrowserHostSettings(
  patch: (cur: BrowserHostSettings) => BrowserHostSettings
): Promise<BrowserHostSettings> {
  const work = async (): Promise<BrowserHostSettings> => {
    const next = patch(await readBrowserHostSettings());
    const path = browserHostStorePath();
    await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
    const doc: Stored = { version: 1, ...next };
    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
    return next;
  };
  const next = tail.then(work, work);
  // quiet: the rejection reaches the caller through `next`; this copy only keeps
  // one failed write from poisoning the updates queued behind it.
  tail = next.catch(() => undefined);
  return next;
}

export async function writeBrowserHostEnabled(enabled: boolean): Promise<BrowserHostSettings> {
  const next = await updateBrowserHostSettings((cur) => ({ ...cur, enabled }));
  log(
    'browser-host',
    enabled ? 'this computer now lets Stem drive its browser' : 'this computer stopped letting Stem drive its browser'
  );
  return next;
}
