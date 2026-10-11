import { useEffect, useSyncExternalStore } from 'react';
import { ScanSearch } from 'lucide-react';
import type { MemoryCheckJob } from '../../../shared/types';

// The deep check: reads every fact learned from chats with where it came from,
// fixes what it can prove, and mails the rest as questions. The run lives on
// the server (minutes on a big store), so this only starts it and polls; the
// state is module-level so a tab switch mid-run still shows it.

let job: MemoryCheckJob = { running: false };
let seen = false;
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
  useEffect(() => {
    if (!seen) {
      seen = true;
      void poll();
    }
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => job
  );
}

export function DeepCheckButton({ disabled }: { disabled: boolean }) {
  const current = useMemoryCheckJob();
  const start = async () => {
    try {
      set(await window.stem.startMemoryCheck());
    } catch (err) {
      set({ running: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
  return (
    <button
      className="link-btn icon-only"
      onClick={() => void start()}
      disabled={disabled || current.running}
      data-label={current.running ? 'Checking…' : 'Deep check'}
      aria-label="Deep check: read every fact with where it came from, fix what is clearly wrong, and mail you questions about the rest"
    >
      <ScanSearch size={15} className={current.running ? 'spin' : undefined} />
    </button>
  );
}

export function DeepCheckStatus({ onOpenMail }: { onOpenMail?: (conversationId: string) => void }) {
  const current = useMemoryCheckJob();
  if (current.running) {
    const progress = current.total ? ` ${current.done ?? 0} of ${current.total} groups read.` : '';
    return <p className="muted">Deep check running.{progress} Its findings arrive as a mail.</p>;
  }
  if (current.error) return <p className="muted">The deep check failed: {current.error}</p>;
  if (current.conversationId) {
    const id = current.conversationId;
    return (
      <p className="muted">
        Deep check finished.{' '}
        {onOpenMail ? (
          <button type="button" className="link-btn" onClick={() => onOpenMail(id)}>
            Open the mail
          </button>
        ) : (
          'Its findings are in the Inbox.'
        )}
      </p>
    );
  }
  return null;
}
