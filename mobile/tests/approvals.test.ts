import { describe, expect, it } from 'vitest';
import { resolvedInstructionsText } from '@shared/instructions';
import type { ExecApprovalRequest, InstructionsProposal, McpAdminProposal, SkillProposal } from '@shared/types';
import {
  approvalThreadId,
  approvalTitle,
  enqueueApproval,
  removeApproval,
  type PendingApproval
} from '../src/approvals/queue';

const exec = (id: string): PendingApproval => ({
  kind: 'exec',
  id,
  request: {
    id,
    threadId: 't1',
    command: 'rm -rf build',
    cwd: '/tmp',
    prefixes: ['rm'],
    judgeVerdict: 'unsure'
  } satisfies ExecApprovalRequest
});

const mcp = (id: string): PendingApproval => ({
  kind: 'mcp',
  id,
  proposal: { id, threadId: 't2', action: 'add', name: 'weather' } satisfies McpAdminProposal
});

const instructions = (id: string, action: InstructionsProposal['action']): PendingApproval => ({
  kind: 'instructions',
  id,
  proposal: { id, threadId: 't3', action, incomingText: 'be brief' } satisfies InstructionsProposal
});

const skill = (id: string, isPatch: boolean): PendingApproval => ({
  kind: 'skill',
  id,
  proposal: {
    id,
    threadId: 't4',
    name: 'deploy',
    description: 'how to deploy',
    body: 'steps',
    isPatch,
    origin: 'turn'
  } satisfies SkillProposal
});

describe('the approval queue', () => {
  it('appends in arrival order, because parallel tool calls have one', () => {
    let queue: PendingApproval[] = [];
    queue = enqueueApproval(queue, exec('1'));
    queue = enqueueApproval(queue, exec('2'));
    queue = enqueueApproval(queue, mcp('3'));
    expect(queue.map((q) => q.id)).toEqual(['1', '2', '3']);
  });

  it('ignores a repeat of something already queued, and says so by identity', () => {
    const queue = enqueueApproval([], exec('1'));
    expect(enqueueApproval(queue, exec('1'))).toBe(queue);
  });

  it('keeps two kinds apart even when they picked the same id', () => {
    // Different minters produce these ids; nothing stops a collision, and one
    // would otherwise silently swallow the other's card.
    let queue = enqueueApproval([], exec('7'));
    queue = enqueueApproval(queue, mcp('7'));
    expect(queue).toHaveLength(2);

    const afterExec = removeApproval(queue, 'exec', '7');
    expect(afterExec.map((q) => q.kind)).toEqual(['mcp']);
  });

  it('removes from any position and is idempotent — a resolve arrives however it ended', () => {
    let queue = [exec('1'), exec('2'), exec('3')].reduce<PendingApproval[]>(
      (acc, item) => enqueueApproval(acc, item),
      []
    );
    queue = removeApproval(queue, 'exec', '2');
    expect(queue.map((q) => q.id)).toEqual(['1', '3']);
    expect(removeApproval(queue, 'exec', '2')).toBe(queue);
  });

  it('accepts numeric ids from the elicitation counter alongside string ones', () => {
    const numeric: PendingApproval = {
      kind: 'skill',
      id: '12',
      proposal: {
        id: 12,
        threadId: 't4',
        name: 'deploy',
        description: 'how to deploy',
        body: 'steps',
        isPatch: false,
        origin: 'turn'
      }
    };
    const queue = enqueueApproval([], numeric);
    expect(removeApproval(queue, 'skill', 12)).toEqual([]);
  });
});

describe('what the sheet says', () => {
  it('names the act rather than the channel', () => {
    expect(approvalTitle(exec('1'))).toBe('Run a command?');
    expect(approvalTitle(mcp('1'))).toBe('Connect a tool server?');
    expect(approvalTitle(instructions('1', 'clear'))).toBe('Clear your instructions?');
    expect(approvalTitle(instructions('1', 'append'))).toBe('Add to your instructions?');
    expect(approvalTitle(skill('1', true))).toBe('Update a saved skill?');
    expect(approvalTitle(skill('1', false))).toBe('Save a new skill?');
  });

  it('knows the thread each one came out of, which is what a push would deep-link to', () => {
    expect(approvalThreadId(exec('1'))).toBe('t1');
    expect(approvalThreadId(mcp('1'))).toBe('t2');
    expect(approvalThreadId(skill('1', false))).toBe('t4');
  });
});

describe('resolvedInstructionsText', () => {
  // The phone answers this card too, so it computes the same final text the
  // desktop card would — see src/shared/instructions.ts.
  it('appends onto what is there, replaces it, or empties it', () => {
    expect(resolvedInstructionsText('append', 'be brief', 'be kind')).toBe('be kind\nbe brief');
    expect(resolvedInstructionsText('append', 'be brief', '')).toBe('be brief');
    expect(resolvedInstructionsText('replace', 'be brief', 'be kind')).toBe('be brief');
    expect(resolvedInstructionsText('clear', 'ignored', 'be kind')).toBe('');
  });
});
