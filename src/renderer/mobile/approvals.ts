import type {
  ExecApprovalRequest,
  ExecDecision,
  InstructionsProposal,
  McpAdminProposal,
  StemApi
} from '../../shared/types';
import { enqueueApproval, removeApproval } from '../manage/approvalQueue';

// The three approvals a phone can be asked for, in one store.
//
// A turn started from the phone can block on any of them, and at that moment the
// phone is the only surface in front of the user: without this, a turn that needs
// a tier-3 command simply hangs. Main already pushes all six events — each
// request and its `*Resolved` twin — to the bridge, and the three resolve
// channels are allowlisted, so what is left is the bookkeeping.
//
// That bookkeeping is a store rather than component state (which is where the
// desktop's cards keep theirs) for two reasons: the phone shows ONE card at a
// time across all three kinds, so the queues have to be read together; and the
// retraction rule — an answer given at the desk must take the card off the phone
// — is the part most worth testing, and a store can be driven without a DOM.
//
// enqueueApproval/removeApproval are the desktop's own helpers, unchanged:
// arrival order is preserved for parallel tool calls, and removal is idempotent
// because a card is routinely retracted twice (by its `*Resolved` event and by
// the decide() that caused it).

export interface ApprovalSnapshot {
  exec: ExecApprovalRequest[];
  mcp: McpAdminProposal[];
  instructions: InstructionsProposal[];
}

/** The single card on screen. A phone asks one question at a time. */
export type PendingApproval =
  | { kind: 'exec'; request: ExecApprovalRequest }
  | { kind: 'mcp'; proposal: McpAdminProposal }
  | { kind: 'instructions'; proposal: InstructionsProposal };

const EMPTY: ApprovalSnapshot = { exec: [], mcp: [], instructions: [] };

/**
 * Which card to show. Exec first on purpose: it is the one holding a running
 * turn open, so answering it is what unblocks the conversation on screen.
 */
export function headApproval(snapshot: ApprovalSnapshot): PendingApproval | null {
  if (snapshot.exec.length > 0) return { kind: 'exec', request: snapshot.exec[0] };
  if (snapshot.mcp.length > 0) return { kind: 'mcp', proposal: snapshot.mcp[0] };
  if (snapshot.instructions.length > 0) return { kind: 'instructions', proposal: snapshot.instructions[0] };
  return null;
}

/** The bridge members this needs; the tests pass a fake instead of a whole StemApi. */
export type ApprovalApi = Pick<
  StemApi,
  | 'onExecApproval'
  | 'onExecApprovalResolved'
  | 'onMcpAdminApproval'
  | 'onMcpAdminApprovalResolved'
  | 'onInstructionsApproval'
  | 'onInstructionsApprovalResolved'
  | 'respondExecApproval'
  | 'respondMcpAdminApproval'
  | 'respondInstructionsApproval'
>;

export interface ApprovalStore {
  /** Stable snapshot identity between changes, for useSyncExternalStore. */
  get(): ApprovalSnapshot;
  subscribe(listener: () => void): () => void;
  /** Start listening; the returned function stops again (React effect shape). */
  attach(): () => void;
  resolveExec(id: string, decision: ExecDecision): Promise<void>;
  resolveMcp(id: number | string, accept: boolean): Promise<void>;
  resolveInstructions(id: number | string, accept: boolean, text: string): Promise<void>;
}

export function createApprovalStore(api: ApprovalApi = window.stem): ApprovalStore {
  let snapshot: ApprovalSnapshot = EMPTY;
  const listeners = new Set<() => void>();

  function commit(next: ApprovalSnapshot): void {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }
  // enqueue/remove return the same array when nothing changed, so an event for a
  // card already queued (or already gone) costs no render.
  const setExec = (queue: ExecApprovalRequest[]): void => {
    if (queue !== snapshot.exec) commit({ ...snapshot, exec: queue });
  };
  const setMcp = (queue: McpAdminProposal[]): void => {
    if (queue !== snapshot.mcp) commit({ ...snapshot, mcp: queue });
  };
  const setInstructions = (queue: InstructionsProposal[]): void => {
    if (queue !== snapshot.instructions) commit({ ...snapshot, instructions: queue });
  };

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attach() {
      const offs = [
        api.onExecApproval((request) => setExec(enqueueApproval(snapshot.exec, request))),
        api.onExecApprovalResolved(({ id }) => setExec(removeApproval(snapshot.exec, id))),
        api.onMcpAdminApproval((proposal) => setMcp(enqueueApproval(snapshot.mcp, proposal))),
        api.onMcpAdminApprovalResolved(({ id }) => setMcp(removeApproval(snapshot.mcp, id))),
        api.onInstructionsApproval((proposal) =>
          setInstructions(enqueueApproval(snapshot.instructions, proposal))
        ),
        api.onInstructionsApprovalResolved(({ id }) =>
          setInstructions(removeApproval(snapshot.instructions, id))
        )
      ];
      return () => {
        for (const off of offs) off();
      };
    },
    async resolveExec(id, decision) {
      await api.respondExecApproval(id, decision);
      // The resolved broadcast takes this card off every surface, but the phone
      // must not wait for its own stream to come back around: drop it here too.
      setExec(removeApproval(snapshot.exec, id));
    },
    async resolveMcp(id, accept) {
      await api.respondMcpAdminApproval(id, accept);
      setMcp(removeApproval(snapshot.mcp, id));
    },
    async resolveInstructions(id, accept, text) {
      // Always the main surface: Quick Chat is a desktop overlay the phone cannot
      // see, so an instructions change made here is one that applies everywhere.
      await api.respondInstructionsApproval(id, accept, 'main', text);
      setInstructions(removeApproval(snapshot.instructions, id));
    }
  };
}

/**
 * The text `action` resolves to for the main surface. Mirrors the desktop card's
 * own resolution (manage/InstructionsApprovalCard.tsx) — append is computed
 * against the current value here rather than in the backend, because the card
 * sends the WHOLE surface string.
 */
export function resolvedInstructionsText(
  action: InstructionsProposal['action'],
  incomingText: string,
  current: string
): string {
  if (action === 'clear') return '';
  if (action === 'replace') return incomingText;
  return current ? `${current}\n${incomingText}` : incomingText;
}
