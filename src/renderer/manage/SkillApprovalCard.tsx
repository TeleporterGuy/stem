import { useEffect, useState } from 'react';
import { GraduationCap } from 'lucide-react';
import type { SkillProposal } from '../../shared/types';
import { enqueueApproval, removeApproval } from './approvalQueue';

// Modal confirm card shown when Stem wants to save a skill and the mode is `ask`.
//
// The whole file is on screen, not a summary of it, because a skill is a standing
// instruction: it gets loaded into later turns and followed. Accepting one without
// reading it is how a wrong procedure becomes permanent, so the card shows the text
// and lets the user fix it first — the edited version is what gets written.
//
// Nothing is validated here. The write happens inside the held manage_skill call
// (SkillBridge), which runs the same contract check every other authoring path uses
// and reports the violations back to the model. A card that re-implemented those
// rules would be a second copy to drift.
export function SkillApprovalCard() {
  const [queue, setQueue] = useState<SkillProposal[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proposal = queue[0] ?? null;
  const busy = !!proposal && busyId === String(proposal.id);

  useEffect(() => {
    const offProposal = window.stem.onSkillApproval((p) => {
      setQueue((q) => enqueueApproval(q, p));
    });
    // The resolved event is what retracts a card answered somewhere else — the
    // phone, or the other window — and it also fires when the request times out.
    // Without it the loser surface keeps a live-looking card whose Accept would
    // resolve nothing.
    const offResolved = window.stem.onSkillApprovalResolved(({ id }) => {
      setQueue((q) => removeApproval(q, id));
      setBusyId((cur) => (cur === String(id) ? null : cur));
    });
    return () => {
      offProposal();
      offResolved();
    };
  }, []);

  // Reload the fields for each new queue head. The proposal carries the full text,
  // so unlike the instructions card there is nothing to fetch and no window in
  // which an empty preview could be applied.
  useEffect(() => {
    if (!proposal) return;
    setName(proposal.name);
    setDescription(proposal.description);
    setBody(proposal.body);
    setError(null);
  }, [proposal]);

  if (!proposal) return null;

  async function decide(accept: boolean) {
    if (!proposal || busy) return;
    const id = proposal.id;
    const key = String(id);
    setBusyId(key);
    setError(null);
    try {
      await window.stem.respondSkillApproval(id, accept, { name, description, body });
      setQueue((q) => removeApproval(q, id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId((cur) => (cur === key ? null : cur));
    }
  }

  return (
    <div className="mcp-approval-backdrop" role="dialog" aria-modal="true">
      <div className="mcp-approval-card skill-approval-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <GraduationCap size={15} />
          </span>
          {/* Overwriting an existing skill is a different decision from adding one:
              the old text is gone, and whatever was working about it goes with it. */}
          <strong>{proposal.isPatch ? 'Update skill' : 'Save skill'}</strong>
        </div>

        <p className="muted">
          {proposal.isPatch
            ? 'This replaces the saved skill of the same name. Stem follows it on later turns, so fix anything wrong before accepting.'
            : 'Stem wants to save this procedure and follow it on later turns. Edit anything that looks wrong before accepting.'}
        </p>

        <label className="skill-approval-field">
          <span>Name</span>
          <input
            className="skill-approval-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            spellCheck={false}
          />
        </label>

        <label className="skill-approval-field">
          <span>Description</span>
          <input
            className="skill-approval-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="skill-approval-field">
          <span>Steps</span>
          <textarea
            className="skill-approval-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={14}
            disabled={busy}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <div className="mcp-approval-actions">
          {/* Decline is an ordinary answer — most proposals will be declined — so
              it reads as the plain button, not a warning. */}
          <button className="push" onClick={() => decide(false)} disabled={busy}>
            Decline
          </button>
          <button className="push default" onClick={() => decide(true)} disabled={busy}>
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
