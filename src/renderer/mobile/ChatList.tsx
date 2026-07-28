import { MessageSquare, RefreshCw, SquarePen } from 'lucide-react';
import type { ChatSummary } from '../../shared/types';
import type { ThreadStates } from '../session/store';

// Every chat, newest first — including the ones started at the desk, which is the
// point: the phone continues conversations, it doesn't run a separate life. The
// desktop's folder tree is deliberately absent (folders organize a sidebar, not a
// phone screen); a chat's folder is still honored, it just isn't shown here.

const TODAY_TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const THIS_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const OLDER = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Relative-ish stamp for a chat row: time today, date this year, else full date. */
function formatWhen(unixSeconds: number): string {
  const at = new Date(unixSeconds * 1000);
  if (Number.isNaN(at.getTime())) return '';
  const now = new Date();
  if (at.toDateString() === now.toDateString()) return TODAY_TIME.format(at);
  if (at.getFullYear() === now.getFullYear()) return THIS_YEAR.format(at);
  return OLDER.format(at);
}

export function ChatList({
  chats,
  states,
  loading,
  onOpen,
  onNew,
  onRefresh
}: {
  chats: ChatSummary[];
  /** Live slices, so a chat running or finished in the background shows its dot. */
  states: ThreadStates;
  loading: boolean;
  onOpen: (threadId: string) => void;
  onNew: () => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <header className="m-head">
        <h1 className="m-title">Chats</h1>
        <button
          type="button"
          className="m-head-btn"
          aria-label="Refresh"
          onClick={onRefresh}
          disabled={loading}
        >
          <RefreshCw size={17} className={loading ? 'm-spin' : undefined} />
        </button>
        <button type="button" className="m-head-btn" aria-label="New chat" onClick={onNew}>
          <SquarePen size={18} />
        </button>
      </header>
      <div className="m-scroll">
        {chats.length === 0 ? (
          <p className="m-empty">
            {loading ? 'Loading your chats…' : 'No chats yet. Tap the pencil to start one.'}
          </p>
        ) : (
          <ul className="m-chats">
            {chats.map((chat) => {
              const status = states[chat.threadId]?.status ?? 'idle';
              return (
                <li key={chat.threadId}>
                  <button type="button" className="m-chat-row" onClick={() => onOpen(chat.threadId)}>
                    <MessageSquare size={15} className="m-chat-icon" />
                    <span className="m-chat-title">{chat.title}</span>
                    {status !== 'idle' && <span className={`chat-status ${status}`} aria-hidden="true" />}
                    <span className="m-chat-when">{formatWhen(chat.updatedAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
