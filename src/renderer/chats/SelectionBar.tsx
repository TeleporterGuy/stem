import { AlarmClock, Archive, ArchiveRestore, MailOpen } from 'lucide-react';

// Appears under the mode control the moment a multi-selection exists, and only
// then — a permanently visible toolbar would be dead weight for the single-row
// case, which is nearly every case.

export interface SelectionBarProps {
  count: number;
  /** Archived mode offers "move back to the Inbox" instead of "archive". */
  archived: boolean;
  onSnooze: (e: React.MouseEvent) => void;
  onArchive: () => void;
  onMarkRead: () => void;
  onClear: () => void;
}

export function SelectionBar({
  count,
  archived,
  onSnooze,
  onArchive,
  onMarkRead,
  onClear
}: SelectionBarProps) {
  return (
    <div className="inbox-selbar">
      <span className="inbox-selbar-count">{count} selected</span>
      <span className="inbox-selbar-actions">
        {!archived && (
          <button className="link-btn icon-only" data-label="Snooze" aria-label="Snooze" onClick={onSnooze}>
            <AlarmClock size={14} />
          </button>
        )}
        <button
          className="link-btn icon-only"
          data-label={archived ? 'Move to Inbox' : 'Archive'}
          aria-label={archived ? 'Move to Inbox' : 'Archive'}
          onClick={onArchive}
        >
          {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        </button>
        <button
          className="link-btn icon-only"
          data-label="Mark read"
          aria-label="Mark read"
          onClick={onMarkRead}
        >
          <MailOpen size={14} />
        </button>
        <button className="link-btn" onClick={onClear}>
          Done
        </button>
      </span>
    </div>
  );
}
