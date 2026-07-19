import { useEffect, useState } from 'react';
import { Trash2, Play, Pause, ExternalLink } from 'lucide-react';
import type {
  ScheduledTask
} from '../../../shared/types';

// ---- Tasks tab: scheduled autonomous re-runs ----

/** Human-readable schedule, e.g. "cron 0 8 * * 1-5" or "once · Jul 1, 08:00". */
function describeSchedule(task: ScheduledTask): string {
  if (task.schedule.kind === 'cron') return `cron · ${task.schedule.expr}`;
  return `once · ${formatWhen(task.schedule.at)}`;
}

/** Compact local datetime, e.g. "Jul 1, 08:00". */
function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function TasksTab({ onOpenChat }: { onOpenChat: (threadId: string) => void }) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  // Task prompts can be long; show a clamped preview and let the row expand in place.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    window.stem.listTasks().then(setTasks);
    // Stay in sync as runs fire / the assistant schedules new tasks.
    return window.stem.onTasksChanged(setTasks);
  }, []);

  const toggle = async (t: ScheduledTask) => setTasks(await window.stem.setTaskEnabled(t.id, !t.enabled));
  const runNow = async (t: ScheduledTask) => setTasks(await window.stem.runTaskNow(t.id));
  const remove = async (t: ScheduledTask) => setTasks(await window.stem.deleteTask(t.id));

  return (
    <div>
      <div className="grp-head">Scheduled tasks</div>
      {tasks.length === 0 ? (
        <p className="muted">
          No scheduled tasks yet. Ask Stem in a chat to do something on a schedule — “every weekday
          at 8, summarize my unread email” or “check this page hourly and let me know if it changes”.
          The task runs in that chat and only interrupts you when there’s something worth seeing.
        </p>
      ) : (
        <div className="group">
          {tasks.map((t) => (
            <div key={t.id} className={`task-item${t.enabled ? '' : ' paused'}`}>
              <div className="task-head">
                <span className="row-main">
                  <strong
                    className={`task-title${expanded.has(t.id) ? ' expanded' : ''}`}
                    onClick={() => toggleExpanded(t.id)}
                    title={expanded.has(t.id) ? 'Collapse' : 'Show the full task'}
                  >
                    {t.prompt}
                  </strong>
                  <em>{describeSchedule(t)}</em>
                </span>
                <button
                  className="icon-action sm"
                  onClick={() => onOpenChat(t.threadId)}
                  title="Open the chat this task runs in"
                  aria-label="Open chat"
                >
                  <ExternalLink size={14} />
                </button>
                <button
                  className="icon-action sm"
                  onClick={() => runNow(t)}
                  title="Run now"
                  aria-label="Run now"
                  disabled={t.lastStatus === 'running'}
                >
                  <Play size={14} />
                </button>
                <button
                  className="icon-action sm"
                  onClick={() => toggle(t)}
                  title={t.enabled ? 'Pause' : 'Resume'}
                  aria-label={t.enabled ? 'Pause' : 'Resume'}
                >
                  {t.enabled ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button
                  className="icon-action sm"
                  onClick={() => remove(t)}
                  title="Delete task"
                  aria-label="Delete task"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="task-meta muted">
                {t.lastStatus === 'running' ? (
                  <span className="task-running">Running now…</span>
                ) : (
                  <>
                    {t.enabled ? (
                      <span>Next: {formatWhen(t.nextRunAt)}</span>
                    ) : (
                      <span>Paused</span>
                    )}
                    {t.lastRunAt && (
                      <span>
                        {' · '}Last: {formatWhen(t.lastRunAt)}
                        {t.lastStatus === 'failed' ? ' (failed)' : ''}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
