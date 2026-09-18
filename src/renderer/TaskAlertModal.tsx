import { useEffect, useRef } from 'react';
import { Bell } from 'lucide-react';
import type { TaskNotifyPayload } from '../shared/types';

// Prominent alert raised when a scheduled run calls notify_user. Mirrors the
// McpApprovalCard / DeleteThreadDialog modal markup. "Open mail" jumps to the
// mail conversation the notification landed in — the run itself happened in a
// hidden thread of its own, and the mail is where its report arrives. Dismiss
// (or Escape / backdrop click) closes it. No Open button when the mail could
// not be delivered: there is nothing to open.
export function TaskAlertModal({
  payload,
  onOpenMail,
  onDismiss
}: {
  payload: TaskNotifyPayload;
  onOpenMail: (conversationId: string) => void;
  onDismiss: () => void;
}) {
  const defaultRef = useRef<HTMLButtonElement>(null);
  const conversationId = payload.conversationId;

  useEffect(() => {
    defaultRef.current?.focus();
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onDismiss();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (conversationId) onOpenMail(conversationId);
      else onDismiss();
    }
  }

  return (
    <div
      className="mcp-approval-backdrop"
      role="dialog"
      aria-modal="true"
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className="mcp-approval-card task-alert-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <Bell size={15} />
          </span>
          <strong>{payload.title?.trim() || 'Scheduled task'}</strong>
        </div>
        <p className="task-alert-message">{payload.message}</p>
        <div className="mcp-approval-actions">
          <button ref={conversationId ? undefined : defaultRef} className={conversationId ? 'push' : 'push default'} onClick={onDismiss}>
            Dismiss
          </button>
          {conversationId && (
            <button ref={defaultRef} className="push default" onClick={() => onOpenMail(conversationId)}>
              Open mail
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
