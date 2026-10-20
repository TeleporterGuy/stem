import { useEffect, useState } from 'react';
import { Check, Copy, Link2Off } from 'lucide-react';
import { SHARE_MAX_LINKS, type SharedLink } from '../../../../shared/share';
import { DisclosureRow, ValueRow } from './rows';

const SCOPE_LABEL: Record<string, string> = {
  thread: 'Whole thread',
  pair: 'Question and answer',
  answer: 'Answer only'
};

/**
 * Settings → Features → Shared links: the public links this Stem published
 * (docs/public-share-design.md), to copy again or revoke. Hidden until there
 * is one.
 */
export function SharedLinksSection() {
  const [links, setLinks] = useState<SharedLink[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.stem.listShares().then(setLinks, () => setLinks([]));
  }, []);

  if (!links?.length) return null;

  const revoke = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      setLinks(await window.stem.revokeShare(id));
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    } finally {
      setBusy(null);
    }
  };

  const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });

  return (
    <>
      <div className="grp-head">Shared links</div>
      <div className="group">
        <DisclosureRow
          label="Public links you made"
          hint={`Anyone with a link can read it · at most ${SHARE_MAX_LINKS} at a time`}
          value={String(links.length)}
        >
          {links.map((l) => (
            <ValueRow
              key={l.id}
              label={l.title}
              hint={`${SCOPE_LABEL[l.scope] ?? 'Shared'}${l.source?.kind === 'mail' ? ' (mail)' : ''} · until ${date(l.expiresAt)}`}
            >
              <span className="row-inline">
                <button
                  className="icon-action sm"
                  title={copied === l.id ? 'Copied' : 'Copy link'}
                  aria-label={`Copy the link to ${l.title}`}
                  onClick={() => void navigator.clipboard.writeText(l.url).then(() => setCopied(l.id))}
                >
                  {copied === l.id ? <Check size={14} /> : <Copy size={14} />}
                </button>
                <button
                  className="icon-action sm"
                  disabled={busy === l.id}
                  title="Revoke — the link stops opening"
                  aria-label={`Revoke the link to ${l.title}`}
                  onClick={() => void revoke(l.id)}
                >
                  <Link2Off size={14} />
                </button>
              </span>
            </ValueRow>
          ))}
        </DisclosureRow>
        {error && <p className="task-failed">{error}</p>}
      </div>
    </>
  );
}
