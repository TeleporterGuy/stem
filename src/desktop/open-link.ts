import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';

// How a link clicked in the renderer leaves the app. Web and mail links go to
// the browser / mail client. file:// links (an agent pointing at a CSV it just
// wrote to ~/Downloads) open with the file's default app — except anything that
// would run code when opened, which is only revealed in Finder/Explorer so a
// model-written link can never launch a program with one click.
export type LinkAction =
  | { kind: 'external'; url: string }
  | { kind: 'open'; path: string }
  | { kind: 'reveal'; path: string }
  | { kind: 'ignore' };

const EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

const RUNNABLE_EXTENSIONS = new Set([
  '.app', '.command', '.tool', '.terminal', '.sh', '.bash', '.zsh', '.csh', '.fish',
  '.pkg', '.mpkg', '.dmg', '.scpt', '.scptd', '.applescript', '.workflow', '.action',
  '.jar', '.webloc', '.inetloc', '.fileloc', '.url', '.desktop', '.appimage', '.deb', '.rpm', '.run',
  '.exe', '.msi', '.bat', '.cmd', '.com', '.ps1', '.vbs', '.js', '.jse', '.wsf', '.lnk', '.scr',
  '.py', '.pl', '.rb', '.php',
]);

export function classifyLink(url: string): LinkAction {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'ignore' };
  }
  if (EXTERNAL_URL_PROTOCOLS.has(parsed.protocol)) return { kind: 'external', url: parsed.toString() };
  if (parsed.protocol !== 'file:') return { kind: 'ignore' };
  let path: string;
  try {
    path = fileURLToPath(parsed);
  } catch {
    return { kind: 'ignore' };
  }
  // A trailing slash (or a bundle like Foo.app/) is a folder: strip it before
  // reading the extension so Foo.app/ is still recognized as runnable.
  const ext = extname(path.replace(/[/\\]+$/, '')).toLowerCase();
  return RUNNABLE_EXTENSIONS.has(ext) ? { kind: 'reveal', path } : { kind: 'open', path };
}
