// A cold chat-list scan reads every session file whole. After a restart a
// reconnecting client asks for several lists at once; with ~1 GB of sessions
// three parallel scans of every file ran the server out of heap at boot. The
// scans are now shared, and the reads bounded.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiRuntime } from '../../src/server/pi/runtime';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function runtimeWithSessions(count: number) {
  const root = await mkdtemp(join(tmpdir(), 'stem-session-scan-'));
  cleanup.push(root);
  const piHome = join(root, 'pi');
  const sessions = join(piHome, 'sessions');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(sessions, { recursive: true }), mkdir(workspace, { recursive: true })]);
  for (let i = 0; i < count; i++) {
    const id = `01a00000-0000-7000-8000-${String(i).padStart(12, '0')}`;
    const header = { type: 'session', id, cwd: workspace, timestamp: '2026-10-18T06:00:00.000Z' };
    const message = { type: 'message', message: { role: 'user', content: [{ type: 'text', text: `Chat ${i}` }] } };
    await writeFile(join(sessions, `${id}.jsonl`), `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
  }
  return new PiRuntime({ piHome, sessionsDir: sessions, workspaceRoot: workspace, seedGlobalAuth: false });
}

describe('cold session scan', () => {
  it('reads each file once for concurrent list calls, a few at a time', async () => {
    const runtime = await runtimeWithSessions(20);
    const internals = runtime as unknown as { readSessionMeta: (path: string, mtimeMs: number) => Promise<unknown> };
    const original = internals.readSessionMeta.bind(runtime);
    let active = 0;
    let peak = 0;
    const read = vi.spyOn(internals, 'readSessionMeta').mockImplementation(async (path, mtimeMs) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      try {
        return await original(path, mtimeMs);
      } finally {
        active -= 1;
      }
    });

    const lists = await Promise.all([runtime.listThreads(), runtime.listThreads(), runtime.listThreads()]);

    for (const list of lists) expect(list).toHaveLength(20);
    expect(read).toHaveBeenCalledTimes(20);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);

    // Warm: unchanged files come from the cache.
    await runtime.listThreads();
    expect(read).toHaveBeenCalledTimes(20);
  });
});
