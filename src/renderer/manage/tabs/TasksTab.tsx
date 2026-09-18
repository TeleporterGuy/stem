import { useEffect, useState } from 'react';
import { Trash2, Play, Pause, ExternalLink } from 'lucide-react';
import type {
  ModelSummary,
  Persona,
  ScheduledTask,
  TaskRunsAs,
  TaskSchedule
} from '../../../shared/types';
import { ModelPicker } from '../../ui/ModelPicker';
import { clampEffort, effortsOf, EffortSelect } from '../../ui/EffortSelect';
import { EFFORT_LABELS } from '../../modelLabels';

// ---- Tasks tab: scheduled autonomous re-runs ----
//
// A row's face is the task's title, its schedule, and when it runs next. The
// whole task — the prompt every run re-executes, the schedule, who it runs as,
// and on what — is one editor the row expands into. The prompt used to BE the
// row (clamped to three lines, unclamped on click), which in the 320px rail
// turned a paragraph-long watch task into a screen of text with the controls
// scrolled out of sight, and left the persona picker folded behind a chip
// nobody found.

/** "as Critic" / "GPT-5.6 Sol · High" / "App default" — who and what a run of
 *  this task executes as. The collapsed face of the editor. */
function runsOnLabel(task: ScheduledTask, models: ModelSummary[], personas: Persona[]): string {
  const runsAs = task.runsAs;
  if (runsAs.kind === 'persona') return `as ${personas.find((p) => p.id === runsAs.personaId)?.name ?? runsAs.personaId}`;
  if (runsAs.kind === 'model') {
    const m = models.find((x) => x.id === runsAs.model);
    const name = m ? m.displayName : runsAs.model.split('/').pop() ?? runsAs.model;
    return runsAs.effort ? `${name} · ${EFFORT_LABELS[runsAs.effort] ?? runsAs.effort}` : name;
  }
  return 'App default';
}

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

/** The editor's text for a schedule: the cron expression, or a datetime-local value. */
function scheduleDraftOf(schedule: TaskSchedule): string {
  if (schedule.kind === 'cron') return schedule.expr;
  return toDatetimeLocal(schedule.at);
}

/** ISO → "YYYY-MM-DDTHH:mm" in local time, the value an <input type=datetime-local> takes. */
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TasksTab({
  onOpenChat,
  models
}: {
  onOpenChat: (threadId: string) => void;
  models: ModelSummary[];
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  // Rows switched to "a model" whose model is not picked yet: the picker shows
  // empty until a choice lands, and nothing is saved before then.
  const [pickingModel, setPickingModel] = useState<Set<string>>(new Set());
  // One expansion per row: the title, the schedule line and the "runs as" chip
  // all open the same editor. Most visits are a glance at next-run times, so
  // every row starts folded.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Prompt and schedule are typed then saved explicitly (Save/Revert), like the
  // persona editor: a half-typed cron must not arm anything, and a prompt saved
  // on every keystroke would rewrite tasks.json per character.
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const [scheduleDrafts, setScheduleDrafts] = useState<Record<string, string>>({});
  // The reason a save was refused (an unreachable cron, a datetime in the past),
  // shown under the field it came from.
  const [errors, setErrors] = useState<Record<string, string>>({});

  // For the "runs as" persona pin: the registry, loaded once per visit.
  const [personas, setPersonas] = useState<Persona[]>([]);

  useEffect(() => {
    window.stem.listTasks().then(setTasks);
    void window.stem.listPersonas().then(setPersonas);
    // Stay in sync as runs fire / the assistant schedules new tasks.
    return window.stem.onTasksChanged(setTasks);
  }, []);

  // The scheduler's own words, without Electron's "Error invoking remote
  // method '…': Error:" wrapper (same strip as ServerFolderPicker).
  const setError = (id: string, err: unknown | null) =>
    setErrors((prev) => {
      const next = { ...prev };
      const message =
        err == null ? '' : String((err as Error)?.message ?? err).replace(/^Error(?: invoking remote method '[^']*')?:\s*/, '');
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });
  const dropDraft = (drafts: Record<string, string>, id: string) => {
    const next = { ...drafts };
    delete next[id];
    return next;
  };

  const toggle = async (t: ScheduledTask) => setTasks(await window.stem.setTaskEnabled(t.id, !t.enabled));
  const runNow = async (t: ScheduledTask) => setTasks(await window.stem.runTaskNow(t.id));
  const remove = async (t: ScheduledTask) => setTasks(await window.stem.deleteTask(t.id));
  const setRunsAs = async (t: ScheduledTask, runsAs: TaskRunsAs) => {
    try {
      setTasks(await window.stem.updateTaskRunsAs(t.id, { runsAs }));
      setPickingModel((s) => {
        const next = new Set(s);
        next.delete(t.id);
        return next;
      });
      setError(t.id, null);
    } catch (err) {
      setError(t.id, err);
    }
  };
  // The one "runs as" choice, as the <select> sees it.
  const runsAsChoice = (t: ScheduledTask): string =>
    pickingModel.has(t.id) ? 'model' : t.runsAs.kind === 'persona' ? `persona:${t.runsAs.personaId}` : t.runsAs.kind;
  const chooseRunsAs = (t: ScheduledTask, choice: string) => {
    if (choice === 'default') return void setRunsAs(t, { kind: 'default' });
    if (choice.startsWith('persona:')) return void setRunsAs(t, { kind: 'persona', personaId: choice.slice('persona:'.length) });
    // "A model": nothing to save until one is picked below.
    if (t.runsAs.kind !== 'model') setPickingModel((s) => new Set(s).add(t.id));
  };
  const revertRewrite = async (t: ScheduledTask) => {
    setTasks(await window.stem.revertTaskRewrite(t.id));
    setPromptDrafts((d) => dropDraft(d, t.id));
  };
  const savePrompt = async (t: ScheduledTask) => {
    const prompt = promptDrafts[t.id];
    if (prompt === undefined) return;
    try {
      setTasks(await window.stem.updateTaskPrompt(t.id, { prompt }));
      setPromptDrafts((d) => dropDraft(d, t.id));
      setError(t.id, null);
    } catch (err) {
      setError(t.id, err);
    }
  };
  const saveSchedule = async (t: ScheduledTask) => {
    const draft = scheduleDrafts[t.id];
    if (draft === undefined) return;
    const schedule: TaskSchedule =
      t.schedule.kind === 'cron'
        ? { kind: 'cron', expr: draft.trim() }
        : { kind: 'once', at: draft ? new Date(draft).toISOString() : '' };
    try {
      setTasks(await window.stem.updateTaskSchedule(t.id, { schedule }));
      setScheduleDrafts((d) => dropDraft(d, t.id));
      setError(t.id, null);
    } catch (err) {
      setError(t.id, err);
    }
  };

  return (
    <div>
      <div className="grp-head">Scheduled tasks</div>
      {tasks.length === 0 ? (
        <p className="muted">
          No scheduled tasks yet. Ask Stem in a chat to do something on a schedule — “every weekday
          at 8, summarize my unread email” or “check this page hourly and let me know if it changes”.
          Each run starts fresh, and anything worth seeing arrives as mail in your Inbox.
        </p>
      ) : (
        <div className="group">
          {tasks.map((t) => {
            const isOpen = open.has(t.id);
            const pinnedModel = t.runsAs.kind === 'model' ? t.runsAs : null;
            const showModel = pickingModel.has(t.id) || pinnedModel !== null;
            const promptDraft = promptDrafts[t.id] ?? t.prompt;
            const promptDirty = promptDrafts[t.id] !== undefined && promptDrafts[t.id] !== t.prompt;
            const scheduleDraft = scheduleDrafts[t.id] ?? scheduleDraftOf(t.schedule);
            const scheduleDirty =
              scheduleDrafts[t.id] !== undefined && scheduleDrafts[t.id] !== scheduleDraftOf(t.schedule);
            return (
            <div key={t.id} className={`task-item${t.enabled ? '' : ' paused'}${isOpen ? ' open' : ''}`}>
              <div className="task-head">
                <span className="row-main">
                  <strong
                    className="task-title"
                    onClick={() => toggleOpen(t.id)}
                    title={isOpen ? 'Collapse' : 'Show and edit this task'}
                  >
                    {t.title}
                  </strong>
                  <em>{describeSchedule(t)}</em>
                </span>
                <button
                  className="icon-action sm"
                  onClick={() => onOpenChat(t.threadId)}
                  title="Open the chat this task was scheduled from"
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
                        {t.lastStatus === 'failed' && (
                          // The reason, not just the verdict: a row that says
                          // only "failed" leaves you nowhere to start.
                          <span className="task-failed" title={t.lastError ?? 'The run did not finish.'}>
                            {' (failed)'}
                          </span>
                        )}
                      </span>
                    )}
                  </>
                )}
                {' · '}
                <button
                  className="task-runs-on"
                  onClick={() => toggleOpen(t.id)}
                  title="Who this task runs as and on what model — click to change"
                  aria-expanded={isOpen}
                >
                  {runsOnLabel(t, models, personas)}
                </button>
              </div>
              {isOpen && (
              <div className="task-editor">
                {/* The instruction every run re-executes. Scrolls inside its own
                    box past ~10 lines so a long watch task stays a row, not a page. */}
                <label className="task-field">
                  <span className="task-field-label">Prompt</span>
                  <textarea
                    className="ci-textarea task-prompt"
                    aria-label="Task prompt"
                    rows={6}
                    value={promptDraft}
                    onChange={(e) => setPromptDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                  />
                </label>
                {promptDirty && (
                  <div className="push-row">
                    <button className="link-btn" onClick={() => setPromptDrafts((d) => dropDraft(d, t.id))}>
                      Revert
                    </button>
                    <button className="link-btn" onClick={() => savePrompt(t)} disabled={!promptDraft.trim()}>
                      Save prompt
                    </button>
                  </div>
                )}
                {/* Stem rewrote this prompt when runs moved into threads of their
                    own. The old one stays readable here until the user makes the
                    prompt theirs — by reverting, or by saving an edit. */}
                {t.rewritten && !promptDirty && (
                  <details className="task-rewritten">
                    <summary className="muted">
                      Rewritten by Stem on {formatWhen(t.rewritten.at)} to stand alone — runs no longer see the chat.{' '}
                      <button className="link-btn" onClick={(e) => { e.preventDefault(); void revertRewrite(t); }}>
                        Revert to the original
                      </button>
                    </summary>
                    <pre className="task-rewritten-original">{t.rewritten.original}</pre>
                  </details>
                )}
                <label className="task-field">
                  <span className="task-field-label">
                    {t.schedule.kind === 'cron' ? 'Schedule (cron: minute hour day month weekday)' : 'Runs once at'}
                  </span>
                  {t.schedule.kind === 'cron' ? (
                    <input
                      className="vfield task-schedule"
                      aria-label="Cron schedule"
                      value={scheduleDraft}
                      spellCheck={false}
                      onChange={(e) => setScheduleDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                    />
                  ) : (
                    <input
                      className="vfield task-schedule"
                      type="datetime-local"
                      aria-label="Run once at"
                      value={scheduleDraft}
                      onChange={(e) => setScheduleDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                    />
                  )}
                </label>
                {scheduleDirty && (
                  <div className="push-row">
                    <button className="link-btn" onClick={() => setScheduleDrafts((d) => dropDraft(d, t.id))}>
                      Revert
                    </button>
                    <button className="link-btn" onClick={() => saveSchedule(t)} disabled={!scheduleDraft.trim()}>
                      Save schedule
                    </button>
                  </div>
                )}
                {errors[t.id] && <div className="task-error">{errors[t.id]}</div>}
                {/* Runs AS — one choice: a persona (its worker, role prompt, memory
                    and model settings; its mails arrive from it), a model of the
                    task's own, or the app default. Never a persona AND a model:
                    the two used to coexist with the model silently ignored. */}
                <label className="task-field">
                  <span className="task-field-label">Runs as</span>
                  <select
                    className="vfield task-persona"
                    aria-label="Who or what this task runs as"
                    value={runsAsChoice(t)}
                    onChange={(e) => chooseRunsAs(t, e.target.value)}
                  >
                    <option value="default">App default model</option>
                    <option value="model">A model of its own…</option>
                    {personas.length > 0 && (
                      <optgroup label="Personas">
                        {personas.map((p) => (
                          <option key={p.id} value={`persona:${p.id}`}>
                            {p.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </label>
                {showModel && (
                  <div className="task-field">
                    <span className="task-field-label">Model</span>
                    <div className="task-model">
                      <ModelPicker
                        models={models}
                        value={pinnedModel?.model ?? null}
                        onChange={(id) => {
                          if (!id) return void setRunsAs(t, { kind: 'default' });
                          const effort = clampEffort(models, id, pinnedModel?.effort ?? null);
                          void setRunsAs(t, { kind: 'model', model: id, ...(effort ? { effort } : {}) });
                        }}
                        emptyLabel="Choose a model"
                        ariaLabel="Model this task runs on"
                      />
                      <EffortSelect
                        label="Effort this task runs at"
                        value={pinnedModel?.effort ?? null}
                        efforts={effortsOf(models, pinnedModel?.model ?? null)}
                        emptyLabel="Model default"
                        onChange={(effort) => {
                          if (!pinnedModel) return;
                          void setRunsAs(t, { kind: 'model', model: pinnedModel.model, ...(effort ? { effort } : {}) });
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
