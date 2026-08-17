import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { host } from '../../server/host';
import { log } from '../../server/log';

// Whether THIS machine accepts commands from its Stem server. One boolean, one
// file, and the whole security design in the same sentence mcp-approvals.json
// carries: it lives on this disk and never goes on the wire, so the machine a
// command would run on is the machine holding the decision. A compromised
// server can send any frame it likes — the exec host reads this file before it
// spawns anything, and the file says no until the person at this computer
// says otherwise, here.
//
// Off by default, and there is no way to flip it remotely: `execHost:setEnabled`
// is a client-owned channel (src/desktop/local) that only a window on this
// machine can call. 0600 for the reason approvals are: a file another user can
// write is a file another user can consent with.

interface StoredExecHost {
  version: 1;
  enabled?: boolean;
}

export function execHostStorePath(): string {
  // Overridable for tests, exactly as STEM_MCP_APPROVALS_FILE is next door.
  return process.env.STEM_EXEC_HOST_FILE ?? join(host().stateRoot(), 'exec-host.json');
}

/** The switch, read fresh — absent or unreadable both mean the safe answer: off. */
export async function readExecHostEnabled(): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(execHostStorePath(), 'utf8')) as StoredExecHost;
    return parsed?.enabled === true;
  } catch {
    return false;
  }
}

export async function writeExecHostEnabled(enabled: boolean): Promise<void> {
  const path = execHostStorePath();
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const doc: StoredExecHost = { version: 1, enabled };
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  log('exec-host', enabled ? 'this computer now accepts commands' : 'this computer stopped accepting commands');
}
