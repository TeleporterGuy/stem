import { useEffect, useState } from 'react';
import { Plug, Globe, HardDrive } from 'lucide-react';
import type { McpAdminProposal } from '../../shared/types';
import { enqueueApproval, removeApproval } from './approvalQueue';

// A modal confirm card shown when the chat assistant proposes adding or removing
// an MCP server (the `stem-admin` self-management tools). Nothing is written to
// config until the user approves — the backend holds the tool call open until then.
export function McpApprovalCard() {
  const [queue, setQueue] = useState<McpAdminProposal[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proposal = queue[0] ?? null;
  const busy = !!proposal && busyId === String(proposal.id);

  useEffect(() => {
    const offProposal = window.stem.onMcpAdminApproval((p) => {
      setQueue((q) => enqueueApproval(q, p));
    });
    const offResolved = window.stem.onMcpAdminApprovalResolved(({ id }) => {
      setQueue((q) => removeApproval(q, id));
      setBusyId((cur) => (cur === String(id) ? null : cur));
    });
    return () => {
      offProposal();
      offResolved();
    };
  }, []);

  if (!proposal) return null;

  async function decide(accept: boolean) {
    if (!proposal || busy) return;
    const id = proposal.id;
    const key = String(id);
    setBusyId(key);
    setError(null);
    try {
      await window.stem.respondMcpAdminApproval(id, accept);
      // The broadcast removes this card from every renderer. Remove locally too
      // so the queue advances even if this window closes before receiving it.
      setQueue((q) => removeApproval(q, id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId((cur) => (cur === key ? null : cur));
    }
  }

  const input = proposal.input;
  const remote = input?.transport === 'http';
  const envKeys = input?.env ? Object.keys(input.env) : [];

  return (
    <div className="mcp-approval-backdrop" role="dialog" aria-modal="true">
      <div className="mcp-approval-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            {proposal.action === 'add' ? (remote ? <Globe size={15} /> : <HardDrive size={15} />) : <Plug size={15} />}
          </span>
          <strong>
            {proposal.action === 'add' ? 'Add MCP server' : 'Remove MCP server'}
            {proposal.name ? ` “${proposal.name}”` : ''}
          </strong>
        </div>

        {proposal.action === 'add' && input ? (
          <dl className="mcp-approval-detail">
            <dt>Transport</dt>
            <dd>{remote ? 'Remote (http)' : 'Local (stdio)'}</dd>
            {remote ? (
              <>
                <dt>URL</dt>
                <dd>{input.url || <em>—</em>}</dd>
                {input.oauthClientId && (
                  <>
                    <dt>OAuth Client ID</dt>
                    <dd><code>{input.oauthClientId}</code></dd>
                  </>
                )}
                {input.oauthScope && (
                  <>
                    <dt>OAuth Scopes</dt>
                    <dd>{input.oauthScope}</dd>
                  </>
                )}
                {input.oauthClientSecret && (
                  <>
                    <dt>OAuth Client Secret</dt>
                    <dd><em>provided</em></dd>
                  </>
                )}
              </>
            ) : (
              <>
                <dt>Command</dt>
                <dd>
                  <code>{`${input.command ?? ''} ${(input.args ?? []).join(' ')}`.trim() || '—'}</code>
                </dd>
              </>
            )}
            {envKeys.length > 0 && (
              <>
                <dt>Env</dt>
                <dd>{envKeys.join(', ')}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="muted">The assistant wants to remove this server from your configuration.</p>
        )}

        {!remote && proposal.action === 'add' && (
          <p className="muted">A local server runs this command on your machine when reloaded. Approve only if you trust it.</p>
        )}

        {error && <p className="error">{error}</p>}

        <div className="mcp-approval-actions">
          <button className="push" onClick={() => decide(false)} disabled={busy}>
            Reject
          </button>
          <button className="push default" onClick={() => decide(true)} disabled={busy}>
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
