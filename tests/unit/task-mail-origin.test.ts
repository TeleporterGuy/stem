// schedule_task called from a mail persona's hidden session. Runs used to append
// to the task's chat, so a task made from a hidden session needed a visible chat
// adopted for it (and a boot-time pass to move old ones). Every run now gets a
// thread of its own, so the bridge binds the task to wherever it was called from
// — a chat or a hidden session alike — and adopts nothing.
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const STORE = join(tmpdir(), `stem-tasks-origin-${process.pid}.json`);
process.env.STEM_TASKS_STORE = STORE;

import type { ChatBackend } from '../../src/server/backend';
import type { TaskBridge } from '../../src/server/backend/types';
import { initTaskScheduler } from '../../src/server/startup/scheduler';
import { createConversation, setConversationSession } from '../../src/server/workspace/mail';
import { mailStorePath } from '../../src/server/workspace/paths';
import { readTasks } from '../../src/server/workspace/tasks';

class FakeRuntime extends EventEmitter {
  bridge: TaskBridge | null = null;
  created: string[] = [];
  deleted: string[] = [];
  starts = 0;
  /** Runs inside the turn — after startTurn resolved, before it settles. */
  duringTurn: ((threadId: string) => Promise<void>) | null = null;
  setTaskBridge(bridge: TaskBridge | null) {
    this.bridge = bridge;
  }
  async createThread() {
    const id = `chat-${this.created.length + 1}`;
    this.created.push(id);
    return id;
  }
  async deleteThread(threadId: string) {
    this.deleted.push(threadId);
  }
  async startTurn() {
    const n = ++this.starts;
    const threadId = `run-${n}`;
    const turnId = `turn-${n}`;
    setTimeout(async () => {
      await this.duringTurn?.(threadId);
      this.emit('event', { method: 'turn/completed', params: { threadId, turn: { id: turnId } } });
    }, 0);
    return { threadId, turnId };
  }
}

function wire(
  runtime: FakeRuntime,
  opts: { taskRunThreadIds?: (taskId: string) => Promise<string[]>; deliverTaskMail?: () => Promise<string | void> } = {}
) {
  return initTaskScheduler({
    runtime: runtime as unknown as ChatBackend,
    emit: () => {},
    isUserActive: () => false,
    revealMainWindow: () => {},
    requestAttention: () => {},
    deliverTaskMail: opts.deliverTaskMail ?? (async () => {}),
    ...(opts.taskRunThreadIds ? { taskRunThreadIds: opts.taskRunThreadIds } : {})
  });
}

const settled = (runtime: FakeRuntime) => new Promise<void>((r) => setTimeout(r, 30)).then(() => runtime);

const mailPath = mailStorePath();
beforeEach(() => {
  mkdirSync(dirname(mailPath), { recursive: true });
  rmSync(mailPath, { force: true });
  rmSync(STORE, { force: true });
});
afterEach(() => {
  rmSync(mailPath, { force: true });
  rmSync(STORE, { force: true });
});

describe('schedule_task through the bridge', () => {
  it('from a mail session: binds to that session, adopts no chat, and list_tasks there finds it', async () => {
    const conversation = await createConversation('Create a schedule', ['secretary']);
    await setConversationSession(conversation.id, 'secretary', 'secretary-session');
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);

    const res = await runtime.bridge!.schedule({ prompt: 'Every morning review the latest email and draft replies', cron: '0 8 * * *' }, 'secretary-session');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.task.threadId).toBe('secretary-session');
    expect(runtime.created).toEqual([]);
    expect((await runtime.bridge!.listForThread('secretary-session')).map((t) => t.id)).toEqual([res.task.id]);
    expect((await readTasks())[0].threadId).toBe('secretary-session');
    scheduler.stop();
  });

  it('refuses a bad request and writes nothing', async () => {
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);
    const res = await runtime.bridge!.schedule({ prompt: 'x', cron: 'nope' }, 'plain-chat');
    expect(res.ok).toBe(false);
    expect(await readTasks()).toEqual([]);
    scheduler.stop();
  });

  it('from a chat: binds to the chat, and the persona asked for runs it', async () => {
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);
    const res = await runtime.bridge!.schedule({ prompt: 'watch the build', cron: '0 8 * * *', personaId: 'verifier' }, 'plain-chat');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.task.threadId).toBe('plain-chat');
    expect(res.task.runsAs).toEqual({ kind: 'persona', personaId: 'verifier' });
    scheduler.stop();
  });

  it('cancel_task deletes the task and the threads its mail-sending runs left behind', async () => {
    const runtime = new FakeRuntime();
    const asked: string[] = [];
    const scheduler = wire(runtime, {
      taskRunThreadIds: async (taskId) => {
        asked.push(taskId);
        return ['run-a', 'run-b'];
      }
    });
    const res = await runtime.bridge!.schedule({ prompt: 'watch', cron: '0 8 * * *' }, 'plain-chat');
    if (!res.ok) throw new Error(res.error);
    expect(await runtime.bridge!.cancel(res.task.id)).toEqual({ ok: true });
    expect(asked).toEqual([res.task.id]);
    expect(runtime.deleted.sort()).toEqual(['run-a', 'run-b']);
    expect(await runtime.bridge!.cancel(res.task.id)).toMatchObject({ ok: false });
    scheduler.stop();
  });

  it('notify_user keeps the run thread only once its mail has landed; a dropped mail leaves nothing orphaned', async () => {
    for (const landed of [true, false]) {
      const runtime = new FakeRuntime();
      const scheduler = wire(runtime, {
        deliverTaskMail: async () => {
          if (!landed) throw new Error('mail store unwritable');
          return 'conversation-1';
        }
      });
      const res = await runtime.bridge!.schedule({ prompt: 'watch', cron: '0 8 * * *' }, 'plain-chat');
      if (!res.ok) throw new Error(res.error);
      runtime.duringTurn = (threadId) => runtime.bridge!.notify({ title: 'Found', message: 'it' }, threadId);
      scheduler.runNow(res.task.id);
      await settled(runtime);
      // Mail landed → the thread is the mail's now. Mail dropped → the thread
      // would be reachable from nowhere, so it goes like a silent run's.
      expect(runtime.deleted).toEqual(landed ? [] : ['run-1']);
      scheduler.stop();
    }
  });
});
