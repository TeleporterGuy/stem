import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecService, JUDGE_TIMEOUT_MS } from '../../src/main/exec/service';
import type { ChatBackend } from '../../src/main/backend/types';
import type { AppSettings, ExecApprovalRequest, ModelSummary } from '../../src/shared/types';
import { emptyCompleteError, insertCompleteWaiter } from '../../src/main/pi/runtime';

// ExecService judge wiring: model selection from the live chat, priority complete(),
// and fail-closed escalation when complete() throws.

const PS =
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "1+1"';

function model(id: string, provider: string, isDefault = false): ModelSummary {
  return {
    id,
    displayName: id,
    description: provider,
    provider,
    providerName: provider,
    supportedEfforts: ['medium'],
    defaultEffort: 'medium',
    serviceTiers: [],
    isDefault
  };
}

function baseSettings(): AppSettings {
  return {
    exec: { enabled: true, approvalMode: 'assisted', judgeModel: null, allowlist: [] }
  } as AppSettings;
}

describe('insertCompleteWaiter', () => {
  it('inserts priority waiters ahead of normal ones', () => {
    const waiters: Array<{ priority: boolean; id: string }> = [];
    insertCompleteWaiter(waiters, { priority: false, id: 'n1' });
    insertCompleteWaiter(waiters, { priority: false, id: 'n2' });
    insertCompleteWaiter(waiters, { priority: true, id: 'p1' });
    insertCompleteWaiter(waiters, { priority: true, id: 'p2' });
    insertCompleteWaiter(waiters, { priority: false, id: 'n3' });
    expect(waiters.map((w) => w.id)).toEqual(['p1', 'p2', 'n1', 'n2', 'n3']);
  });
});

describe('emptyCompleteError', () => {
  it('includes stderr when present', () => {
    expect(emptyCompleteError('Unknown provider foo\n').message).toContain('Unknown provider foo');
  });

  it('uses a generic message when stderr is empty', () => {
    expect(emptyCompleteError('').message).toBe('pi completion returned no text.');
  });
});

describe('ExecService judge', () => {
  let cwd: string;
  let approvals: ExecApprovalRequest[];
  let completeOpts: Array<{ model?: string | null; timeoutMs?: number; priority?: boolean }>;
  let completeImpl: (prompt: string) => Promise<string>;
  let service: ExecService;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'stem-exec-svc-')));
    approvals = [];
    completeOpts = [];
    completeImpl = async () => 'safe';
    const runtime = {
      listModels: async () => [
        model('anthropic/claude-opus-4', 'anthropic', true),
        model('anthropic/claude-haiku-4', 'anthropic'),
        model('openai-codex/gpt-5.3-codex-spark', 'openai-codex')
      ],
      complete: async (
        _prompt: string,
        opts?: { model?: string | null; timeoutMs?: number; priority?: boolean }
      ) => {
        completeOpts.push(opts ?? {});
        return completeImpl(_prompt);
      }
    } as unknown as ChatBackend;

    service = new ExecService({
      runtime: () => runtime,
      readSettings: async () => baseSettings(),
      updateExecSettings: async () => baseSettings(),
      emitApprovalRequest: (request) => {
        approvals.push(request);
        // Answer asynchronously so handleExecRequest can await the card.
        queueMicrotask(() => service.resolveApproval(request.id, 'deny'));
      },
      emitApprovalResolved: () => undefined
    });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('passes priority, 60s timeout, and a cheap model of the live chat provider', async () => {
    completeImpl = async () => 'unsure maybe';
    const result = await service.handleExecRequest({
      command: PS,
      cwd,
      threadId: 't1',
      isScheduled: false,
      userText: 'check powershell',
      currentModel: 'anthropic/claude-opus-4'
    });
    expect(result.ok).toBe(false);
    expect(completeOpts).toHaveLength(1);
    expect(completeOpts[0]?.priority).toBe(true);
    expect(completeOpts[0]?.timeoutMs).toBe(JUDGE_TIMEOUT_MS);
    expect(JUDGE_TIMEOUT_MS).toBe(60_000);
    expect(completeOpts[0]?.model).toBe('anthropic/claude-haiku-4');
    expect(approvals[0]?.judgeVerdict).toBe('unsure');
  });

  it('escalates with judgeVerdict failed and the real error when complete throws', async () => {
    completeImpl = async () => {
      throw new Error('pi completion timed out.');
    };
    const result = await service.handleExecRequest({
      command: PS,
      cwd,
      threadId: 't1',
      isScheduled: false,
      currentModel: 'anthropic/claude-opus-4'
    });
    expect(result.ok).toBe(false);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.judgeVerdict).toBe('failed');
    expect(approvals[0]?.judgeReason).toContain('pi completion timed out.');
  });
});
