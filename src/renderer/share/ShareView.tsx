import type { ReactNode } from 'react';
import { Sparkles, User } from 'lucide-react';
import { MdxView } from '../chat/MdxView';
import type { ShareMessage, ShareSnapshot } from '../../shared/share';

// A share snapshot drawn with the chat's own markup and classes, so a shared
// answer looks like it does in Stem. Used by the share dialog's preview and by
// the share.heystem.app viewer (src/share), so it must stay web-safe: no
// window.stem, no app stores. Interactive MDX renders inert here because no
// action context is provided (forms read-only, Replies hidden).

const AVATAR: Record<ShareMessage['role'], { cls: string; icon: ReactNode; label: string }> = {
  user: { cls: 'you', icon: <User size={15} />, label: 'Question' },
  assistant: { cls: 'stem', icon: <Sparkles size={15} />, label: 'Stem' }
};

const httpUrl = (u: string): boolean => /^https?:\/\//i.test(u);

function siteName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function ShareSources({ sources }: { sources: NonNullable<ShareMessage['sources']> }) {
  const safe = sources.filter((s) => httpUrl(s.url));
  if (!safe.length) return null;
  return (
    <details className="share-sources">
      <summary>Sources ({safe.length})</summary>
      <ul>
        {safe.map((s) => (
          <li key={s.url}>
            <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" title={s.url}>
              <span className="share-source-site">{siteName(s.url)}</span>
              <span className="share-source-title">{s.title?.trim() || s.url}</span>
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

function stampOf(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function ShareMessageView({ m }: { m: ShareMessage }) {
  const a = AVATAR[m.role];
  const images = (m.images ?? []).filter((i) => /^data:image\/(png|jpeg|gif|webp);base64,/i.test(i.dataUrl));
  return (
    <div className={`message message-${m.role}`}>
      <div className={`msg-avatar ${a.cls}`}>{a.icon}</div>
      <div className="message-body">
        <div className="message-who">
          <span className="message-who-name">{m.author ?? a.label}</span>
          {m.model && <span className="message-meta">{m.model}</span>}
          {stampOf(m.createdAt) && <span className="message-timing">{stampOf(m.createdAt)}</span>}
        </div>
        {m.role === 'assistant' ? (
          m.text && <MdxView text={m.text} />
        ) : (
          m.text && <div className="message-plain">{m.text}</div>
        )}
        {images.length > 0 && (
          <div className="message-attachments">
            {images.map((img, i) => (
              <img key={i} className="message-image" src={img.dataUrl} alt={img.alt ?? 'picture'} />
            ))}
          </div>
        )}
        {m.sources && m.sources.length > 0 && <ShareSources sources={m.sources} />}
      </div>
    </div>
  );
}

export function ShareView({ snapshot, header = true }: { snapshot: ShareSnapshot; header?: boolean }) {
  const shared = new Date(snapshot.sharedAt);
  return (
    <article className="share-view">
      {header && (
        <header className="share-head">
          <h1>{snapshot.title}</h1>
          <p className="muted">
            {snapshot.kind === 'answer' ? 'An answer' : 'A conversation'} shared from Stem
            {Number.isNaN(shared.getTime()) ? '' : ` · ${shared.toLocaleDateString(undefined, { dateStyle: 'long' })}`}
          </p>
        </header>
      )}
      <div className="share-messages">
        {snapshot.messages.map((m, i) => (
          <ShareMessageView key={i} m={m} />
        ))}
      </div>
    </article>
  );
}
