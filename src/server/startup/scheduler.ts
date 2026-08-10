import { TaskScheduler } from '../scheduler';
import { noteSilentRun } from '../workspace/inbox';
import { readSettings } from '../workspace/settings';
import type { ChatBackend } from '../backend';

/**
 * Scheduled tasks: re-run a chat's prompt as an autonomous turn on a cron/once
 * schedule. The scheduler owns timing + execution; the backend routes the
 * assistant's schedule_task/notify_user tools to it via the TaskBridge wired
 * here.
 */
export function initTaskScheduler(deps: {
  runtime: ChatBackend;
  /** Push on a client channel — the task feed and notify_user alerts. */
  emit: (channel: string, payload: unknown) => void;
  /** Turn in flight on either surface, or interaction in the last couple of minutes. */
  isUserActive: () => boolean;
  /** Raise + focus the main window (notify_user prominence). */
  revealMainWindow: () => void;
  /** OS-level attention nudge (dock bounce / taskbar flash — see platform.ts). */
  requestAttention: () => void;
}): TaskScheduler {
  const scheduler = new TaskScheduler({
    runtime: deps.runtime,
    onChange: (tasks) => deps.emit('tasks:changed', tasks),
    onRun: (run) => deps.emit('tasks:run', run),
    // Scheduled runs defer while the user is active, and an in-flight scheduled
    // run yields (preemptForUser) when the user sends a message.
    isUserActive: deps.isUserActive,
    interrupt: (turnId) => deps.runtime.interruptTurn(turnId),
    // A run that found nothing still wrote a turn, and a written turn is all the
    // Inbox needs to lift the thread back out of the archive and bold the row.
    // Absorb the bump so a watch task only reappears on the run that had something
    // to say, then ask the client for a fresh list (the placement changed under it).
    onSilentRun: (threadId, before, at) => {
      void noteSilentRun(threadId, before, at)
        .then(() => deps.emit('chats:changed', undefined))
        .catch(() => undefined);
    }
  });
  deps.runtime.setTaskBridge({
    schedule: (req, threadId) => scheduler.create(req, threadId),
    listForThread: async (threadId) => scheduler.listForThread(threadId),
    cancel: async (taskId) => {
      const before = scheduler.snapshot().length;
      await scheduler.remove(taskId);
      return scheduler.snapshot().length < before ? { ok: true } : { ok: false, error: 'No such task.' };
    },
    // notify_user: how loudly this lands is the user's call (settings.tasks.notify).
    // `alert`, the default, is the full treatment — raise + focus the main window,
    // nudge at the OS level (dock bounce / taskbar flash), and show the alert modal;
    // native OS notifications were judged not prominent enough for watch-style tasks.
    // `nudge` keeps only the OS nudge, `inbox` interrupts not at all.
    //
    // What every mode keeps is the Inbox: the noteNotify below is the run's
    // declaration that it found something, so its turn stays out of onSilentRun and
    // the chat surfaces as an unread row on its own. That is the whole of `inbox`
    // mode — there is nothing extra to emit, because a written turn is already the
    // signal the Inbox reads.
    notify: async ({ title, message }, threadId) => {
      scheduler.noteNotify(threadId);
      // Read per notification rather than once at wiring time: a task fires long
      // after startup, and the toggle must apply to the very next run.
      const mode = (await readSettings().catch(() => null))?.tasks.notify ?? 'alert';
      if (mode === 'inbox') return;
      if (mode === 'alert') deps.revealMainWindow();
      deps.requestAttention();
      if (mode === 'nudge') return;
      deps.emit('tasks:notify', {
        threadId,
        title,
        message,
        at: new Date().toISOString()
      });
    }
  });
  return scheduler;
}
