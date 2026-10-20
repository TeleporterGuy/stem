import { realpath } from 'node:fs/promises';
import { posix, resolve, win32 } from 'node:path';

// Repo locks: two delivery turns must never run a coding harness inside the
// same working tree at once — concurrent agents in one repo corrupt each
// other's checkouts (indexes, worktrees, half-written files). The router
// acquires a claim per delivery whose persona pins a harness cwd, and a claim
// CONFLICTS with another when both resolve to the same device and either path
// contains the other — /repo vs /repo/packages/x is the same tree, in both
// directions. Deliveries with no cwd (thread scratch dirs are unique) never
// lock.
//
// Waiting is FIFO per conflict: a new claim queues behind not only the held
// locks it conflicts with but also earlier WAITERS, so a broad claim (/repo)
// can't be starved by a stream of narrow ones (/repo/x, /repo/y) arriving
// after it.
//
// The lock is advisory-at-the-edges by design: it serializes the router's own
// deliveries. Turns the user runs by hand in a chat, or a second Stem
// instance, are outside its reach.

interface Claim {
  /** Device pin, '' = the machine the server itself runs on. */
  device: string;
  /** The pinned cwd, resolved (see resolveClaimPath). */
  path: string;
}

interface Waiter {
  claim: Claim;
  grant: (release: () => void) => void;
}

/** A drive-letter or UNC path: Windows rules, whichever OS this server runs on. */
const isWindowsPath = (p: string) => /^[a-zA-Z]:[\\/]|^\\\\/.test(p);

/** Windows paths compare with either slash and in any case, as NTFS treats them. */
const comparable = (p: string) => (isWindowsPath(p) ? p.replace(/\\/g, '/').toLowerCase() : p);

/** True when `outer` is `inner` or a path-segment ancestor of it. */
function contains(outer: string, inner: string): boolean {
  const o = comparable(outer);
  const i = comparable(inner);
  if (o === i) return true;
  const prefix = o.endsWith('/') ? o : `${o}/`;
  return i.startsWith(prefix);
}

function conflicts(a: Claim, b: Claim): boolean {
  return a.device === b.device && (contains(a.path, b.path) || contains(b.path, a.path));
}

/**
 * Local paths resolve through realpath so a symlinked checkout can't dodge the
 * lock; a pinned device's paths live on another machine, where only a lexical
 * normalization is honest (and a realpath here would answer for the wrong
 * filesystem anyway).
 */
async function resolveClaimPath(cwd: string, remote: boolean): Promise<string> {
  const lexical = remote ? (isWindowsPath(cwd) ? win32 : posix).normalize(cwd) : resolve(cwd);
  if (remote) return lexical;
  // quiet: a cwd that doesn't exist yet (the harness may create it) still
  // locks under its lexical name — the fallback IS the handling.
  return realpath(lexical).catch(() => lexical);
}

export class RepoLocks {
  private held: Claim[] = [];
  private waiters: Waiter[] = [];

  /**
   * Claim the harness's working tree; resolves with a release function once no
   * conflicting delivery is running. A harness-less persona (or a blank cwd)
   * claims nothing and resolves immediately.
   */
  async acquire(harness?: { cwd?: string; device?: string }): Promise<() => void> {
    const cwd = harness?.cwd?.trim();
    if (!cwd) return () => undefined;
    const device = harness?.device?.trim() ?? '';
    const claim: Claim = { device, path: await resolveClaimPath(cwd, !!device) };
    const blocked =
      this.held.some((h) => conflicts(h, claim)) ||
      this.waiters.some((w) => conflicts(w.claim, claim));
    if (!blocked) return this.take(claim);
    return new Promise((grant) => this.waiters.push({ claim, grant }));
  }

  private take(claim: Claim): () => void {
    this.held.push(claim);
    let released = false;
    return () => {
      // Idempotent: deliver()'s finally is the one caller, but a double
      // release must never free someone else's claim.
      if (released) return;
      released = true;
      this.held.splice(this.held.indexOf(claim), 1);
      this.drain();
    };
  }

  /** Grant waiters in arrival order; an ungrantable one still blocks later conflicting ones. */
  private drain(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const w = this.waiters[i];
      const blocked =
        this.held.some((h) => conflicts(h, w.claim)) ||
        this.waiters.slice(0, i).some((e) => conflicts(e.claim, w.claim));
      if (blocked) {
        i += 1;
        continue;
      }
      this.waiters.splice(i, 1);
      w.grant(this.take(w.claim));
    }
  }
}

/** The app-wide registry the mail router locks through. */
export const repoLocks = new RepoLocks();
