import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import type { CustomInstructionsSettings, InstructionsProposal } from '../../shared/types';
// The append/replace/clear rule moved to shared/ when the phone gained the same
// card — see the header there for why both clients must resolve it identically.
import { resolvedInstructionsText as resolvedText } from '../../shared/instructions';
import { enqueueApproval, removeApproval } from './approvalQueue';

type Surface = 'main' | 'quickChat';

// Modal confirm card shown when the assistant proposes a custom-instructions change
// (the `set_custom_instructions` tool). The user edits the final text and picks the
// surface; nothing is written until Apply — the backend holds the tool call open.
export function InstructionsApprovalCard() {
  const [queue, setQueue] = useState<InstructionsProposal[]>([]);
  const [current, setCurrent] = useState<CustomInstructionsSettings>({ main: '', quickChat: '' });
  const [surface, setSurface] = useState<Surface>('main');
  const [text, setText] = useState('');
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proposal = queue[0] ?? null;
  const proposalId = proposal ? String(proposal.id) : null;
  const ready = !!proposalId && loadedId === proposalId;
  const busy = !!proposalId && busyId === proposalId;

  useEffect(() => {
    const offProposal = window.stem.onInstructionsApproval((p) => {
      setQueue((q) => enqueueApproval(q, p));
    });
    const offResolved = window.stem.onInstructionsApprovalResolved(({ id }) => {
      setQueue((q) => removeApproval(q, id));
      setBusyId((cur) => (cur === String(id) ? null : cur));
    });
    return () => {
      offProposal();
      offResolved();
    };
  }, []);

  // Load the authoritative current strings for each queue head. `loadedId` makes
  // Apply impossible during the async gap, so an old/empty preview can never win.
  useEffect(() => {
    if (!proposal) {
      setLoadedId(null);
      return;
    }
    let cancelled = false;
    const id = String(proposal.id);
    const initialSurface: Surface = proposal.suggestedSurface ?? 'main';
    setLoadedId(null);
    setError(null);
    window.stem
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        setCurrent(s.customInstructions);
        setSurface(initialSurface);
        setText(resolvedText(proposal.action, proposal.incomingText, s.customInstructions[initialSurface]));
        setLoadedId(id);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [proposal]);

  if (!proposal) return null;

  function pickSurface(next: Surface) {
    if (!proposal || !ready) return;
    setSurface(next);
    // Recompute the proposed text for the newly chosen surface (append depends on it).
    setText(resolvedText(proposal.action, proposal.incomingText, current[next]));
  }

  async function decide(accept: boolean) {
    if (!proposal || busy || (accept && !ready)) return;
    const id = proposal.id;
    const key = String(id);
    setBusyId(key);
    setError(null);
    try {
      await window.stem.respondInstructionsApproval(id, accept, surface, text);
      setQueue((q) => removeApproval(q, id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId((cur) => (cur === key ? null : cur));
    }
  }

  const actionLabel =
    proposal.action === 'clear' ? 'Clear instructions' : proposal.action === 'replace' ? 'Replace instructions' : 'Add to instructions';

  return (
    <div className="mcp-approval-backdrop" role="dialog" aria-modal="true">
      <div className="mcp-approval-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <Pencil size={15} />
          </span>
          <strong>{actionLabel}</strong>
        </div>

        <p className="muted">The assistant wants to update your standing custom instructions. Choose where they apply and edit the text before applying.</p>

        <div className="seg-ctl" role="group" aria-label="Which surface">
          <button className={surface === 'main' ? 'active' : ''} onClick={() => pickSurface('main')} disabled={busy || !ready}>
            Main (everywhere)
          </button>
          <button className={surface === 'quickChat' ? 'active' : ''} onClick={() => pickSurface('quickChat')} disabled={busy || !ready}>
            Quick Chat only
          </button>
        </div>
        <p className="muted">
          {surface === 'main'
            ? 'Applies in the main app and in Quick Chat.'
            : 'An extra layered only on the Quick Chat overlay (on top of Main).'}
        </p>

        <textarea
          className="instructions-approval-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          disabled={busy || !ready}
          placeholder="(empty — clears these instructions)"
        />

        {!ready && !error && <p className="muted">Loading current instructions…</p>}
        {error && <p className="error">{error}</p>}

        <div className="mcp-approval-actions">
          <button className="push" onClick={() => decide(false)} disabled={busy}>
            Cancel
          </button>
          <button className="push default" onClick={() => decide(true)} disabled={busy || !ready}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
