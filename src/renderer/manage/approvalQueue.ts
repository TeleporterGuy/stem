export interface ApprovalWithId {
  id: number | string;
}

/** Append once, preserving arrival order for parallel tool approvals. */
export function enqueueApproval<T extends ApprovalWithId>(queue: T[], proposal: T): T[] {
  const id = String(proposal.id);
  return queue.some((p) => String(p.id) === id) ? queue : [...queue, proposal];
}

/** Idempotently remove an answered/expired proposal from any queue position. */
export function removeApproval<T extends ApprovalWithId>(queue: T[], id: number | string): T[] {
  const key = String(id);
  const next = queue.filter((p) => String(p.id) !== key);
  return next.length === queue.length ? queue : next;
}
