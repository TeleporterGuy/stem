// A reopened chat gets back each turn's persisted rows (answer timing, tool
// activity + web sources, system stamp). recordTurnEntry keys them by the turn's
// USER entry id, the only id get_fork_messages hands it; the rebuild looked them
// up by the assistant entry id, so a chat lost its timing and tok/s the moment
// the user switched away and came back.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiRuntime } from '../../src/server/pi/runtime';
import { recallStore as store } from '../../src/server/recall/store';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const TURN = '0b7c4e2a-1d3f-4a5b-9c8d-7e6f5a4b3c2d';
const sys = { persona: 'aaaaaaaaaaaa', skills: 'bbbbbbbbbbbb', memory: 'cccccccccccc' };
const timing = { totalMs: 4200, thinkingMs: 900, toolMs: 0, answerMs: 2000, ttftMs: 700, buildMs: 40, recallMs: 30 };

async function reopen(threadId: string, userText: string) {
  const root = await mkdtemp(join(tmpdir(), 'stem-turn-rows-'));
  cleanup.push(root);
  const piHome = join(root, 'pi');
  const sessions = join(piHome, 'sessions');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(sessions, { recursive: true }), mkdir(workspace, { recursive: true })]);
  const runtime = new PiRuntime({ piHome, sessionsDir: sessions, workspaceRoot: workspace, seedGlobalAuth: false });
  const usage = { input: 100, output: 400, cacheRead: 0, cacheWrite: 0, totalTokens: 500 };
  const lines = [
    { type: 'session', id: threadId, timestamp: '2026-10-01T19:48:00.000Z', cwd: '/tmp' },
    { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: userText }] } },
    {
      type: 'message',
      id: 'a1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Let me check.' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }],
        stopReason: 'toolUse',
        usage
      }
    },
    { type: 'message', id: 'r1', message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'a b' }] } },
    { type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'Two files.' }], stopReason: 'stop', usage } }
  ];
  await writeFile(join(sessions, `${threadId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
  // Keyed exactly as recordTurnEntry writes them: by the user entry.
  store.upsertTurnTiming({ turnEntryId: 'u1', threadId, ...timing });
  store.upsertTurnSystem({ turnEntryId: 'u1', threadId, sys });
  store.upsertTurnActivity({
    turnEntryId: 'u1',
    threadId,
    payload: { activity: [{ id: 'c1', kind: 'tool', type: 'bash', status: 'ok' }], sources: [{ url: 'https://example.com', title: 'Example' }] }
  });
  return (await runtime.readThread(threadId)).messages.filter((m) => m.role === 'assistant');
}

describe('reopened turn rows', () => {
  it('a turn with a runtime id gets its timing, activity, sources and stamp back', async () => {
    const [answer, ...rest] = await reopen('rows-aggregate', `<!--stem:context-->\n<!--stem:turn id="${TURN}"-->\nList files`);
    expect(rest).toEqual([]);
    expect(answer.timing).toEqual(timing);
    expect(answer.usage?.output).toBe(400);
    expect(answer.meta?.sys).toEqual(sys);
    expect(answer.activity?.map((a) => a.id)).toEqual(['c1']);
    expect(answer.sources?.map((s) => s.url)).toEqual(['https://example.com']);
  });

  it('a turn rebuilt as several bubbles keeps the rows on its last one only', async () => {
    const [first, last] = await reopen('rows-legacy', 'List files');
    expect(first.content).toBe('Let me check.');
    expect(first.timing).toBeUndefined();
    expect(first.meta?.sys).toBeUndefined();
    expect(first.activity).toBeUndefined();
    expect(first.sources).toBeUndefined();
    expect(last.content).toBe('Two files.');
    expect(last.timing).toEqual(timing);
    expect(last.meta?.sys).toEqual(sys);
    expect(last.sources?.map((s) => s.url)).toEqual(['https://example.com']);
  });
});
