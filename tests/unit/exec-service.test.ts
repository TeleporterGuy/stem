import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecService, JUDGE_TIMEOUT_MS } from '../../src/server/exec/service';
import type { ChatBackend } from '../../src/server/backend/types';
import type { AppSettings, ExecApprovalRequest, ModelSummary } from '../../src/shared/types';
import { emptyCompleteError } from '../../src/server/pi/complete-errors';
import { insertCompleteWaiter } from '../../src/server/pi/complete-worker';

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
    exec: { enabled: true, approvalMode: 'assisted', judgeModel: null, judgeEffort: null, allowlist: [] },
    // The judge reads these too: unpinned, it runs on the shared background model
    // if there is one, else the model of the chat that asked.
    defaults: { model: null, backgroundModel: null, backgroundEffort: 'low' }
  } as unknown as AppSettings;
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
  let completeOpts: Array<{ model?: string | null; effort?: string | null; timeoutMs?: number; priority?: boolean }>;
  let completeImpl: (prompt: string) => Promise<string>;
  let settings: AppSettings;
  let service: ExecService;

  beforeEach(() => {
    settings = baseSettings();
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
      readSettings: async () => settings,
      updateExecSettings: async () => settings,
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

  it('passes priority, 60s timeout, and the model of the chat that asked', async () => {
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
    // Not a cheaper-looking sibling: Stem no longer guesses one from names.
    expect(completeOpts[0]?.model).toBe('anthropic/claude-opus-4');
    // The judge sits between the user and every command they run, so the
    // background effort setting has to reach it — this is the role where the
    // difference between thinking and answering is felt as latency.
    expect(completeOpts[0]?.effort).toBe('low');
    expect(approvals[0]?.judgeVerdict).toBe('unsure');
  });

  it('prefers the safety check’s own effort over the shared background one', async () => {
    // The reason this role has a level of its own: it is the one background job
    // whose cost is paid in latency, in front of the user, on every command —
    // so it must be able to answer faster than the rest of the group.
    settings.exec.judgeEffort = 'off';
    completeImpl = async () => 'unsure maybe';
    await service.handleExecRequest({
      command: PS,
      cwd,
      threadId: 't1',
      isScheduled: false,
      currentModel: 'anthropic/claude-opus-4'
    });
    expect(completeOpts[0]?.effort).toBe('off');
  });

  it('escalates with judgeVerdict failed, saying why in the card\'s voice', async () => {
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
    // Renders as "The automatic safety check could not run: it did not answer in
    // time." — the exception text belongs in the log, not on the card.
    expect(approvals[0]?.judgeReason).toBe('it did not answer in time');
  });

  it('says nothing beyond "could not run" when the cause has no user-facing form', async () => {
    completeImpl = async () => {
      throw new Error('pi exited (code 1, signal null): TypeError: x is not a function');
    };
    await service.handleExecRequest({
      command: PS,
      cwd,
      threadId: 't1',
      isScheduled: false,
      currentModel: 'anthropic/claude-opus-4'
    });
    expect(approvals[0]?.judgeVerdict).toBe('failed');
    expect(approvals[0]?.judgeReason).toBeUndefined();
  });

  it('names a missing model, the one cause the user can act on', async () => {
    completeImpl = async () => {
      throw new Error('No API key configured for provider "xai".');
    };
    await service.handleExecRequest({
      command: PS,
      cwd,
      threadId: 't1',
      isScheduled: false,
      currentModel: 'xai/grok-4.5'
    });
    expect(approvals[0]?.judgeReason).toBe('no model was available to run it');
  });
});
