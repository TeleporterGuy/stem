// A code persona's standing answers, captured from the mail flow: the coding
// agent's verbatim reply ends on a question, the relay hands it to the user,
// the user's next mail is the answer — recorded deterministically, question as
// title, answer as body (mail/standing-answers.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import type { MailItem, Persona } from '../../src/shared/types';
import { captureStandingAnswer, MAX_ANSWER_CHARS, questionAskedIn } from '../../src/server/mail/standing-answers';
import { listPersonaNotes } from '../../src/server/workspace/persona-memory';
import { personaMemoryDir } from '../../src/server/workspace/paths';

const dir = personaMemoryDir();
beforeEach(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const coder: Persona = { id: 'coder', name: 'Coder', prompt: 'relay', harness: { agent: 'claude', cwd: '/repo' } };

function item(from: string, body: string, agentReplies?: string[]): MailItem {
  return { id: `i-${from}-${body.length}`, conversationId: 'c1', from, to: ['user'], body, at: 1, ...(agentReplies ? { agentReplies } : {}) };
}

describe('questionAskedIn', () => {
  it('takes the last question sentence of the closing paragraph, one line', () => {
    const reply = 'Done: added the flag and a test.\n\nEverything passes locally.\nShould I deploy this to the\nVPS now, or leave it for you?';
    expect(questionAskedIn(reply)).toBe('Should I deploy this to the VPS now, or leave it for you?');
  });

  it('a reply that ends on a statement asks nothing, even if it asked earlier', () => {
    expect(questionAskedIn('Should I? I went ahead.\n\nAll green, nothing left to do.')).toBeNull();
    expect(questionAskedIn('')).toBeNull();
  });

  it('strips list markers and clips to the title cap', () => {
    expect(questionAskedIn('Open points:\n\n- Which branch should I target?')).toBe('Which branch should I target?');
    expect(questionAskedIn(`${'x'.repeat(300)}?`)).toHaveLength(120);
  });
});

describe('captureStandingAnswer', () => {
  it('records the user’s reply to the agent’s closing question, keyed by the question', async () => {
    const items = [item('user', 'add a flag'), item('coder', 'Relay: done. Should I deploy?', ['Added it.\n\nShould I deploy now?'])];
    await captureStandingAnswer({ persona: coder, items, reply: 'Yes, always deploy after changes.' });
    const notes = await listPersonaNotes('coder');
    expect(notes).toMatchObject([{ title: 'Should I deploy now?', body: 'Yes, always deploy after changes.', source: 'answer' }]);
    // The same question answered again replaces the answer, not stacks it.
    await captureStandingAnswer({ persona: coder, items, reply: 'No, never deploy.' });
    expect((await listPersonaNotes('coder')).map((n) => n.body)).toEqual(['No, never deploy.']);
  });

  it('records nothing when the last item is not the persona’s question, or the reply is a new brief', async () => {
    const asked = item('coder', 'relay', ['Which DB?']);
    await captureStandingAnswer({ persona: coder, items: [item('coder', 'relay', ['All done, nothing open.'])], reply: 'ok' });
    await captureStandingAnswer({ persona: coder, items: [item('coder', 'relay')], reply: 'ok' });
    await captureStandingAnswer({ persona: coder, items: [asked, item('user', 'wait')], reply: 'postgres' });
    await captureStandingAnswer({ persona: coder, items: [asked], reply: 'x'.repeat(MAX_ANSWER_CHARS + 1) });
    await captureStandingAnswer({ persona: { ...coder, memory: false }, items: [asked], reply: 'postgres' });
    await captureStandingAnswer({ persona: { ...coder, harness: undefined }, items: [asked], reply: 'postgres' });
    expect(await listPersonaNotes('coder')).toEqual([]);
  });
});
