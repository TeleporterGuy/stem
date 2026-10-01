// Message times shown in the chat gutter: a reopened chat reads them from the
// session entries, and a live reply is stamped when its turn/timing lands.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiRuntime } from '../../src/server/pi/runtime';
import { applyBackendEventToThread, EMPTY_STATE, type ThreadState } from '../../src/shared/chatState';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

describe('message times', () => {
  it('replay stamps the user message and the reply with their session entry times', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-message-times-'));
    cleanup.push(root);
    const piHome = join(root, 'pi');
    const sessions = join(piHome, 'sessions');
    const workspace = join(root, 'workspace');
    await Promise.all([mkdir(sessions, { recursive: true }), mkdir(workspace, { recursive: true })]);
    const runtime = new PiRuntime({ piHome, sessionsDir: sessions, workspaceRoot: workspace, seedGlobalAuth: false });
    const lines = [
      { type: 'session', id: 'times', timestamp: '2026-10-01T19:48:00.000Z', cwd: '/tmp' },
      { type: 'message', id: 'u1', timestamp: '2026-10-01T19:48:12.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Hi' }] } },
      { type: 'message', id: 'a1', timestamp: '2026-10-01T19:49:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }], stopReason: 'stop' } }
    ];
    await writeFile(join(sessions, 's.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
    const { messages } = await runtime.readThread('times');
    expect(messages.map((m) => [m.role, m.createdAt])).toEqual([
      ['user', '2026-10-01T19:48:12.000Z'],
      ['assistant', '2026-10-01T19:49:03.000Z']
    ]);
  });

  it('a live reply is stamped once, when its timing arrives', () => {
    const state: ThreadState = {
      ...EMPTY_STATE,
      messages: [{ id: 'assistant-t1', role: 'assistant', content: 'Hello.' }]
    };
    const timing = (totalMs: number) => ({
      method: 'turn/timing',
      params: {
        threadId: 'th', turnId: 't1', ensureMs: 0, buildMs: null, recall: { total: null },
        thinkingMs: 0, toolMs: 0, answerMs: 900, sendToFirstActivityMs: null,
        sendToFirstTokenMs: null, firstTokenToEndMs: null, totalMs
      }
    });
    const first = applyBackendEventToThread(state, timing(1000) as never)!;
    const stamped = first.messages[0].createdAt;
    expect(stamped && !Number.isNaN(Date.parse(stamped))).toBe(true);
    const again = applyBackendEventToThread({ ...first, messages: [{ ...first.messages[0], createdAt: '2026-01-01T00:00:00.000Z' }] }, timing(1100) as never)!;
    expect(again.messages[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
