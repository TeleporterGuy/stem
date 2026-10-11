// The Memory tab's deep check: which findings it applies on its own (only the
// provable ones), what it mails, Undo/Apply on its changes, and how a reply's
// answers become facts. Stateful (shared per-process DB) like the sibling
// recall suites.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recallStore as store } from '../../src/server/recall/store';
import {
  actOnMemoryCheckChange,
  answerMemoryCheck,
  checkForConversation,
  memoryCheckState,
  runMemoryCheck
} from '../../src/server/recall/deep-check';
import type { LlmClient } from '../../src/server/recall/llm';

afterAll(() => store.close());
beforeEach(() => {
  store.resetFacts();
});

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

function seed(
  text: string,
  origin: 'user_message' | 'assistant_claim' | 'folder_doc',
  over: { source?: string; ts?: number; excerpt?: string } = {}
): number {
  return store.upsertFact(text, {
    source: over.source ?? 'distilled',
    evidence: [{
      messageId: null, threadId: 't', role: origin === 'user_message' ? 'user' : null,
      timestamp: over.ts ?? now() - 30 * DAY, excerpt: over.excerpt ?? text, origin,
      folderId: origin === 'folder_doc' ? 'f' : null, relPath: origin === 'folder_doc' ? 'SAFe.md' : null
    }]
  })!;
}

/** Answers the audit prompts with `findings`, the pick prompt with its own candidates. */
function scriptedLlm(findings: object, answer?: object): LlmClient & { prompts: string[] } {
  const llm = {
    prompts: [] as string[],
    complete: async (prompt: string) => {
      llm.prompts.push(prompt);
      if (prompt.startsWith('You handle the user')) return JSON.stringify(answer ?? {});
      return JSON.stringify(findings);
    }
  };
  return llm;
}

async function runWith(findings: object) {
  let mail = '';
  const job = await runMemoryCheck(scriptedLlm(findings), async (_subject, body) => {
    mail = body;
    return 'conv-1';
  });
  return { job, mail, check: checkForConversation('conv-1')! };
}

const statusOf = (id: number) => store.getFactsByIds([id])[0]?.status;

describe('the deep check', () => {
  it('applies only the fixes it can prove and proposes the rest', async () => {
    const safe = seed('The user is a cloud engineer for VPC.', 'assistant_claim');
    const pasted = seed('The user lives at Súmračná 30.', 'user_message');
    const keep = seed('The user has a clear MagSafe case for the iPhone 17.', 'user_message');
    const dup = seed('The user owns a clear MagSafe iPhone 17 case.', 'user_message');
    const old = seed('The user’s permanent address is on Pražská.', 'user_message', { ts: now() - 200 * DAY });
    const bogus = seed('The user drives a Skoda.', 'user_message');
    const explicit = seed('The user is called Vlado.', 'user_message', { source: 'explicit' });
    store.recordMessage({ threadId: 't2', role: 'user', text: 'Môj trvalý pobyt už nie je Pražská, presťahoval som sa.', ts: now() - 100 * DAY });

    const { job, mail, check } = await runWith({
      fixes: [
        { kind: 'wrong_subject', fact: safe, reason: 'From a course intro.' },
        { kind: 'wrong_subject', fact: pasted, reason: 'From a pasted chat.' },
        { kind: 'duplicate', fact: dup, into: keep, reason: 'Same case.' },
        { kind: 'overruled', fact: old, quote: 'Môj trvalý pobyt už nie je Pražská', reason: 'You moved.' },
        { kind: 'overruled', fact: bogus, quote: 'I sold the Skoda last year', reason: 'Sold it.' },
        { kind: 'wrong_subject', fact: explicit, reason: 'Never touch.' }
      ],
      proposals: [],
      questions: [{ prompt: 'How is Súmračná 30 connected to you?', facts: [pasted], options: ['My home', "Ivka's parents' flat"], why: 'From a pasted chat.' }]
    });

    expect(job).toMatchObject({ running: false, conversationId: 'conv-1' });
    // Proven: no user words behind it; a duplicate; a quote really in a newer user message.
    expect(statusOf(safe)).toBe('superseded');
    expect(statusOf(dup)).toBe('superseded');
    expect(statusOf(old)).toBe('superseded');
    // Not proven: the user's own (pasted) words; a quote nobody wrote. Explicit: untouched.
    expect(statusOf(pasted)).toBe('active');
    expect(statusOf(bogus)).toBe('active');
    expect(statusOf(explicit)).toBe('active');
    expect(check.changes.filter((c) => c.status === 'proposed').map((c) => c.fact).sort()).toEqual([pasted, bogus].sort());
    expect(check.changes.some((c) => c.fact === explicit)).toBe(false);

    expect(mail).toContain('<FactChange');
    expect(mail).toContain(`fact="${safe}"`);
    expect(mail).toContain('<Field type="choice"');
    expect(mail).toContain("<Option>Ivka's parents' flat</Option>");
  });

  it('lets the user’s words overrule a document whenever it surfaced, but not their own later words', async () => {
    const fromDoc = seed('The user’s permanent address is Pražská 27.', 'folder_doc', { ts: now() - 10 * DAY });
    const saidLater = seed('The user lives on Pražská.', 'user_message', { ts: now() - 10 * DAY });
    store.recordMessage({ threadId: 't3', role: 'user', text: 'Môj trvalý pobyt už nie je pražská ale Ľ. Podjavorinskej.', ts: now() - 100 * DAY });
    await runWith({
      fixes: [
        { kind: 'overruled', fact: fromDoc, quote: 'Môj trvalý pobyt už nie je pražská', reason: 'You moved.' },
        { kind: 'overruled', fact: saidLater, quote: 'Môj trvalý pobyt už nie je pražská', reason: 'You moved.' }
      ],
      proposals: [],
      questions: []
    });
    expect(statusOf(fromDoc)).toBe('superseded');
    expect(statusOf(saidLater)).toBe('active');
  });

  it('undoes, redoes and applies changes once each', async () => {
    const safe = seed('The user is a cloud engineer for VPC.', 'assistant_claim');
    const vr = seed('The user’s favourite VR games are Beat Saber and Moss.', 'user_message');
    const { check } = await runWith({
      fixes: [{ kind: 'wrong_subject', fact: safe, reason: 'Course intro.' }],
      proposals: [{ fact: vr, reason: 'Only a list in VR.md.' }],
      questions: []
    });
    const fix = check.changes.find((c) => c.fact === safe)!;
    const prop = check.changes.find((c) => c.fact === vr)!;

    actOnMemoryCheckChange(check.id, fix.id, 'undo');
    expect(statusOf(safe)).toBe('active');
    // A second Undo (another device, a double click) finds it settled.
    expect(actOnMemoryCheckChange(check.id, fix.id, 'undo').find((s) => s.id === fix.id)?.status).toBe('undone');
    actOnMemoryCheckChange(check.id, fix.id, 'redo');
    expect(statusOf(safe)).toBe('superseded');

    actOnMemoryCheckChange(check.id, prop.id, 'apply');
    expect(statusOf(vr)).toBe('superseded');
    expect(memoryCheckState(check.id).find((s) => s.id === prop.id)?.status).toBe('applied');
  });

  it('saves an answer as an explicit fact replacing the facts it settles, and Undo puts them back', async () => {
    const home = seed('The user lives at Súmračná 30.', 'user_message');
    const delivery = seed('The user’s delivery address is Súmračná 30.', 'user_message');
    const { check } = await runWith({
      fixes: [],
      proposals: [],
      questions: [{ prompt: 'How is Súmračná 30 connected to you?', facts: [home, delivery], options: ["Ivka's parents' flat"] }]
    });
    const q = check.questions[0];
    const llm = scriptedLlm({}, {
      reply: 'Thanks.',
      saves: [{ text: "Súmračná 30 is Ivka's parents' flat.", replaces: [home, delivery, 999999], question: q.id }],
      answered: [q.id]
    });
    const body = await answerMemoryCheck(llm, 'conv-1', `- ${q.prompt}: Ivka's parents' flat`);

    expect(statusOf(home)).toBe('superseded');
    expect(statusOf(delivery)).toBe('superseded');
    const after = checkForConversation('conv-1')!;
    const saved = after.changes.find((c) => c.kind === 'save')!;
    expect(store.getFactsByIds([saved.fact])[0]).toMatchObject({ source: 'explicit', status: 'active' });
    expect(saved.replaces).toEqual([home, delivery]); // the unlisted id is ignored
    expect(after.questions[0].status).toBe('answered');
    expect(body).toContain('### Changed');
    expect(body).toContain(`change="${saved.id}"`);

    actOnMemoryCheckChange(after.id, saved.id, 'undo');
    expect(statusOf(saved.fact)).toBe('superseded');
    expect(statusOf(home)).toBe('active');
    expect(statusOf(delivery)).toBe('active');
  });

  it('changes nothing when the reply only asks about a question', async () => {
    const home = seed('The user lives at Súmračná 30.', 'user_message');
    await runWith({ fixes: [], proposals: [], questions: [{ prompt: 'Where is home?', facts: [home], options: ['Here'] }] });
    const body = await answerMemoryCheck(
      scriptedLlm({}, { reply: 'It came from a chat you pasted on 2 October.' }),
      'conv-1',
      'About “Where is home?”: where did this come from?'
    );
    expect(body).toBe('It came from a chat you pasted on 2 October.');
    expect(statusOf(home)).toBe('active');
    expect(checkForConversation('conv-1')!.questions[0].status).toBe('open');
  });
});
