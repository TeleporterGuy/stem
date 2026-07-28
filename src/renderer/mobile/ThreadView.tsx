import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Brain, ChevronLeft, File, Sparkles, User } from 'lucide-react';
import type { ActivityItem, ChatMessage, TurnAttachment } from '../../shared/types';
import { ActivityRows, SourcesList } from '../chat/ActivityRows';
import { MdxView } from '../chat/MdxView';
import { MdxActionContext } from '../mdx/ActionContext';
import { Composer } from './Composer';
import { MemoryPeek } from './MemoryPeek';

// One conversation on a phone screen. The bubbles reuse the desktop's markup and
// classes on purpose — history written at the desk is MDX, and the MDX layer
// (render/components/ActionContext) touches no `window.stem`, so charts, quizzes
// and forms render here exactly as they do there. What is missing is the hover
// action rail (Retry / Edit / Fork / Delete): it is a pointer affordance, and
// turn surgery is not what a phone is for.

const AVATAR: Record<ChatMessage['role'], { cls: string; icon: ReactNode; label: string }> = {
  user: { cls: 'you', icon: <User size={14} />, label: 'You' },
  assistant: { cls: 'stem', icon: <Sparkles size={14} />, label: 'Stem' },
  system: { cls: 'sys', icon: <AlertTriangle size={14} />, label: 'Error' }
};

export function ThreadView({
  title,
  threadId,
  notice,
  messages,
  running,
  streamingId,
  activity,
  activities,
  onBack,
  onSend,
  onInterrupt
}: {
  title: string;
  /** The persisted thread, or null for a chat whose first turn hasn't landed. */
  threadId: string | null;
  /** Why this transcript may be incomplete (a failed read), if it is. */
  notice: string | null;
  messages: ChatMessage[];
  running: boolean;
  streamingId: string | null;
  activity: string | null;
  activities: ActivityItem[];
  onBack: () => void;
  onSend: (text: string, attachments: TurnAttachment[]) => void;
  onInterrupt: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  /** The read-only "what did it remember?" disclosure; closed by default. */
  const [showMemory, setShowMemory] = useState(false);
  // Keyed by thread in MobileApp, so this component remounts on every switch:
  // jump to the bottom on the first paint, smooth-scroll only while streaming.
  const didInitialScroll = useRef(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: didInitialScroll.current ? 'smooth' : 'auto' });
    didInitialScroll.current = true;
  }, [messages, running]);

  // Interactive MDX (Quiz/Form) submits through the normal send path, so its
  // answer appears in the transcript exactly as if it had been typed.
  const mdxActions = useMemo(
    () => ({ submit: (text: string) => onSend(text, []), running }),
    [onSend, running]
  );

  const streamingMsg = messages.find((m) => m.id === streamingId);
  // The working indicator belongs on screen whenever a turn runs with no answer
  // text yet — reasoning and tool calls happen before the first token.
  const showActivity = running && !(streamingMsg && streamingMsg.content);

  const activityIndicator = (
    <div className="activity" role="status" aria-live="polite">
      <span className="activity-dots" aria-hidden="true">
        <span className="activity-dot" />
        <span className="activity-dot" />
        <span className="activity-dot" />
      </span>
      <span className="activity-label">{activity ?? 'Working…'}</span>
    </div>
  );

  const renderMessage = (m: ChatMessage): ReactNode => {
    const a = AVATAR[m.role];
    const isStreaming = m.id === streamingId;
    // Finalized assistant replies render as MDX. A streaming one stays plain
    // text until it settles: mobile turns are always `format: 'mdx'`, and a
    // half-written JSX tag would flicker if it were parsed mid-stream (the
    // desktop does exactly the same for MDX — see ChatView's renderRich).
    const rich = m.role === 'assistant' && !isStreaming && !!m.content;
    return (
      <div key={m.id} className={`message message-${m.role}`}>
        <div className={`msg-avatar ${a.cls}`}>{a.icon}</div>
        <div className="message-body">
          <div className="message-who">{a.label}</div>
          {m.role === 'assistant' && (m.activity?.length ?? 0) > 0 && (
            <ActivityRows items={m.activity!} running={running && isStreaming} />
          )}
          {rich ? (
            <MdxView text={m.content} />
          ) : isStreaming && !m.content && showActivity ? (
            activityIndicator
          ) : (
            <div className="message-plain">{m.content}</div>
          )}
          {m.role === 'assistant' && (m.sources?.length ?? 0) > 0 && <SourcesList sources={m.sources!} />}
          {m.attachments && m.attachments.length > 0 && (
            <div className="message-attachments">
              {m.attachments.map((att, i) =>
                att.kind === 'image' && att.dataUrl ? (
                  <img key={i} className="message-image" src={att.dataUrl} alt={att.name ?? 'attachment'} />
                ) : (
                  <span className="attachment-chip" key={i}>
                    <File size={13} />
                    <span className="attachment-name">{att.name ?? 'file'}</span>
                  </span>
                )
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <MdxActionContext.Provider value={mdxActions}>
      <header className="m-head">
        <button type="button" className="m-head-btn" aria-label="Back to chats" onClick={onBack}>
          <ChevronLeft size={20} />
        </button>
        <h1 className="m-title">{title}</h1>
        {threadId && (
          <button
            type="button"
            className={`m-head-btn${showMemory ? ' on' : ''}`}
            aria-label="What Stem remembered"
            aria-pressed={showMemory}
            onClick={() => setShowMemory((open) => !open)}
          >
            <Brain size={18} />
          </button>
        )}
      </header>
      {threadId && showMemory && <MemoryPeek threadId={threadId} running={running} />}
      <div className="m-scroll m-messages">
        {notice && (
          <p className="m-notice" role="status">
            {notice}
          </p>
        )}
        {messages.length === 0 && !notice && (
          <p className="m-empty">Ask Stem anything — it remembers what matters across chats.</p>
        )}
        {messages.map(renderMessage)}
        {showActivity && !streamingMsg && (
          <div className="message message-assistant">
            <div className="msg-avatar stem">{AVATAR.assistant.icon}</div>
            <div className="message-body">
              {activities.length > 0 && <ActivityRows items={activities} running />}
              {/* The generic dots only when no tool row is already pulsing. */}
              {!activities.some((x) => x.status === 'running') && activityIndicator}
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <Composer running={running} onSend={onSend} onInterrupt={onInterrupt} />
    </MdxActionContext.Provider>
  );
}
