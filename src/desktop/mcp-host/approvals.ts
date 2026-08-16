import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { host } from '../../server/host';
import { log } from '../../server/log';

// What THIS machine has agreed to run: server name → the fingerprint of the spec
// it was approved under (docs/mcp-device-pinning.md, ④).
//
// It is a file on this disk and never goes on the wire, which is the whole
// design. The spec lives centrally in mcp.json, so a compromised server can put
// any command it likes in there — and get nowhere, because the sentence that
// decides whether that command runs is written here, on the computer it would
// run on, by the person sitting at it.
//
// Approval is per FINGERPRINT and not per name, so editing an approved entry's
// args or env is a new approval rather than a silent widening. The fingerprint
// itself comes from src/shared/mcp-fingerprint.ts, which both ends import; there
// is no second hashing rule here on purpose (see that file's header for what a
// divergent one would cost).
//
// It sits beside client.json, in the same state dir and with the same 0600, for
// the reason client-store.ts exists at all: this is a fact about the client, and
// a client that is not the server's machine has nowhere else to put one. Unlike
// client.json there is nothing secret in it — a fingerprint is a hash — so it is
// stored in the clear; 0600 is because a file another user can WRITE is a file
// another user can pre-approve a spec in.

/** The stored document. Versioned like its neighbours, for the day it grows. */
interface StoredApprovals {
  version: 1;
  /** server name → approved spec fingerprint. */
  approved?: Record<string, string>;
}

/** How approvals are read and written; injected so the host can be tested. */
export interface ApprovalStore {
  /** Every approval on this machine, as `name → fingerprint`. */
  read(): Promise<Record<string, string>>;
  /** Record that `name` may run the spec with this fingerprint. */
  approve(name: string, fingerprint: string): Promise<void>;
  /** Forget any approval for `name`. */
  reject(name: string): Promise<void>;
}

export function mcpApprovalsPath(): string {
  // STEM_MCP_APPROVALS_FILE lets a test point at a throwaway file, exactly as
  // STEM_CLIENT_FILE does for client.json next to it.
  return process.env.STEM_MCP_APPROVALS_FILE ?? join(host().stateRoot(), 'mcp-approvals.json');
}

/** The document on disk, or an empty one when there is nothing readable yet. */
async function readApprovalsFile(): Promise<StoredApprovals> {
  try {
    const parsed = JSON.parse(await readFile(mcpApprovalsPath(), 'utf8')) as StoredApprovals;
    if (parsed && typeof parsed === 'object' && parsed.approved && typeof parsed.approved === 'object') {
      // Only string values survive the read. A malformed entry that got as far
      // as this file would otherwise be compared against a fingerprint with
      // `===`, and the one comparison in this feature that must never say yes
      // by accident is that one.
      const approved = Object.fromEntries(
        Object.entries(parsed.approved).filter(([, v]) => typeof v === 'string' && v.length > 0)
      );
      return { version: 1, approved };
    }
  } catch {
    // Absent (nothing approved yet), or unreadable. Both mean the same thing and
    // it is the safe thing: nothing on this machine is approved, so nothing
    // starts and the panel asks. Losing this file costs a few clicks, and
    // guessing at half of it could cost a spawned process nobody agreed to.
  }
  return { version: 1, approved: {} };
}

/**
 * The real store. Read-modify-writes are serialized through one chain, like
 * client-store.ts's: approving two servers in the same tick is an ordinary thing
 * for somebody to do, and whole-file rewrites are exactly the shape that loses
 * one of them.
 */
export function fileApprovalStore(): ApprovalStore {
  let chain: Promise<unknown> = Promise.resolve();

  function update(mutate: (approved: Record<string, string>) => void): Promise<void> {
    const task = async (): Promise<void> => {
      const doc = await readApprovalsFile();
      const approved = doc.approved ?? {};
      mutate(approved);
      const path = mcpApprovalsPath();
      await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
      await writeFile(path, `${JSON.stringify({ version: 1, approved }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
      // An existing file keeps the mode it was created with, so re-assert it.
      await chmod(path, 0o600).catch(() => undefined);
    };
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  return {
    read: async () => (await readApprovalsFile()).approved ?? {},
    approve: (name, fingerprint) =>
      update((approved) => {
        approved[name] = fingerprint;
        log('mcp-host', 'approved an MCP server on this machine', { name });
      }),
    reject: (name) =>
      update((approved) => {
        // A rejection forgets the approval; it is not remembered as a "no". The
        // spec stays pinned to this machine and the panel keeps offering it,
        // which is what ⑥ asks for — an unapproved spec waits quietly rather
        // than being answered once and disappearing.
        delete approved[name];
        log('mcp-host', 'withdrew approval for an MCP server', { name });
      })
  };
}

/** An in-memory store, for tests and for anything that must not touch a disk. */
export function memoryApprovalStore(initial: Record<string, string> = {}): ApprovalStore {
  const approved = { ...initial };
  return {
    read: () => Promise.resolve({ ...approved }),
    approve: (name, fingerprint) => {
      approved[name] = fingerprint;
      return Promise.resolve();
    },
    reject: (name) => {
      delete approved[name];
      return Promise.resolve();
    }
  };
}
