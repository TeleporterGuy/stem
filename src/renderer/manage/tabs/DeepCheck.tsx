import { useEffect, useSyncExternalStore } from 'react';
import { Mail, ScanSearch } from 'lucide-react';
import type { MemoryCheckJob } from '../../../shared/types';

// The deep check: reads every fact learned from chats with where it came from,
// fixes what it can prove, and mails the rest as questions. The run lives on
// the server (minutes on a big store), so this only starts it and polls; the
// state is module-level so a tab switch mid-run still shows it.
//
// It is the one memory job worth starting by hand (tidy-up runs by itself as
// Stem learns), so the Memory tab gives it a card of its own near the top,
// with what the last run found and how much of it still waits on you.

let job: MemoryCheckJob = { running: false };
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function set(next: MemoryCheckJob): void {
  job = next;
  for (const l of listeners) l();
  if (job.running && !timer) {
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, 2000);
  }
}

async function poll(): Promise<void> {
  try {
    set(await window.stem.memoryCheckJob());
  } catch {
    // quiet: the next poll (or the next visit) asks again.
    if (job.running) set(job);
  }
}

function useMemoryCheckJob(): MemoryCheckJob {
  // Every visit asks again: the last check's open questions shrink as you
  // answer them in the mail, and the card should say so when you come back.
  useEffect(() => {
    void poll();
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => job
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DeepCheckCard({
  disabled,
  onOpenMail
}: {
  disabled: boolean;
  onOpenMail?: (conversationId: string) => void;
}) {
  const current = useMemoryCheckJob();
  const start = async () => {
    try {
      set(await window.stem.startMemoryCheck());
    } catch (err) {
      set({ running: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
  const last = current.last;
  const waiting = last ? last.openQuestions + last.openProposals : 0;
  const mailId = last?.conversationId;

  return (
    <div className="group deep-check-card">
      <div className="deep-check-head">
        <span className="deep-check-icon" aria-hidden="true">
          <ScanSearch size={16} className={current.running ? 'spin' : undefined} />
        </span>
        <span className="row-main">
          <strong>{current.running ? 'Checking your memory…' : 'Deep check'}</strong>
          <em>
            {current.running
              ? `${current.total ? `${current.done ?? 0} of ${current.total} groups read. ` : ''}You can leave — the findings arrive as a mail.`
              : 'Reads every fact with where it came from, fixes what it can prove, and mails you questions about the rest. Takes a few minutes.'}
          </em>
        </span>
      </div>
      {current.running && current.total ? (
        <div className="deep-check-bar" role="progressbar" aria-valuemin={0} aria-valuemax={current.total} aria-valuenow={current.done ?? 0}>
          <span style={{ width: `${Math.round(((current.done ?? 0) / current.total) * 100)}%` }} />
        </div>
      ) : null}
      {!current.running && last && (
        <div className="deep-check-stats">
          <span>
            <b>{last.fixed}</b> fixed
          </span>
          <span className={last.openQuestions ? 'open' : undefined}>
            <b>{last.openQuestions ? `${last.openQuestions} of ${last.questions}` : last.questions}</b>{' '}
            {last.openQuestions ? 'questions open' : last.questions === 1 ? 'question' : 'questions'}
          </span>
          <span className={last.openProposals ? 'open' : undefined}>
            <b>{last.openProposals}</b> {last.openProposals === 1 ? 'proposal' : 'proposals'} open
          </span>
        </div>
      )}
      {!current.running && current.error && <p className="retrieval-status-error">The last check failed: {current.error}</p>}
      <div className="deep-check-foot">
        <span className="muted">
          {current.running
            ? current.startedAt
              ? `Started ${new Date(current.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : ''
            : last
              ? `Last run ${new Date(last.startedAt).toLocaleDateString()} · ${plural(last.factCount, 'fact', 'facts')} read`
              : 'Not run yet.'}
        </span>
        <span className="deep-check-actions">
          {!current.running && mailId && onOpenMail && (
            <button type="button" className={`push${waiting ? ' default' : ''}`} onClick={() => onOpenMail(mailId)}>
              <Mail size={13} /> {waiting ? 'Answer in mail' : 'Open mail'}
            </button>
          )}
          <button
            type="button"
            className={`push${waiting ? '' : ' default'}`}
            onClick={() => void start()}
            disabled={disabled || current.running}
          >
            {current.running ? 'Running…' : last ? 'Run again' : 'Run check'}
          </button>
        </span>
      </div>
    </div>
  );
}
