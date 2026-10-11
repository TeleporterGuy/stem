import { useEffect, useState, useSyncExternalStore } from 'react';
import type { MemoryCheckAction, MemoryCheckChangeStatus } from '../../shared/types';

// <FactChange>: one change a memory check made to a fact, or proposes. The
// mail carries what the change is (the fact, why, the quote that proves it);
// its status is read live from the server, so an Undo pressed on another
// device, or yesterday, shows here. The buttons act at once: each change is
// independent and needs no model, so nothing waits for a Send.

type Status = MemoryCheckChangeStatus;

interface CheckStates {
  states: Map<string, Status>;
  loading: boolean;
}

const cache = new Map<string, CheckStates>();
const listeners = new Set<() => void>();
let version = 0;
let subscribed = false;

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

async function refresh(checkId: string): Promise<void> {
  const entry = cache.get(checkId) ?? { states: new Map(), loading: true };
  cache.set(checkId, entry);
  try {
    const states = await window.stem.memoryCheckState(checkId);
    cache.set(checkId, { states: new Map(states.map((s) => [s.id, s.status])), loading: false });
  } catch {
    // quiet: the card falls back to the status the mail was written with.
    cache.set(checkId, { ...entry, loading: false });
  }
  notify();
}

function useCheckStatus(checkId: string, changeId: string, initial: Status): Status {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => version
  );
  useEffect(() => {
    if (!subscribed && window.stem?.onMemoryCheckChanged) {
      subscribed = true;
      window.stem.onMemoryCheckChanged((id) => {
        if (cache.has(id)) void refresh(id);
      });
    }
    if (checkId && !cache.has(checkId)) void refresh(checkId);
  }, [checkId]);
  return cache.get(checkId)?.states.get(changeId) ?? initial;
}

const STATUSES: Status[] = ['applied', 'undone', 'proposed', 'dismissed', 'removed', 'ended'];

export function FactChange(props: Record<string, string>) {
  const { check = '', change = '', fact, label, kind, text, reason, quote } = props;
  const initial = STATUSES.includes(props.status as Status) ? (props.status as Status) : 'applied';
  const status = useCheckStatus(check, change, initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: MemoryCheckAction) => {
    setBusy(true);
    setError(null);
    try {
      const states = await window.stem.actOnMemoryCheckChange(check, change, action);
      cache.set(check, { states: new Map(states.map((s) => [s.id, s.status])), loading: false });
      notify();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saved = kind === 'save';
  const ongoing = props.ongoing === 'true';
  let pill: string;
  let tone: 'done' | 'open' | 'off';
  let gone: boolean;
  let buttons: Array<{ label: string; action: MemoryCheckAction; primary?: boolean }>;
  switch (status) {
    case 'applied':
      pill = label && !label.endsWith('?') ? label : saved ? 'Saved' : 'Retired';
      tone = 'done';
      gone = !saved;
      buttons = [{ label: 'Undo', action: 'undo' }];
      break;
    case 'undone':
      pill = saved ? 'Not saved' : 'Restored';
      tone = 'off';
      gone = saved;
      buttons = [{ label: 'Redo', action: 'redo' }];
      break;
    case 'ended':
      pill = 'Ended';
      tone = 'done';
      gone = true;
      buttons = [{ label: 'Undo', action: 'undo' }];
      break;
    case 'proposed':
      // Something that runs for a while: it may have been true and stopped.
      pill = ongoing ? 'Still current?' : 'Retire?';
      tone = 'open';
      gone = false;
      buttons = ongoing
        ? [
            { label: 'Still current', action: 'dismiss' },
            { label: 'Never true', action: 'apply' },
            { label: 'Ended', action: 'end', primary: true }
          ]
        : [
            { label: 'Keep', action: 'dismiss' },
            { label: 'Retire', action: 'apply', primary: true }
          ];
      break;
    case 'removed':
      // The fact is gone (its folder was disconnected): nothing left to act on.
      pill = 'Removed';
      tone = 'off';
      gone = true;
      buttons = [];
      break;
    default:
      pill = 'Kept';
      tone = 'off';
      gone = false;
      buttons = [{ label: 'Undo', action: 'reopen' }];
  }

  return (
    <div className="fact-change">
      <div className="fact-change-main">
        <div className="fact-change-top">
          <span className={`fact-change-pill ${tone}`}>{pill}</span>
          {fact && <span className="fact-change-id">#{fact}</span>}
        </div>
        <div className={`fact-change-text${gone ? ' gone' : ''}`}>{text}</div>
        {(reason || quote) && (
          <div className="fact-change-why">
            {reason}
            {quote && <q>{quote}</q>}
          </div>
        )}
        {error && <div className="fact-change-error">{error}</div>}
      </div>
      {check && change && buttons.length > 0 && (
        <div className="fact-change-acts">
          {buttons.map((b) => (
            <button
              key={b.action}
              type="button"
              className={`fact-change-btn${b.primary ? ' primary' : ''}`}
              disabled={busy}
              onClick={() => void act(b.action)}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
