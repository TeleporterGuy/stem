// Generated images on their way to the chat: normalize forwards a ref (never
// the bytes), the shared reducer puts it on the turn's bubble even when the
// model wrote no text, and a reopened chat rebuilds the same refs from the
// session file — which is also where chats:image reads the bytes from.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiRuntime } from '../../src/server/pi/runtime';
import { newTurnContext, normalizePiEvent } from '../../src/server/pi/normalize';
import { applyBackendEventToThread, type ThreadState } from '../../src/shared/chatState';
import type { BackendEventEnvelope } from '../../src/shared/types';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function tempRuntime() {
  const root = await mkdtemp(join(tmpdir(), 'stem-image-history-'));
  cleanup.push(root);
  const piHome = join(root, 'pi');
  const sessions = join(piHome, 'sessions');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(sessions, { recursive: true }), mkdir(workspace, { recursive: true })]);
  return { runtime: new PiRuntime({ piHome, sessionsDir: sessions, workspaceRoot: workspace, seedGlobalAuth: false }), sessions };
}

const BYTES = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const stemImage = { id: 'img_0a1b2c3d4e', mime: 'image/png', width: 1, height: 1, prompt: 'a sprout', revisedPrompt: 'A sprout' };

function toolResult(id = 'call-1') {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'generate_image',
    content: [{ type: 'text', text: 'Image img_0a1b2c3d4e created' }, { type: 'image', data: BYTES, mimeType: 'image/png' }],
    details: { stemImage },
    isError: false
  };
}

describe('normalize: generate_image events', () => {
  it('stamps startedAt, then forwards only the ref', () => {
    const ctx = newTurnContext('thread-1', 'turn-1');
    const started = normalizePiEvent(
      { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'generate_image', args: { prompt: 'a sprout' } },
      ctx
    ).events;
    const startItem = started.find((e) => e.method === 'item/started')!.params as { item: Record<string, unknown> };
    expect(startItem.item).toMatchObject({ type: 'imageGeneration', name: 'generate_image', detail: 'a sprout' });
    expect(typeof startItem.item.startedAt).toBe('number');
    const ended = normalizePiEvent(
      { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'generate_image', result: toolResult(), isError: false },
      ctx
    ).events;
    const done = ended.find((e) => e.method === 'item/completed')!;
    expect((done.params as { item: { image?: unknown } }).item.image).toEqual({ ...stemImage, threadId: 'thread-1' });
    // Never the bytes: every emitted event stays tiny.
    expect(JSON.stringify(ended)).not.toContain(BYTES);
    expect(JSON.stringify(ended).length).toBeLessThan(1024);
  });
});

describe('reducer: generated images', () => {
  const base: ThreadState = {
    messages: [{ id: 'user-1', role: 'user', content: 'draw', turnId: 'turn-1' }],
    running: true,
    streamingId: null,
    activity: null,
    activities: [],
    activeTurnId: 'turn-1',
    status: 'running'
  } as unknown as ThreadState;
  const ev = (method: string, params: unknown) => ({ method, params }) as BackendEventEnvelope;

  it('creates the bubble for an image-only reply and keeps the image once', () => {
    let s = applyBackendEventToThread(
      base,
      ev('item/started', { threadId: 't', turnId: 'turn-1', item: { type: 'imageGeneration', id: 'call-1', name: 'generate_image', startedAt: 5 } })
    )!;
    expect(s.activities[0]).toMatchObject({ status: 'running', startedAt: 5 });
    const completed = ev('item/completed', {
      threadId: 't',
      turnId: 'turn-1',
      item: { type: 'imageGeneration', id: 'call-1', name: 'generate_image', status: 'ok', image: { ...stemImage, threadId: 't' } }
    });
    s = applyBackendEventToThread(s, completed)!;
    const bubble = s.messages.find((m) => m.id === 'assistant-turn-1')!;
    expect(bubble.content).toBe('');
    expect(bubble.images?.map((i) => i.id)).toEqual(['img_0a1b2c3d4e']);
    // A replayed completion does not duplicate it.
    s = applyBackendEventToThread({ ...s, activities: s.activities.map((a) => ({ ...a, status: 'running' as const })) }, completed)!;
    expect(s.messages.find((m) => m.id === 'assistant-turn-1')!.images).toHaveLength(1);
  });
});

describe('readThread: generated images', () => {
  async function session(sessions: string, lines: unknown[]) {
    await writeFile(join(sessions, 's.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  }
  const header = { type: 'session', id: 'img-session', timestamp: '2026-09-28T10:00:00.000Z', cwd: '/tmp' };
  const user = { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'Draw a sprout' }] } };
  const call = {
    type: 'message',
    id: 'a1',
    message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'generate_image', arguments: { prompt: 'a sprout' } }] }
  };

  it('puts the image on the reply that follows it', async () => {
    const { runtime, sessions } = await tempRuntime();
    await session(sessions, [
      header,
      user,
      call,
      { type: 'message', id: 't1', message: toolResult() },
      { type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'Here it is.' }], stopReason: 'stop' } }
    ]);
    const { messages } = await runtime.readThread('img-session');
    const reply = messages.find((m) => m.role === 'assistant')!;
    expect(reply.content).toBe('Here it is.');
    expect(reply.images).toEqual([{ ...stemImage, threadId: 'img-session' }]);
    expect(JSON.stringify(messages)).not.toContain(BYTES);
  });

  it('keeps an image-only reply and one stopped right after the picture', async () => {
    const { runtime, sessions } = await tempRuntime();
    await session(sessions, [
      header,
      user,
      call,
      { type: 'message', id: 't1', message: toolResult() },
      { type: 'message', id: 'a2', message: { role: 'assistant', content: [], stopReason: 'stop' } },
      { type: 'message', id: 'u2', message: { role: 'user', content: [{ type: 'text', text: 'Another' }] } },
      { type: 'message', id: 'a3', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-2', name: 'generate_image', arguments: {} }] } },
      { type: 'message', id: 't2', message: { ...toolResult('call-2'), details: { stemImage: { ...stemImage, id: 'img_ffffffffff' } } } }
    ]);
    const { messages } = await runtime.readThread('img-session');
    const replies = messages.filter((m) => m.role === 'assistant');
    expect(replies.map((m) => m.images?.map((i) => i.id))).toEqual([['img_0a1b2c3d4e'], ['img_ffffffffff']]);
    expect(replies[0].content).toBe('');
  });

  it('serves the bytes by id and nothing for an unknown one', async () => {
    const { runtime, sessions } = await tempRuntime();
    await session(sessions, [header, user, call, { type: 'message', id: 't1', message: toolResult() }]);
    expect(await runtime.findThreadImage('img-session', 'img_0a1b2c3d4e')).toEqual({ mimeType: 'image/png', data: BYTES });
    expect(await runtime.findThreadImage('img-session', 'img_9999999999')).toBeNull();
    expect(await runtime.findThreadImage('img-session', '../etc')).toBeNull();
    expect(await runtime.findThreadImage('no-such-thread', 'img_0a1b2c3d4e')).toBeNull();
  });
});
