import { app } from 'electron';
import { TaskScheduler } from '../scheduler';
import type { ChatBackend } from '../backend';

/**
 * Scheduled tasks: re-run a chat's prompt as an autonomous turn on a cron/once
 * schedule. The scheduler owns timing + execution; the backend routes the
 * assistant's schedule_task/notify_user tools to it via the TaskBridge wired
 * here.
 */
export function initTaskScheduler(deps: {
  runtime: ChatBackend;
  sendToMain: (channel: string, payload: unknown) => void;
  /** Turn in flight on either surface, or interaction in the last couple of minutes. */
  isUserActive: () => boolean;
  /** Raise + focus the main window (notify_user prominence). */
  revealMainWindow: () => void;
}): TaskScheduler {
  const scheduler = new TaskScheduler({
    runtime: deps.runtime,
    onChange: (tasks) => deps.sendToMain('tasks:changed', tasks),
    onRun: (run) => deps.sendToMain('tasks:run', run),
    // Scheduled runs defer while the user is active, and an in-flight scheduled
    // run yields (preemptForUser) when the user sends a message.
    isUserActive: deps.isUserActive,
    interrupt: (turnId) => deps.runtime.interruptTurn(turnId)
  });
  deps.runtime.setTaskBridge({
    schedule: (req, threadId) => scheduler.create(req, threadId),
    listForThread: async (threadId) => scheduler.listForThread(threadId),
    cancel: async (taskId) => {
      const before = scheduler.snapshot().length;
      await scheduler.remove(taskId);
      return scheduler.snapshot().length < before ? { ok: true } : { ok: false, error: 'No such task.' };
    },
    // notify_user: surface a prominent in-app alert — raise + focus the main window,
    // bounce the dock, and show the alert modal. Native OS notifications were judged
    // not prominent enough for watch-style tasks.
    notify: async ({ title, message }, threadId) => {
      deps.revealMainWindow();
      app.dock?.bounce('critical');
      deps.sendToMain('tasks:notify', {
        threadId,
        title,
        message,
        at: new Date().toISOString()
      });
    }
  });
  return scheduler;
}
