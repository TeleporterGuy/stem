import { useState } from 'react';
import { ChevronRight, FileText, Globe, Pencil, Shrink, Terminal, Wrench } from 'lucide-react';
import type { ActivityItem, SourceRef } from '../../shared/types';
import { activityLabel, settledActivityLabel } from '../../shared/activity';

// Per-turn tool activity, rendered above the assistant reply. While the turn runs
// every tool call is a live row (the running one pulses); once the turn settles the
// rows collapse into a single "Used N tools" summary, expandable on click.

function iconFor(item: ActivityItem) {
  if (item.type === 'webSearch') return <Globe size={13} />;
  if (item.type === 'fileChange') return <Pencil size={13} />;
  if (item.type === 'compaction') return <Shrink size={13} />;
  if (item.name === 'read') return <FileText size={13} />;
  if (item.type === 'commandExecution') return <Terminal size={13} />;
  return <Wrench size={13} />;
}

function RowDots() {
  return (
    <span className="activity-dots" aria-hidden="true">
      <span className="activity-dot" />
      <span className="activity-dot" />
      <span className="activity-dot" />
    </span>
  );
}

export function ActivityRows({ items, running }: { items: ActivityItem[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const summary = `Used ${items.length} ${items.length === 1 ? 'tool' : 'tools'}`;
  const expanded = running || open;
  return (
    <div className={`activity-rows${expanded ? ' open' : ''}`}>
      {!running && (
        <button
          type="button"
          className="activity-rows-summary"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRight size={12} className="activity-rows-chevron" />
          {summary}
        </button>
      )}
      {expanded &&
        items.map((item) => {
          const live = running && item.status === 'running';
          const label = live
            ? activityLabel(item.type, item.name, item.detail)
            : settledActivityLabel(item.type, item.name, item.detail);
          return (
            <div
              key={item.id}
              className={`activity-row-item${item.status === 'error' ? ' error' : ''}${live ? ' live' : ''}`}
            >
              {live ? <RowDots /> : iconFor(item)}
              <span className="activity-row-label" title={label}>
                {label}
              </span>
            </div>
          );
        })}
    </div>
  );
}

/** Only ever link out to http(s) — citations come from a teed provider stream. */
function safeSourceUrl(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

export function SourcesList({ sources }: { sources: SourceRef[] }) {
  const [open, setOpen] = useState(false);
  const safe = sources.filter((s) => safeSourceUrl(s.url));
  if (!safe.length) return null;
  return (
    <div className={`sources${open ? ' open' : ''}`}>
      <button
        type="button"
        className="activity-rows-summary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight size={12} className="activity-rows-chevron" />
        Sources ({safe.length})
      </button>
      {open && (
        <ul className="sources-list">
          {safe.map((s) => (
            <li key={s.url}>
              <Globe size={12} />
              <a href={s.url} target="_blank" rel="noreferrer" title={s.url}>
                {s.title?.trim() || s.url}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
