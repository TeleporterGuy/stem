// Everything waiting on the user's answer, in one queue.
//
// Four kinds of approval exist (a shell command, an MCP server change, a
// custom-instructions edit, a skill to save) and each arrives on its own push
// channel with its own payload. The desktop keeps four queues because it renders
// four separate cards in four places in the Manage panel; a phone has one
// surface and one sheet, so it keeps one list and tags each entry with which
// kind it is.
//
// The semantics are src/renderer/manage/approvalQueue.ts's, and they are the two
// that matter for something a backend tool call is blocked on:
//
//   append once, in arrival order — pi runs a turn's tool calls in parallel, so
//   two commands can be waiting at the same time and the order they were asked
//   in is the only order that means anything to the person answering.
//
//   removal is idempotent — a resolve arrives for every approval that ends,
//   including the ones this phone answered itself and the ones that expired or
//   were answered at the desk. All three are the same event to this list.
//
// Keyed by kind AND id: the ids come from different minters (the ExecService,
// the MCP bridge's elicitation counter, …) and nothing stops two of them from
// picking the same string.

import type {
  ExecApprovalRequest,
  InstructionsProposal,
  McpAdminProposal,
  SkillProposal
} from '@shared/types';

export type ApprovalKind = 'exec' | 'mcp' | 'instructions' | 'skill';

export type PendingApproval =
  | { kind: 'exec'; id: string; request: ExecApprovalRequest }
  | { kind: 'mcp'; id: string; proposal: McpAdminProposal }
  | { kind: 'instructions'; id: string; proposal: InstructionsProposal }
  | { kind: 'skill'; id: string; proposal: SkillProposal };

const key = (kind: ApprovalKind, id: string | number): string => `${kind}:${String(id)}`;

/** Append unless it is already queued. Returns the same array when it is. */
export function enqueueApproval(queue: PendingApproval[], item: PendingApproval): PendingApproval[] {
  const k = key(item.kind, item.id);
  return queue.some((q) => key(q.kind, q.id) === k) ? queue : [...queue, item];
}

/** Drop an answered/expired approval from any position. Same array if absent. */
export function removeApproval(
  queue: PendingApproval[],
  kind: ApprovalKind,
  id: string | number
): PendingApproval[] {
  const k = key(kind, id);
  const next = queue.filter((q) => key(q.kind, q.id) !== k);
  return next.length === queue.length ? queue : next;
}

/** One line naming what is being asked, for the sheet's header and a push label. */
export function approvalTitle(item: PendingApproval): string {
  switch (item.kind) {
    case 'exec':
      return 'Run a command?';
    case 'mcp':
      return item.proposal.action === 'add' ? 'Connect a tool server?' : 'Disconnect a tool server?';
    case 'instructions':
      return item.proposal.action === 'clear'
        ? 'Clear your instructions?'
        : item.proposal.action === 'replace'
          ? 'Replace your instructions?'
          : 'Add to your instructions?';
    case 'skill':
      return item.proposal.isPatch ? 'Update a saved skill?' : 'Save a new skill?';
  }
}

/** The thread the approval came out of — what a deep link from a push opens. */
export function approvalThreadId(item: PendingApproval): string {
  return item.kind === 'exec' ? item.request.threadId : item.proposal.threadId;
}
