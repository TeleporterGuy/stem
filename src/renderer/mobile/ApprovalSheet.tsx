import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Globe, HardDrive, Pencil, Plug, Terminal } from 'lucide-react';
import type {
  ExecApprovalRequest,
  ExecDecision,
  InstructionsProposal,
  McpAdminProposal
} from '../../shared/types';
import { headApproval, resolvedInstructionsText, type ApprovalStore } from './approvals';

// The phone's approval cards.
//
// Phone-shaped rather than the desktop's (manage/*ApprovalCard.tsx), which the
// mobile bundle deliberately does not mount: those are centred modals sized for a
// pointer, with a hover-scale action row and — for instructions — a surface
// picker offering Quick Chat, a window that does not exist here. This is a bottom
// sheet with full-width targets, one question at a time, and it answers on the
// main surface (see approvals.ts). The desktop components are untouched.
//
// The queueing, and the retraction that matters as much as it — a request the
// user answered at the desk is taken off the phone by its `*Resolved` event —
// live in the store; this file only renders its head.

export function ApprovalSheet({ store }: { store: ApprovalStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.get);
  // Subscribe on mount, not at construction: one attach per mounted sheet, and
  // StrictMode's mount/unmount/mount cycle leaves no listener behind.
  useEffect(() => store.attach(), [store]);

  const pending = headApproval(snapshot);
  if (!pending) return null;
  // Keyed by approval id so a new request always arrives with a clean card
  // (nothing busy, no stale error from the one before it).
  if (pending.kind === 'exec') {
    return <ExecCard key={pending.request.id} request={pending.request} store={store} />;
  }
  if (pending.kind === 'mcp') {
    return <McpCard key={String(pending.proposal.id)} proposal={pending.proposal} store={store} />;
  }
  return (
    <InstructionsCard key={String(pending.proposal.id)} proposal={pending.proposal} store={store} />
  );
}

/** Busy + error for one card's decision, so a failed answer is never silent. */
function useDecision(): {
  busy: boolean;
  error: string | null;
  decide: (run: () => Promise<void>) => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // On success the card is gone before this resolves, so only the failure path
  // touches state again — and leaving `busy` set stops a second tap racing the
  // removal.
  const decide = useCallback((run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void run().catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    });
  }, []);
  return { busy, error, decide };
}

function Sheet({
  icon,
  title,
  error,
  children,
  actions
}: {
  icon: ReactNode;
  title: string;
  error: string | null;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="m-sheet-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="m-sheet">
        <div className="m-sheet-head">
          <span className="m-sheet-icon">{icon}</span>
          <strong>{title}</strong>
        </div>
        <div className="m-sheet-body">{children}</div>
        {error && <p className="m-sheet-error">{error}</p>}
        <div className="m-sheet-actions">{actions}</div>
      </div>
    </div>
  );
}

function ExecCard({ request, store }: { request: ExecApprovalRequest; store: ApprovalStore }) {
  const { busy, error, decide } = useDecision();
  const answer = (decision: ExecDecision): void => decide(() => store.resolveExec(request.id, decision));

  const verdict =
    request.judgeVerdict === 'unsafe'
      ? 'The safety check flagged this command as potentially unsafe'
      : request.judgeVerdict === 'unsure'
        ? 'The safety check could not tell whether this command is safe'
        : 'Manual approval is on — commands only run when you allow them';

  return (
    <Sheet icon={<Terminal size={15} />} title="Run this command?" error={error}
      actions={
        <>
          <button type="button" className="m-sheet-btn primary" disabled={busy} onClick={() => answer('allowOnce')}>
            Allow once
          </button>
          {/* "Always allow" persists a prefix to the exec allowlist, which is a
              settings change made blind from a phone — offered, but never the
              button under the thumb. */}
          {request.prefixes.length > 0 && (
            <button type="button" className="m-sheet-btn" disabled={busy} onClick={() => answer('alwaysAllow')}>
              Always allow {request.prefixes.map((p) => `“${p}”`).join(', ')}
            </button>
          )}
          <button type="button" className="m-sheet-btn danger" disabled={busy} onClick={() => answer('deny')}>
            Deny
          </button>
        </>
      }
    >
      <p className="m-sheet-note">
        {verdict}
        {request.judgeReason ? `: ${request.judgeReason}` : '.'}
      </p>
      <pre className="m-sheet-pre">{request.command}</pre>
      <p className="m-sheet-note">
        in <code>{request.cwd}</code>
      </p>
    </Sheet>
  );
}

function McpCard({ proposal, store }: { proposal: McpAdminProposal; store: ApprovalStore }) {
  const { busy, error, decide } = useDecision();
  const answer = (accept: boolean): void => decide(() => store.resolveMcp(proposal.id, accept));
  const input = proposal.input;
  const remote = input?.transport === 'http';

  return (
    <Sheet
      icon={proposal.action === 'add' ? (remote ? <Globe size={15} /> : <HardDrive size={15} />) : <Plug size={15} />}
      title={`${proposal.action === 'add' ? 'Add' : 'Remove'} MCP server${proposal.name ? ` “${proposal.name}”` : ''}`}
      error={error}
      actions={
        <>
          <button type="button" className="m-sheet-btn primary" disabled={busy} onClick={() => answer(true)}>
            Approve
          </button>
          <button type="button" className="m-sheet-btn danger" disabled={busy} onClick={() => answer(false)}>
            Reject
          </button>
        </>
      }
    >
      {proposal.action === 'add' && input ? (
        <>
          <p className="m-sheet-note">{remote ? 'Remote server (http)' : 'Local server (stdio)'}</p>
          <pre className="m-sheet-pre">
            {remote ? input.url || '—' : `${input.command ?? ''} ${(input.args ?? []).join(' ')}`.trim() || '—'}
          </pre>
          {!remote && (
            <p className="m-sheet-note">
              A local server runs this command on your Mac when it reloads. Approve only if you trust it.
            </p>
          )}
        </>
      ) : (
        <p className="m-sheet-note">The assistant wants to remove this server from your configuration.</p>
      )}
    </Sheet>
  );
}

function InstructionsCard({ proposal, store }: { proposal: InstructionsProposal; store: ApprovalStore }) {
  const { busy, error, decide } = useDecision();
  /** The resulting text, resolved against the CURRENT instructions (append). */
  const [text, setText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The whole surface string is what gets written, so the current value has to be
  // read before Apply can mean anything. Until it lands, Apply stays disabled —
  // an empty preview applied by mistake would wipe the user's instructions.
  useEffect(() => {
    let cancelled = false;
    window.stem
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        setText(resolvedInstructionsText(proposal.action, proposal.incomingText, settings.customInstructions.main));
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [proposal]);

  const title =
    proposal.action === 'clear'
      ? 'Clear instructions'
      : proposal.action === 'replace'
        ? 'Replace instructions'
        : 'Add to instructions';

  return (
    <Sheet
      icon={<Pencil size={15} />}
      title={title}
      error={error ?? loadError}
      actions={
        <>
          <button
            type="button"
            className="m-sheet-btn primary"
            disabled={busy || text === null}
            onClick={() => decide(() => store.resolveInstructions(proposal.id, true, text ?? ''))}
          >
            Apply
          </button>
          <button
            type="button"
            className="m-sheet-btn"
            disabled={busy}
            onClick={() => decide(() => store.resolveInstructions(proposal.id, false, ''))}
          >
            Cancel
          </button>
        </>
      }
    >
      {/* Read-only here: editing standing instructions is desk work, and the
          phone's job is to say yes or no to what the assistant proposed. */}
      <p className="m-sheet-note">
        The assistant wants to update your standing instructions — they apply everywhere.
      </p>
      {text === null ? (
        <p className="m-sheet-note">{loadError ? 'Couldn’t read your current instructions.' : 'Loading…'}</p>
      ) : (
        <pre className="m-sheet-pre wrap">{text || '(empty — clears these instructions)'}</pre>
      )}
    </Sheet>
  );
}
