import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { host } from '../../server/host';
import { log } from '../../server/log';

// Whether THIS Mac lets its Stem server drive the screen. One boolean, one
// file, and the same design sentence exec-host/store.ts carries: it lives on
// this disk and never goes on the wire, so the machine whose screen would be
// driven is the machine holding the decision. Off by default; only a window on
// this machine can flip it (`computerHost:setEnabled` is client-owned).

interface StoredComputerHost {
  version: 1;
  enabled?: boolean;
}

export function computerHostStorePath(): string {
  return process.env.STEM_COMPUTER_HOST_FILE ?? join(host().stateRoot(), 'computer-host.json');
}

/** The switch, read fresh — absent or unreadable both mean the safe answer: off. */
export async function readComputerHostEnabled(): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(computerHostStorePath(), 'utf8')) as StoredComputerHost;
    return parsed?.enabled === true;
  } catch {
    return false;
  }
}

export async function writeComputerHostEnabled(enabled: boolean): Promise<void> {
  const path = computerHostStorePath();
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const doc: StoredComputerHost = { version: 1, enabled };
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await chmod(path, 0o600).catch(() => undefined);
  log(
    'computer-host',
    enabled ? 'this Mac now lets Stem drive its screen' : 'this Mac stopped letting Stem drive its screen'
  );
}
