import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalPolicyPath, pathInsideAny, PiRuntime } from '../../src/main/pi/runtime';
import { newTurnContext } from '../../src/main/pi/normalize';

const cleanup: string[] = [];

async function tempRuntime(): Promise<{ runtime: PiRuntime; root: string; piHome: string; sessions: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), 'stem-runtime-core-'));
  cleanup.push(root);
  const piHome = join(root, 'pi');
  const sessions = join(piHome, 'sessions');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(sessions, { recursive: true }), mkdir(workspace, { recursive: true })]);
  return {
    runtime: new PiRuntime({ piHome, sessionsDir: sessions, workspaceRoot: workspace, seedGlobalAuth: false }),
    root,
    piHome,
    sessions,
    workspace
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('approval lifecycle', () => {
  it('broadcasts explicit decisions and timeout expiry to every renderer', async () => {
    vi.useFakeTimers();
    const { runtime } = await tempRuntime();
    const events: Array<{ method: string; params?: unknown }> = [];
    runtime.on('event', (event) => events.push(event));
    const sent: unknown[] = [];
    const internal = runtime as unknown as {
      proc: { send: (message: unknown) => void };
      currentTurn: ReturnType<typeof newTurnContext> | null;
      handleAdminApproval: (id: string, message: string) => void;
      handleInstructionsApproval: (id: string, message: string) => void;
    };
    internal.proc = { send: (message) => sent.push(message) };
    internal.currentTurn = newTurnContext('approval-thread', 'approval-turn');

    internal.handleAdminApproval('answered-admin', JSON.stringify({
      action: 'add',
      name: 'active-server',
      input: {
        name: 'active-server',
        transport: 'http',
        url: 'https://mcp.example',
        headers: { Authorization: 'Bearer renderer-must-not-see-this' },
        oauthClientSecret: 'real-client-secret'
      }
    }));
    const persistAdmin = vi.fn(async () => undefined);
    await expect(runtime.resolveAdminApproval('answered-admin', true, persistAdmin)).resolves.toBe(true);
    expect(persistAdmin).toHaveBeenCalledWith(expect.objectContaining({
      id: 'answered-admin',
      action: 'add',
      name: 'active-server',
      input: expect.objectContaining({ oauthClientSecret: 'real-client-secret' })
    }));
    expect(events.find((event) => event.method === 'mcp/admin/approvalRequest')?.params).toEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          oauthClientSecret: '********',
          headers: { Authorization: '********' }
        })
      })
    );
    await expect(runtime.resolveAdminApproval('already-expired-admin', true, persistAdmin)).resolves.toBe(false);
    expect(persistAdmin).toHaveBeenCalledOnce();
    internal.handleInstructionsApproval('answered-instructions', JSON.stringify({
      action: 'append',
      incomingText: 'Always be concise.'
    }));
    const persistInstructions = vi.fn(async () => undefined);
    await expect(
      runtime.resolveInstructionsApproval('answered-instructions', true, persistInstructions)
    ).resolves.toBe(true);
    expect(persistInstructions).toHaveBeenCalledOnce();
    await expect(
      runtime.resolveInstructionsApproval('already-expired', true, persistInstructions)
    ).resolves.toBe(false);
    expect(persistInstructions).toHaveBeenCalledOnce();
    internal.handleAdminApproval('expired-admin', JSON.stringify({ action: 'remove', name: 'old-server' }));
    await vi.advanceTimersByTimeAsync(120_001);

    expect(events.filter((event) => event.method.endsWith('/approvalResolved')).map((event) => event.params))
      .toEqual([{ id: 'answered-admin' }, { id: 'answered-instructions' }, { id: 'expired-admin' }]);
    expect(sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'answered-instructions',
      confirmed: true
    });
    expect(sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'expired-admin',
      confirmed: false
    });
  });
});

describe('connected-folder path policy', () => {
  it('canonicalizes direct, symlinked, and not-yet-created targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-policy-'));
    cleanup.push(root);
    const vault = join(root, 'vault');
    const workspace = join(root, 'workspace');
    await Promise.all([mkdir(vault), mkdir(workspace)]);
    await writeFile(join(vault, 'secret.md'), 'private');
    await symlink(vault, join(workspace, 'alias'));
    await symlink(join(vault, 'created-through-link.md'), join(workspace, 'dangling-file'));
    await symlink(vault, join(workspace, 'curly-alias\u2019'));
    await symlink(vault, join(workspace, 'cafe\u0301-alias'));
    await symlink(vault, join(workspace, 'capture\u202FAM.'));

    expect(pathInsideAny(join(vault, 'secret.md'), [vault], workspace)).toBe(true);
    expect(pathInsideAny('alias/secret.md', [vault], workspace)).toBe(true);
    expect(pathInsideAny('alias/new/nested.md', [vault], workspace)).toBe(true);
    expect(pathInsideAny('dangling-file', [vault], workspace)).toBe(true);
    expect(pathInsideAny("curly-alias'/secret.md", [vault], workspace)).toBe(true);
    expect(pathInsideAny('caf\u00e9-alias/secret.md', [vault], workspace)).toBe(true);
    expect(pathInsideAny('capture AM./secret.md', [vault], workspace)).toBe(true);
    expect(pathInsideAny(pathToFileURL(join(vault, 'from-file-url.md')).href, [vault], workspace)).toBe(true);
    expect(pathInsideAny(`@${join(vault, 'from-at-prefix.md')}`, [vault], workspace)).toBe(true);
    const homeVault = join(homedir(), '.stem-policy-nonexistent-vault');
    expect(pathInsideAny('~/.stem-policy-nonexistent-vault/new.md', [homeVault], workspace)).toBe(true);
    expect(pathInsideAny('outside.md', [vault], workspace)).toBe(false);
    expect(canonicalPolicyPath('alias/new/nested.md', workspace)).toBe(
      join(canonicalPolicyPath(vault, workspace), 'new', 'nested.md')
    );

    const runtime = new PiRuntime({
      piHome: join(root, 'pi'),
      sessionsDir: join(root, 'sessions'),
      workspaceRoot: workspace,
      seedGlobalAuth: false
    });
    const turn = newTurnContext('thread', 'turn');
    turn.privateRoots = [vault];
    const internal = runtime as unknown as {
      currentTurn: typeof turn;
      onPiEvent: (event: Record<string, unknown>) => void;
    };
    internal.currentTurn = turn;
    internal.onPiEvent({
      type: 'tool_execution_start',
      toolName: 'read',
      toolCallId: 'read-1',
      args: { path: 'alias/secret.md' }
    });
    expect(turn.memoryTainted).toBe(true);

    const variantTurn = newTurnContext('thread', 'variant-turn');
    variantTurn.privateRoots = [vault];
    internal.currentTurn = variantTurn;
    internal.onPiEvent({
      type: 'tool_execution_start',
      toolName: 'read',
      toolCallId: 'read-variant',
      args: { path: "curly-alias'/secret.md" }
    });
    expect(variantTurn.memoryTainted).toBe(true);
  });
});

describe('crash-loop breaker', () => {
  it('pauses respawns after repeated rapid exits, deduped per spawn generation', async () => {
    const { runtime } = await tempRuntime();
    const events: Array<{ method: string }> = [];
    runtime.on('event', (event) => events.push(event));
    const internal = runtime as unknown as {
      noteProcessExit: (gen: number, uptimeMs: number) => void;
      ensureStarted: () => Promise<void>;
      cooldownUntil: number;
      spawnStrikes: number;
    };

    internal.noteProcessExit(1, 500);
    internal.noteProcessExit(2, 500);
    // Same generation again (exit handler + failed probe): no double strike.
    internal.noteProcessExit(2, 500);
    expect(internal.spawnStrikes).toBe(2);
    expect(internal.cooldownUntil).toBe(0);

    internal.noteProcessExit(3, 500);
    expect(internal.cooldownUntil).toBeGreaterThan(Date.now());
    expect(events.some((e) => e.method === 'process/cooldown')).toBe(true);
    await expect(internal.ensureStarted()).rejects.toThrow(/keeps exiting/);

    // A process that lived a while resets the strike count entirely.
    internal.cooldownUntil = 0;
    internal.noteProcessExit(4, 60_000);
    expect(internal.spawnStrikes).toBe(0);
  });
});

describe('one-shot completion cap', () => {
  it('runs at most two complete() processes, queueing the rest FIFO', async () => {
    const { runtime } = await tempRuntime();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
    let active = 0;
    let maxActive = 0;
    const gates: Array<() => void> = [];
    (runtime as unknown as { completeNow: (prompt: string) => Promise<string> }).completeNow = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => gates.push(resolve));
      active -= 1;
      return 'done';
    };

    const runs = Promise.all(['a', 'b', 'c', 'd'].map((p) => runtime.complete(p)));
    await settle();
    expect(active).toBe(2); // two admitted, two queued

    gates.shift()!();
    await settle();
    expect(active).toBe(2); // released slot handed straight to the third

    while (gates.length > 0 || active > 0) {
      gates.splice(0).forEach((release) => release());
      await settle();
    }
    await expect(runs).resolves.toEqual(['done', 'done', 'done', 'done']);
    expect(maxActive).toBe(2);
  });
});

describe('runtime auth status', () => {
  it('does not treat an empty or malformed credential store as authenticated', async () => {
    const { runtime, piHome } = await tempRuntime();
    await writeFile(join(piHome, 'auth.json'), '{}');
    await expect(runtime.status()).resolves.toMatchObject({ ok: false, authenticated: false, providers: [] });

    await writeFile(join(piHome, 'auth.json'), '{not json');
    await expect(runtime.status()).resolves.toMatchObject({ ok: false, authenticated: false, providers: [] });
  });

  it('accepts structurally valid API-key and OAuth credentials', async () => {
    const { runtime, piHome } = await tempRuntime();
    await writeFile(
      join(piHome, 'auth.json'),
      JSON.stringify({
        anthropic: { type: 'api_key', key: 'sk-test' },
        'openai-codex': { type: 'oauth', access: 'access-token', refresh: '', expires: Date.now() + 60_000 },
        broken: { nope: true }
      })
    );
    const status = await runtime.status();
    expect(status).toMatchObject({ ok: true, authenticated: true });
    expect(status.providers).toEqual(['anthropic', 'openai-codex']);
  });

  it('rejects refresh-only OAuth and credentials for unsupported providers', async () => {
    const { runtime, piHome } = await tempRuntime();
    await writeFile(
      join(piHome, 'auth.json'),
      JSON.stringify({
        'openai-codex': { type: 'oauth', refresh: 'refresh-only', expires: 0 },
        ghost: { type: 'api_key', key: 'looks-structured-but-has-no-models' },
        openrouter: {
          type: 'oauth',
          access: 'oauth-is-not-supported-for-this-provider',
          refresh: 'refresh',
          expires: Date.now() + 60_000
        }
      })
    );

    await expect(runtime.status()).resolves.toMatchObject({
      ok: false,
      authenticated: false,
      providers: []
    });
  });
});

describe('pi RPC failure handling', () => {
  it('does not claim a thread when switch_session is rejected', async () => {
    const { runtime, root } = await tempRuntime();
    const session = join(root, 'target.jsonl');
    await writeFile(session, '{}\n');
    const internal = runtime as unknown as {
      activeThreadId: string;
      sessionFiles: Map<string, string>;
      proc: { request: () => Promise<{ success: boolean; error?: string }> };
      ensureActive: (threadId: string) => Promise<string>;
    };
    internal.activeThreadId = 'currently-active';
    internal.sessionFiles.set('requested', session);
    internal.proc = { request: async () => ({ success: false, error: 'corrupt session' }) };

    await expect(internal.ensureActive('requested')).rejects.toThrow('corrupt session');
    expect(internal.activeThreadId).toBe('currently-active');
  });

  it('preserves the current session mirrors when new_session is rejected', async () => {
    const { runtime } = await tempRuntime();
    const internal = runtime as unknown as {
      activeThreadId: string | null;
      currentModel: string | null;
      currentThinking: string | null;
      proc: { request: () => Promise<{ success: boolean; error?: string }> };
      newSession: () => Promise<string>;
    };
    internal.activeThreadId = 'still-active';
    internal.currentModel = 'openai-codex/current';
    internal.currentThinking = 'high';
    internal.proc = { request: async () => ({ success: false, error: 'cannot create session' }) };

    await expect(internal.newSession()).rejects.toThrow('cannot create session');
    expect(internal.activeThreadId).toBe('still-active');
    expect(internal.currentModel).toBe('openai-codex/current');
    expect(internal.currentThinking).toBe('high');
  });

  it('does not truncate a rollback target unless parking succeeds', async () => {
    const { runtime, root } = await tempRuntime();
    const session = join(root, 'rollback.jsonl');
    const original = '{"id":"header"}\n{"id":"target"}\n{"id":"later"}\n';
    await writeFile(session, original);
    const internal = runtime as unknown as {
      activeThreadId: string | null;
      currentModel: string | null;
      currentThinking: string | null;
      sessionFiles: Map<string, string>;
      ensureStarted: () => Promise<void>;
      proc: { request: () => Promise<{ success: boolean; error?: string }> };
    };
    internal.ensureStarted = async () => undefined;
    internal.activeThreadId = 'currently-active';
    internal.currentModel = 'openai-codex/current';
    internal.currentThinking = 'high';
    internal.sessionFiles.set('target-thread', session);
    internal.proc = { request: async () => ({ success: false, error: 'parking rejected' }) };

    await expect(runtime.rollbackToTurn('target-thread', 'target')).rejects.toThrow('parking rejected');
    expect(await readFile(session, 'utf8')).toBe(original);
    expect(internal.activeThreadId).toBe('currently-active');
    expect(internal.currentModel).toBe('openai-codex/current');
    expect(internal.currentThinking).toBe('high');
  });

  it('does not delete the active chat when parking is rejected', async () => {
    const { runtime, root } = await tempRuntime();
    const session = join(root, 'active-delete.jsonl');
    await writeFile(session, '{"id":"active-thread"}\n');
    const internal = runtime as unknown as {
      activeThreadId: string | null;
      sessionFiles: Map<string, string>;
      unnamedThreads: Set<string>;
      proc: { request: () => Promise<{ success: boolean; error?: string }> };
    };
    internal.activeThreadId = 'active-thread';
    internal.sessionFiles.set('active-thread', session);
    internal.unnamedThreads.add('active-thread');
    internal.proc = { request: async () => ({ success: false, error: 'cannot park active chat' }) };

    await expect(runtime.deleteThread('active-thread')).rejects.toThrow('cannot park active chat');
    expect(internal.activeThreadId).toBe('active-thread');
    expect(internal.sessionFiles.get('active-thread')).toBe(session);
    expect(internal.unnamedThreads.has('active-thread')).toBe(true);
    expect(await readFile(session, 'utf8')).toContain('active-thread');
  });

  it('propagates a rejected set_session_name response', async () => {
    const { runtime } = await tempRuntime();
    const internal = runtime as unknown as {
      activeThreadId: string | null;
      ensureStarted: () => Promise<void>;
      proc: { request: () => Promise<{ success: boolean; error?: string }> };
    };
    internal.activeThreadId = 'active-thread';
    internal.ensureStarted = async () => undefined;
    internal.proc = { request: async () => ({ success: false, error: 'rename rejected' }) };

    await expect(runtime.renameThread('active-thread', 'New name')).rejects.toThrow('rename rejected');
  });

  it('does not claim the rollback target when its reload is rejected', async () => {
    const { runtime, root } = await tempRuntime();
    const session = join(root, 'rollback-switch.jsonl');
    await writeFile(session, '{"id":"header"}\n{"id":"target"}\n{"id":"later"}\n');
    const internal = runtime as unknown as {
      activeThreadId: string | null;
      currentModel: string | null;
      currentThinking: string | null;
      sessionFiles: Map<string, string>;
      ensureStarted: () => Promise<void>;
      proc: { request: (command: { type?: string }) => Promise<{ success: boolean; error?: string }> };
    };
    internal.ensureStarted = async () => undefined;
    internal.activeThreadId = 'currently-active';
    internal.currentModel = 'openai-codex/current';
    internal.currentThinking = 'high';
    internal.sessionFiles.set('target-thread', session);
    internal.proc = {
      request: async (command) => command.type === 'new_session'
        ? { success: true }
        : { success: false, error: 'reload rejected' }
    };

    await expect(runtime.rollbackToTurn('target-thread', 'target')).rejects.toThrow('reload rejected');
    expect(await readFile(session, 'utf8')).toBe('{"id":"header"}\n');
    expect(internal.activeThreadId).toBeNull();
    expect(internal.currentModel).toBeNull();
    expect(internal.currentThinking).toBeNull();
  });

  it('fails before a turn can continue when set_model is rejected', async () => {
    const { runtime } = await tempRuntime();
    const internal = runtime as unknown as {
      currentModel: string;
      proc: { request: () => Promise<{ success: boolean; error?: string }> };
      applyModel: (model: string) => Promise<void>;
    };
    internal.currentModel = 'openai-codex/old';
    internal.proc = { request: async () => ({ success: false, error: 'model unavailable' }) };

    await expect(internal.applyModel('openai-codex/requested')).rejects.toThrow('model unavailable');
    expect(internal.currentModel).toBe('openai-codex/old');
  });

  it('ignores a stale interrupt instead of aborting a newer turn', async () => {
    const { runtime } = await tempRuntime();
    const sent: unknown[] = [];
    const current = newTurnContext('thread', 'current-turn');
    const internal = runtime as unknown as {
      currentTurn: typeof current;
      proc: { send: (command: unknown) => void };
    };
    internal.currentTurn = current;
    internal.proc = { send: (command) => sent.push(command) };

    await runtime.interruptTurn('stale-turn');
    expect(current.aborted).toBe(false);
    expect(sent).toEqual([]);

    await runtime.interruptTurn('current-turn');
    expect(current.aborted).toBe(true);
    expect(sent).toEqual([{ type: 'abort' }]);
  });
});

describe('readThread meta hydration', () => {
  // Reopened chats must keep the per-reply model/effort hover label ("Stem ·
  // <model> · <effort>"). It regressed silently in the codex→pi migration: the
  // codex rollout parser stamped meta from turn_context lines, pi's reader didn't.
  it('stamps model + effort onto hydrated assistant messages', async () => {
    const { runtime, sessions } = await tempRuntime();
    const lines = [
      { type: 'session', id: 'sess-1', timestamp: '2026-07-01T10:00:00.000Z', cwd: '/tmp' },
      { type: 'model_change', id: 'mc1', provider: 'openai-codex', modelId: 'gpt-5.3-codex-spark' },
      { type: 'thinking_level_change', id: 'tl1', thinkingLevel: 'high' },
      { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      {
        type: 'message',
        id: 'a1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          provider: 'openai-codex',
          model: 'gpt-5.6-sol'
        }
      },
      { type: 'thinking_level_change', id: 'tl2', thinkingLevel: 'low' },
      { type: 'message', id: 'u2', message: { role: 'user', content: [{ type: 'text', text: 'again' }] } },
      // No per-message provider/model (older files) → falls back to model_change.
      { type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'sure' }] } }
    ];
    await writeFile(join(sessions, 'sess.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));

    const { messages } = await runtime.readThread('sess-1');
    const replies = messages.filter((m) => m.role === 'assistant');
    expect(replies).toHaveLength(2);
    expect(replies[0].meta).toEqual({ model: 'openai-codex/gpt-5.6-sol', effort: 'high' });
    expect(replies[1].meta).toEqual({ model: 'openai-codex/gpt-5.3-codex-spark', effort: 'low' });
  });
});
