import { useEffect, useState } from 'react';
import { Terminal } from 'lucide-react';
import type { ExecApprovalRequest, ExecDecision } from '../../shared/types';
import { enqueueApproval, removeApproval } from './approvalQueue';

// Modal confirm card shown when a run_command call fell through the auto-approve
// tiers (allowlist → LLM judge). The backend holds the tool call open until the
// user decides; "Always allow" also persists the prefix of every not-yet-allowed
// chained segment to the user allowlist so the command auto-runs next time
// (editable in Settings → Chat → Command execution).
export function ExecApprovalCard() {
  const [queue, setQueue] = useState<ExecApprovalRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = queue[0] ?? null;
  const busy = !!request && busyId === request.id;

  useEffect(() => {
    const offRequest = window.stem.onExecApproval((r) => {
      setQueue((q) => enqueueApproval(q, r));
    });
    const offResolved = window.stem.onExecApprovalResolved(({ id }) => {
      setQueue((q) => removeApproval(q, id));
      setBusyId((cur) => (cur === id ? null : cur));
    });
    return () => {
      offRequest();
      offResolved();
    };
  }, []);

  if (!request) return null;

  async function decide(decision: ExecDecision) {
    if (!request || busy) return;
    setBusyId(request.id);
    setError(null);
    try {
      await window.stem.respondExecApproval(request.id, decision);
      setQueue((q) => removeApproval(q, request.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId((cur) => (cur === request.id ? null : cur));
    }
  }

  const verdictLine =
    request.judgeVerdict === 'unsafe'
      ? 'The safety check flagged this command as potentially unsafe'
      : request.judgeVerdict === 'failed'
        ? 'The automatic safety check could not run'
        : request.judgeVerdict === 'unsure'
          ? 'The safety check could not tell whether this command is safe'
          : 'Manual approval is on — commands only run when you allow them';

  return (
    <div className="mcp-approval-backdrop" role="dialog" aria-modal="true">
      <div className="mcp-approval-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <Terminal size={15} />
          </span>
          <strong>Run this command?</strong>
        </div>

        <p className="muted">
          {verdictLine}
          {request.judgeReason ? `: ${request.judgeReason}` : '.'}
        </p>

        <pre className="exec-approval-command">{request.command}</pre>
        <p className="muted">
          in <code>{request.cwd}</code>
        </p>

        {error && <p className="error">{error}</p>}

        <div className="mcp-approval-actions">
          <button className="push" onClick={() => void decide('deny')} disabled={busy}>
            Deny
          </button>
          {request.prefixes.length > 0 && (
            <button
              className="push"
              onClick={() => void decide('alwaysAllow')}
              disabled={busy}
              title={`Adds ${request.prefixes.map((p) => `"${p}"`).join(', ')} to the allowlist in Settings → Chat → Command execution`}
            >
              Always allow {request.prefixes.map((p) => `“${p}”`).join(', ')}
            </button>
          )}
          <button className="push default" onClick={() => void decide('allowOnce')} disabled={busy}>
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
}
