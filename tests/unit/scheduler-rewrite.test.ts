// The prompt rewrite for tasks from before runs had threads of their own: what
// the model is shown, and what of its answer is accepted as a prompt.
import { describe, expect, it } from 'vitest';
import type { ChatBackend } from '../../src/server/backend/types';
import type { ScheduledTask } from '../../src/shared/types';
import { acceptRewrite, rewriteInstructions, rewriteTaskPrompt, transcriptOf } from '../../src/server/scheduler/rewrite';

const task: ScheduledTask = {
  id: 't', threadId: 'origin', prompt: 'Compare with the earlier reports in this conversation and report only what is new.',
  title: 'x', schedule: { kind: 'cron', expr: '0 8 * * *' }, enabled: true, createdAt: '2026-01-01T00:00:00.000Z',
  runsAs: { kind: 'default' }
};

function runtime(messages: { role: string; content: string }[], answer: string | Error): ChatBackend & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    readThread: async () => ({ title: '', messages }),
    complete: async (prompt: string) => {
      prompts.push(prompt);
      if (answer instanceof Error) throw answer;
      return answer;
    }
  } as unknown as ChatBackend & { prompts: string[] };
}

describe('transcriptOf', () => {
  it('keeps user and assistant turns, drops empty and system ones, and cuts from the front', () => {
    const text = transcriptOf([
      { role: 'system', content: 'hidden' },
      { role: 'user', content: 'Watch GPT-6 news' },
      { role: 'assistant', content: '   ' },
      { role: 'assistant', content: 'Nothing yet as of June.' }
    ]);
    expect(text).toBe('User: Watch GPT-6 news\n\nAssistant: Nothing yet as of June.');
    const long = transcriptOf([{ role: 'user', content: 'a'.repeat(50_000) }, { role: 'assistant', content: 'END' }]);
    expect(long.startsWith('[…earlier part of the chat cut…]')).toBe(true);
    expect(long.endsWith('Assistant: END')).toBe(true);
    expect(long.length).toBeLessThan(41_000);
  });
});

describe('acceptRewrite', () => {
  it('takes a plain answer, unwraps a fenced one, and refuses junk or a no-op', () => {
    expect(acceptRewrite('  Check example.com daily and report anything newer than v2.  ', 'old')).toBe('Check example.com daily and report anything newer than v2.');
    expect(acceptRewrite('```text\nCheck example.com daily and report anything newer than v2.\n```', 'old')).toBe('Check example.com daily and report anything newer than v2.');
    expect(acceptRewrite('ok', 'old')).toBeNull();
    expect(acceptRewrite('same as before', 'same as before')).toBeNull();
    expect(acceptRewrite('x'.repeat(7_000), 'old')).toBeNull();
  });
});

describe('rewriteTaskPrompt', () => {
  it('shows the model the instruction and the chat, and returns its answer', async () => {
    const rt = runtime(
      [{ role: 'user', content: 'Every morning check for GPT-6 news.' }, { role: 'assistant', content: 'Report: as of 20 June, only rumours of a Q3 launch.' }],
      'Every morning search for GPT-6 news. Baseline: as of 20 June only rumours of a Q3 launch were known; report only what is new relative to that via notify_user.'
    );
    const next = await rewriteTaskPrompt(rt, task);
    expect(next).toMatch(/^Every morning search for GPT-6 news/);
    expect(rt.prompts).toHaveLength(1);
    expect(rt.prompts[0]).toContain(task.prompt);
    expect(rt.prompts[0]).toContain('Report: as of 20 June');
    expect(rt.prompts[0]).toBe(rewriteInstructions(task.prompt, transcriptOf([
      { role: 'user', content: 'Every morning check for GPT-6 news.' }, { role: 'assistant', content: 'Report: as of 20 June, only rumours of a Q3 launch.' }
    ])));
  });

  it('answers null for a chat too thin to rewrite from, and for a model that fails', async () => {
    expect(await rewriteTaskPrompt(runtime([{ role: 'user', content: 'hi' }], 'anything'), task)).toBeNull();
    expect(await rewriteTaskPrompt(runtime([{ role: 'user', content: 'Every morning check for GPT-6 news please.' }], new Error('down')), task)).toBeNull();
  });
});
