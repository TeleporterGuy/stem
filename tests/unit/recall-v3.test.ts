import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import * as store from '../../src/main/recall/store';
import * as search from '../../src/main/recall/search';
import { backfillSummaries, parseSummary, refreshThreadSummary } from '../../src/main/recall/summarize';
import { buildRecallContext, previewFacts, usageRate } from '../../src/main/recall/inject';
import {
  CURSOR_KEY,
  distillNewMessages,
  lexicalUsage,
  MAX_PARSE_STRIKES,
  parseDistillOutput,
  parseFactUsage
} from '../../src/main/recall/distill';
import { USAGE_HALF_LIFE_DAYS } from '../../src/main/recall/inject';
import { buildPrompt as buildConsolidationPrompt } from '../../src/main/recall/consolidate';
import * as retrieval from '../../src/main/recall/retrieval';
import {
  hybridSearchMessages,
  hybridSearchSummaries,
  ftsSearchSummaries
} from '../../src/main/recall/search-core';

// Recall v3: shared retrieval core, thread summaries, usage-informed ranking.

const MODEL = 'v3-test-model';

function embedThunk(vec: number[]) {
  return async () => ({ vec: Float32Array.from(vec), model: MODEL });
}

describe('shared search core parity (main process vs MCP-server path)', () => {
  it('ranks identically through search.searchMemoryHybrid and a read-only core handle', async () => {
    store.resetEpisodic();
    store.recordMessage({ threadId: 'par-1', role: 'user', text: 'The kitchen renovation budget is 12000 euros' });
    store.recordMessage({ threadId: 'par-2', role: 'user', text: 'My rosemary on the balcony is dying from overwatering' });
    store.recordMessage({ threadId: 'par-3', role: 'assistant', text: 'Renovation quotes arrived: kitchen cabinets cost 4000' });
    const msgs = store.getMessagesForEmbedding(0, 10);
    // Give the rosemary message a vector orthogonal to the others so the
    // semantic leg has a clear winner the FTS leg can't see.
    for (const m of msgs) {
      store.upsertMessageVector(m.id, MODEL, Float32Array.from(/rosemary/.test(m.text) ? [1, 0] : [0, 1]));
    }

    const embed = embedThunk([1, 0]);
    const viaMain = await search.searchMemoryHybrid('kitchen renovation budget', { limit: 5, getQueryEmbedding: embed });

    // The MCP server's exact setup: its OWN read-only connection to the same
    // file, running the same core function. Any drift between the two paths is
    // the bug class the shared core exists to kill.
    const ro = new DatabaseSync(process.env.STEM_RECALL_DB!, { readOnly: true });
    try {
      const viaCore = await hybridSearchMessages(ro, 'kitchen renovation budget', {
        limit: 5,
        snippetChars: 400,
        embedQuery: embed
      });
      expect(viaCore.map((h) => h.id)).toEqual(viaMain.map((h) => h.id));
      expect(viaCore.map((h) => h.score)).toEqual(viaMain.map((h) => h.score));
    } finally {
      ro.close();
    }
  });
});

describe('thread summaries store', () => {
  it('creates, revises and watermarks a rolling summary', () => {
    store.resetEpisodic();
    const id = store.upsertSummary({
      threadId: 'sum-1',
      text: 'Discussed the kitchen renovation; budget set to 12000 euros.',
      firstTs: 1000,
      lastTs: 2000,
      newMessageCount: 4,
      lastMessageId: 40
    });
    expect(id).not.toBeNull();
    const first = store.getSummaryByThread('sum-1')!;
    expect(first.lastMessageId).toBe(40);
    expect(first.messageCount).toBe(4);

    // Rolling revision: counts accumulate, watermark and window advance.
    store.upsertSummary({
      threadId: 'sum-1',
      text: 'Kitchen renovation: budget 12000 euros; cabinets ordered.',
      firstTs: 1500,
      lastTs: 3000,
      newMessageCount: 2,
      lastMessageId: 55
    });
    const revised = store.getSummaryByThread('sum-1')!;
    expect(revised.id).toBe(id);
    expect(revised.text).toContain('cabinets');
    expect(revised.messageCount).toBe(6);
    expect(revised.lastMessageId).toBe(55);
    expect(revised.firstTs).toBe(1000);
    expect(revised.lastTs).toBe(3000);
  });

  it('invalidates the cached vector when the text changes', () => {
    const id = store.getSummaryByThread('sum-1')!.id;
    store.upsertSummaryVector(id, MODEL, Float32Array.from([1, 0]));
    expect(store.getSummariesMissingVector(MODEL)).toHaveLength(0);
    store.upsertSummary({
      threadId: 'sum-1',
      text: 'Kitchen renovation complete.',
      firstTs: 3000,
      lastTs: 4000,
      newMessageCount: 1,
      lastMessageId: 60
    });
    expect(store.getSummariesMissingVector(MODEL).map((s) => s.id)).toEqual([id]);
  });

  it('caps stored summary text at MAX_SUMMARY_CHARS', () => {
    store.upsertSummary({
      threadId: 'sum-long',
      text: 'x'.repeat(10_000),
      firstTs: 1,
      lastTs: 2,
      newMessageCount: 1,
      lastMessageId: 1
    });
    expect(store.getSummaryByThread('sum-long')!.text.length).toBe(store.MAX_SUMMARY_CHARS);
  });

  it('searches summaries hybrid: FTS leg, semantic leg, and RRF fusion', async () => {
    store.resetEpisodic();
    const a = store.upsertSummary({
      threadId: 'hs-a', text: 'Planned the summer holiday in Croatia; booked the ferry.',
      firstTs: 100, lastTs: 200, newMessageCount: 3, lastMessageId: 3
    })!;
    const b = store.upsertSummary({
      threadId: 'hs-b', text: 'Debugged the Electron app crash on startup; fixed the preload path.',
      firstTs: 300, lastTs: 400, newMessageCount: 3, lastMessageId: 6
    })!;
    store.upsertSummaryVector(a, MODEL, Float32Array.from([1, 0]));
    store.upsertSummaryVector(b, MODEL, Float32Array.from([0, 1]));
    // Filler rows: with only 2 documents bm25's idf is 0 and the FTS noise gate
    // (score ≤ FTS_SCORE_CEILING) filters every hit — as it would in production
    // on a near-empty store.
    store.upsertSummary({ threadId: 'hs-c', text: 'Compared grocery prices and meal plans for the week.', firstTs: 10, lastTs: 20, newMessageCount: 2, lastMessageId: 8 });
    store.upsertSummary({ threadId: 'hs-d', text: 'Reviewed the tax filing deadline and required documents.', firstTs: 30, lastTs: 40, newMessageCount: 2, lastMessageId: 10 });

    const db = store.dbHandle();
    // FTS-only (no embed): lexical match wins.
    const fts = await hybridSearchSummaries(db, 'Electron crash startup', { limit: 3 });
    expect(fts[0]?.threadId).toBe('hs-b');
    // Semantic-only phrasing (no lexical overlap with the Croatia summary).
    const sem = await hybridSearchSummaries(db, 'dovolenka more trajekt', { limit: 3, embedQuery: embedThunk([1, 0]) });
    expect(sem[0]?.threadId).toBe('hs-a');
    // excludeThreadId keeps the current chat out.
    const excl = await hybridSearchSummaries(db, 'Electron crash startup', { limit: 3, excludeThreadId: 'hs-b' });
    expect(excl.every((h) => h.threadId !== 'hs-b')).toBe(true);
  });

  it('summary FTS index stays in lockstep through update and delete', () => {
    const db = store.dbHandle();
    const hit = ftsSearchSummaries(db, 'Croatia ferry holiday', { limit: 5 });
    expect(hit.map((h) => h.threadId)).toContain('hs-a');
    const row = store.getSummaryByThread('hs-a')!;
    store.deleteThreadSummary(row.id);
    expect(ftsSearchSummaries(db, 'Croatia ferry holiday', { limit: 5 }).map((h) => h.threadId)).not.toContain('hs-a');
  });

  it('resetEpisodic clears summaries and the injected-facts log', () => {
    store.upsertSummary({ threadId: 'wipe-me', text: 'To be wiped.', firstTs: 1, lastTs: 2, newMessageCount: 1, lastMessageId: 1 });
    store.recordTurnInjectedFacts('wipe-thread', 'turn-1', [1, 2]);
    store.resetEpisodic();
    expect(store.listThreadSummaries()).toEqual([]);
    expect(store.getUngradedTurnFacts(['turn-1'])).toEqual([]);
  });
});

describe('v3 injection payload', () => {
  function seedSummaryCorpus(): void {
    store.resetEpisodic();
    store.resetFacts();
    store.upsertSummary({ threadId: 'inj-a', text: 'Planned the Croatia holiday: ferry booked for July, apartment in Split confirmed.', firstTs: 100, lastTs: 200, newMessageCount: 4, lastMessageId: 4 });
    store.upsertSummary({ threadId: 'inj-b', text: 'Chose a heat pump vendor; installation quote accepted at 9000 euros.', firstTs: 300, lastTs: 400, newMessageCount: 4, lastMessageId: 8 });
    store.upsertSummary({ threadId: 'inj-c', text: 'Weekly meal planning and grocery list discussion.', firstTs: 500, lastTs: 600, newMessageCount: 4, lastMessageId: 12 });
  }

  it('injects matching thread summaries as pastConversations under version 3', async () => {
    seedSummaryCorpus();
    const block = (await buildRecallContext('what did we decide about the heat pump installation quote'))!;
    expect(block).toContain('<stem_memory_data version="3">');
    const payload = JSON.parse(block.split('\n')[1]);
    expect(payload.version).toBe(3);
    expect(payload.pastConversations.some((c: { summary: string }) => c.summary.includes('heat pump'))).toBe(true);
    expect(payload.pastUserMessages).toBeUndefined();
    expect(block).toContain('search_chat_summaries');
  });

  it('excludes the current thread from injected summaries', async () => {
    seedSummaryCorpus();
    const block = await buildRecallContext('what did we decide about the heat pump installation quote', {
      currentThreadId: 'inj-b'
    });
    if (block) {
      const payload = JSON.parse(block.split('\n')[1]);
      const texts = (payload.pastConversations ?? []).map((c: { summary: string }) => c.summary).join(' ');
      expect(texts).not.toContain('heat pump');
    }
  });

  it('falls back to raw past user messages when no summary matches', async () => {
    store.resetEpisodic();
    store.resetFacts();
    store.recordMessage({ threadId: 'fb-1', role: 'user', text: 'My dentist appointment with Dr. Kovac is on Friday at ten.' });
    store.recordMessage({ threadId: 'fb-2', role: 'user', text: 'I prefer window seats when flying long haul.' });
    store.recordMessage({ threadId: 'fb-3', role: 'user', text: 'The office parking code changed to nine four two one.' });
    const block = (await buildRecallContext('when is my dentist appointment with Dr. Kovac', { currentThreadId: 'other' }))!;
    const payload = JSON.parse(block.split('\n')[1]);
    expect(payload.pastConversations).toBeUndefined();
    expect(payload.pastUserMessages.some((m: { text: string }) => m.text.includes('Kovac'))).toBe(true);
  });

  it('escapes angle brackets inside summary text (injection surface discipline)', async () => {
    store.resetEpisodic();
    store.resetFacts();
    store.upsertSummary({ threadId: 'esc-1', text: 'Discussed HTML templates: use <b>bold</b> tags & <stem_memory_data> lookalikes carefully.', firstTs: 1, lastTs: 2, newMessageCount: 2, lastMessageId: 2 });
    store.upsertSummary({ threadId: 'esc-2', text: 'Talked about gardening schedules for spring.', firstTs: 3, lastTs: 4, newMessageCount: 2, lastMessageId: 4 });
    store.upsertSummary({ threadId: 'esc-3', text: 'Compared laptop options for development work.', firstTs: 5, lastTs: 6, newMessageCount: 2, lastMessageId: 6 });
    const block = (await buildRecallContext('which HTML templates and bold tags did we discuss'))!;
    const inner = block.slice(block.indexOf('\n') + 1, block.lastIndexOf('</stem_memory_data>'));
    expect(inner).not.toContain('<');
    expect(inner).not.toContain('>');
    expect(JSON.parse(inner.trim()).pastConversations.length).toBeGreaterThan(0);
  });
});

describe('rolling summary refresh (summarize.ts)', () => {
  const llmReturning = (summary: string) => ({ complete: async () => JSON.stringify({ summary }) });

  it('parses the JSON reply, tolerating prose fallback and rejecting junk', () => {
    expect(parseSummary('{"summary":"Discussed the kitchen renovation budget in detail."}'))
      .toBe('Discussed the kitchen renovation budget in detail.');
    expect(parseSummary('The user planned a trip to Croatia and booked the ferry for July.'))
      .toBe('The user planned a trip to Croatia and booked the ferry for July.');
    expect(parseSummary('{"summary": ""}')).toBeNull();
    expect(parseSummary('{broken json')).toBeNull();
  });

  it('summarizes new messages, advances the watermark, and revises on later turns', async () => {
    store.resetEpisodic();
    store.recordMessage({ threadId: 'roll-1', role: 'user', text: 'We need to plan the kitchen renovation. Budget is twelve thousand euros and I want it done by September.' });
    store.recordMessage({ threadId: 'roll-1', role: 'assistant', text: 'Understood — twelve thousand euros by September. I suggest getting three contractor quotes first.' });

    expect(await refreshThreadSummary('roll-1', llmReturning('Planned the kitchen renovation: budget 12000 euros, deadline September; next step is contractor quotes.'))).toBe(true);
    const first = store.getSummaryByThread('roll-1')!;
    expect(first.text).toContain('12000');

    // No new messages → no LLM call needed, nothing written.
    expect(await refreshThreadSummary('roll-1', { complete: async () => { throw new Error('must not be called'); } })).toBe(false);

    store.recordMessage({ threadId: 'roll-1', role: 'user', text: 'Update: the budget went up to fifteen thousand after we added new appliances to the scope.' });
    store.recordMessage({ threadId: 'roll-1', role: 'assistant', text: 'Noted, fifteen thousand including appliances.' });
    expect(await refreshThreadSummary('roll-1', llmReturning('Kitchen renovation: budget raised to 15000 euros including appliances; deadline September.'))).toBe(true);
    const revised = store.getSummaryByThread('roll-1')!;
    expect(revised.text).toContain('15000');
    expect(revised.lastMessageId).toBeGreaterThan(first.lastMessageId);
  });

  it('holds the watermark on LLM failure so the same window retries', async () => {
    store.recordMessage({ threadId: 'roll-1', role: 'user', text: 'One more decision: we picked the oak veneer cabinets from the second quote.' });
    store.recordMessage({ threadId: 'roll-1', role: 'assistant', text: 'Oak veneer from quote two — noted.' });
    const before = store.getSummaryByThread('roll-1')!;
    expect(await refreshThreadSummary('roll-1', { complete: async () => { throw new Error('offline'); } })).toBe(false);
    const after = store.getSummaryByThread('roll-1')!;
    expect(after.lastMessageId).toBe(before.lastMessageId);
    expect(after.text).toBe(before.text);

    // Recovery: the retry summarizes exactly the missed window.
    expect(await refreshThreadSummary('roll-1', llmReturning('Kitchen renovation: 15000 euro budget, September deadline, oak veneer cabinets chosen from quote two.'))).toBe(true);
    expect(store.getSummaryByThread('roll-1')!.text).toContain('oak');
  });

  it('skips trivial threads (noise gate)', async () => {
    store.recordMessage({ threadId: 'tiny-1', role: 'user', text: 'ok thanks' });
    expect(await refreshThreadSummary('tiny-1', { complete: async () => { throw new Error('must not be called'); } })).toBe(false);
    expect(store.getSummaryByThread('tiny-1')).toBeNull();
  });

  it('does not let old trivial threads starve dormant summary backfill', async () => {
    store.resetEpisodic();
    for (let i = 0; i < 5; i++) {
      store.recordMessage({ threadId: `tiny-old-${i}`, role: 'user', text: 'ok', ts: 100 + i });
    }
    store.recordMessage({
      threadId: 'substantial-newer',
      role: 'user',
      text: 'We planned the complete migration of the billing system, including data validation and a staged rollout.'.repeat(2),
      ts: 1000
    });
    expect(await backfillSummaries(
      llmReturning('Planned a staged billing-system migration with data validation and rollout safeguards.'),
      1
    )).toBe(1);
    expect(store.getSummaryByThread('substantial-newer')).not.toBeNull();
  });
});

describe('per-turn injected-facts log + usage counters', () => {
  it('records, grades once, and bumps counters without touching confidence', () => {
    store.resetFacts();
    const idA = store.upsertFact('The user drives a Škoda Octavia', 'distilled', { confidence: 0.9 })!;
    const idB = store.upsertFact('The user has two children', 'distilled', { confidence: 0.9 })!;

    store.recordTurnInjectedFacts('t-1', 'turn-1', [idA, idB]);
    const rows = store.getUngradedTurnFacts(['turn-1', 'turn-x']);
    expect(rows).toHaveLength(1);
    expect(rows[0].factIds).toEqual([idA, idB]);

    store.recordFactUsage([idA, idB], [idA], 5000);
    store.markTurnFactsGraded('t-1', 'turn-1');

    const a = store.getFactDetails(idA)!;
    const b = store.getFactDetails(idB)!;
    expect([a.timesInjected, a.timesUsed, a.lastUsedAt]).toEqual([1, 1, 5000]);
    expect([b.timesInjected, b.timesUsed, b.lastUsedAt]).toEqual([1, 0, null]);
    expect(a.confidence).toBe(0.9);

    // Graded rows never come back — one row, one grade, no double counting.
    expect(store.getUngradedTurnFacts(['turn-1'])).toEqual([]);
  });

  it('re-extraction of the same fact does not fabricate usage', () => {
    const id = store.upsertFact('The user drives a Škoda Octavia', 'distilled', { confidence: 0.9 })!;
    const f = store.getFactDetails(id)!;
    expect(f.timesInjected).toBe(1); // unchanged from the previous test's grade
    expect(f.timesUsed).toBe(1);
  });
});

describe('usage grading through the distill pass', () => {
  it('grades from the model factUsage output, once, against the injected set', async () => {
    store.resetFacts();
    store.resetEpisodic();
    const factId = store.upsertFact('The user is allergic to penicillin', 'distilled', { confidence: 0.9 })!;
    const otherId = store.upsertFact('The user supports Slovan Bratislava', 'distilled', { confidence: 0.9 })!;
    store.recordMessage({ threadId: 'g-1', turnId: 'g-turn-1', role: 'user', text: 'What antibiotic can I take for this infection, given my history?' });
    store.recordMessage({ threadId: 'g-1', turnId: 'g-turn-1', role: 'assistant', text: 'Given your penicillin allergy, a macrolide like azithromycin is the usual alternative — confirm with your doctor.' });
    store.recordTurnInjectedFacts('g-1', 'g-turn-1', [factId, otherId]);

    let sawUsageBlock = false;
    const llm = {
      complete: async (prompt: string) => {
        // The distiller must be shown the injected set to grade it.
        const m = prompt.match(/\[message:(\d+)\] was written with these facts available/);
        if (m) sawUsageBlock = true;
        return JSON.stringify({
          claims: [],
          factUsage: m ? [{ messageId: Number(m[1]), usedFactIds: [factId, 999] }] : []
        });
      }
    };
    await distillNewMessages(llm);
    expect(sawUsageBlock).toBe(true);

    const used = store.getFactDetails(factId)!;
    const unused = store.getFactDetails(otherId)!;
    expect([used.timesInjected, used.timesUsed]).toEqual([1, 1]);
    expect([unused.timesInjected, unused.timesUsed]).toEqual([1, 0]);
    // Hallucinated id 999 was ignored (intersected with the injected set),
    // and the row is graded — a rerun must not double-count.
    await distillNewMessages({ complete: async () => '{"claims":[]}' });
    expect(store.getFactDetails(factId)!.timesInjected).toBe(1);
  });

  it('falls back to the lexical heuristic when the model skips the grading duty', async () => {
    store.resetFacts();
    store.resetEpisodic();
    const usedId = store.upsertFact('The user drives a Škoda Octavia estate', 'distilled', { confidence: 0.9 })!;
    const unusedId = store.upsertFact('The user grows tomatoes on the balcony', 'distilled', { confidence: 0.9 })!;
    store.recordMessage({ threadId: 'g-2', turnId: 'g-turn-2', role: 'user', text: 'Which roof box fits my car?' });
    store.recordMessage({ threadId: 'g-2', turnId: 'g-turn-2', role: 'assistant', text: 'For a Škoda Octavia estate, the Thule Motion XT L fits the factory rails well.' });
    store.recordTurnInjectedFacts('g-2', 'g-turn-2', [usedId, unusedId]);

    await distillNewMessages({ complete: async () => '{"claims":[]}' });
    expect(store.getFactDetails(usedId)!.timesUsed).toBe(1);
    expect(store.getFactDetails(unusedId)!.timesUsed).toBe(0);
    expect(store.getFactDetails(unusedId)!.timesInjected).toBe(1);
  });

  it('abstains from lexical grading on a trivially short reply', async () => {
    store.resetFacts();
    store.resetEpisodic();
    const factId = store.upsertFact('The user drives a Škoda Octavia estate', 'distilled', { confidence: 0.9 })!;
    store.recordMessage({ threadId: 'g-3', turnId: 'g-turn-3', role: 'user', text: 'Thanks!' });
    store.recordMessage({ threadId: 'g-3', turnId: 'g-turn-3', role: 'assistant', text: 'You are welcome!' });
    store.recordTurnInjectedFacts('g-3', 'g-turn-3', [factId]);

    await distillNewMessages({ complete: async () => '{"claims":[]}' });
    // No counters moved and the row stays ungraded — no signal either way.
    const f = store.getFactDetails(factId)!;
    expect([f.timesInjected, f.timesUsed]).toEqual([0, 0]);
    expect(store.getUngradedTurnFacts(['g-turn-3'])).toHaveLength(1);
  });

  it('retries the segment on an unrecognizable reply, abandoning it after the strike cap', async () => {
    store.resetFacts();
    store.resetEpisodic();
    store.recordMessage({ threadId: 'p-1', role: 'user', text: 'I moved to Ghent last month and my new landlord is called Peeters.' });
    const cursorBefore = () => JSON.parse(store.getMeta(CURSOR_KEY) ?? 'null');

    const garbage = { complete: async () => 'I could not process this transcript, sorry.' };
    await distillNewMessages(garbage);
    const stuck = cursorBefore();
    for (let strike = 2; strike < MAX_PARSE_STRIKES; strike++) {
      await distillNewMessages(garbage);
      expect(cursorBefore()).toEqual(stuck);
    }
    // Final strike gives the segment up so a poison batch can't wedge distillation.
    await distillNewMessages(garbage);
    expect(await distillNewMessages(garbage)).toBe(0);
    expect(cursorBefore()).not.toEqual(stuck);

    // A recognized-empty reply, by contrast, consumes its segment on the spot.
    store.recordMessage({ threadId: 'p-1', role: 'user', text: 'Also my cat is called Miso.' });
    const before = cursorBefore();
    await distillNewMessages({ complete: async () => '{"claims":[]}' });
    expect(cursorBefore()).not.toEqual(before);
    expect(parseDistillOutput('{"claims":[]}').recognized).toBe(true);
    expect(parseDistillOutput('total nonsense').recognized).toBe(false);
  });

  it('parseFactUsage tolerates junk; lexicalUsage matches on content tokens', () => {
    expect(parseFactUsage('no json here')).toEqual([]);
    expect(parseFactUsage('{"claims":[],"factUsage":[{"messageId":"x","usedFactIds":[1]}]}')).toEqual([]);
    expect(parseFactUsage('{"factUsage":[{"messageId":7,"usedFactIds":[1,1,"a",2]}]}')).toEqual([
      { messageId: 7, usedFactIds: [1, 2] }
    ]);
    expect(lexicalUsage('The user drives a Škoda Octavia', 'the škoda octavia fits a roof box')).toBe(true);
    expect(lexicalUsage('The user grows tomatoes on the balcony', 'the škoda octavia fits a roof box')).toBe(false);
  });
});

describe('usage-rate staleness decay', () => {
  it('fades a buried fact back toward neutral so it can re-enter rotation', () => {
    const now = Math.floor(Date.now() / 1000);
    const dead = { timesInjected: 10, timesUsed: 0, lastGradedAt: now, lastUsedAt: null, updatedAt: now };
    // Fresh grade: full penalty. One half-life: half of it. Months: ~neutral.
    expect(usageRate(dead, now)).toBeCloseTo(1 / 12, 5);
    expect(usageRate(dead, now + USAGE_HALF_LIFE_DAYS * 86_400)).toBeCloseTo(0.5 - (0.5 - 1 / 12) / 2, 5);
    expect(usageRate(dead, now + 180 * 86_400)).toBeCloseTo(0.5, 3);
    // Decay is symmetric — a positive signal fades the same way.
    const live = { ...dead, timesUsed: 10, lastUsedAt: now };
    expect(usageRate(live, now)).toBeCloseTo(11 / 12, 5);
    expect(usageRate(live, now + 180 * 86_400)).toBeCloseTo(0.5, 3);
    // Legacy rows without a grading stamp anchor on updatedAt and age out too.
    const legacy = { timesInjected: 10, timesUsed: 0, lastGradedAt: null, lastUsedAt: null, updatedAt: now - 180 * 86_400 };
    expect(usageRate(legacy, now)).toBeCloseTo(0.5, 3);
  });
});

describe('usage blend in fact ranking', () => {
  const flatEmbeddings = {
    available: async () => true,
    modelId: async () => 'blend-model',
    embed: async (texts: string[], kind?: 'query' | 'passage') =>
      texts.map((t) => Float32Array.from(kind === 'query' || !/submarine/.test(t) ? [1, 0] : [0, 1]))
  };

  it('reorders equal-cosine facts by usage but never admits a below-gate fact', async () => {
    store.resetFacts();
    store.setUsageWeight(0.1);
    const deadId = store.upsertFact('The user likes hiking in the Tatras', 'distilled', { confidence: 0.9 })!;
    const liveId = store.upsertFact('The user runs a homelab server rack', 'distilled', { confidence: 0.9 })!;
    // Below-gate fact ([0,1] → cosine 0 against the query) with perfect usage.
    const gatedId = store.upsertFact('The user owns a submarine poster', 'distilled', { confidence: 0.9 })!;
    // deadId: injected 10×, never used. liveId: used every time. gatedId: perfect
    // usage. Recent timestamps — staleness decay must not soften these grades.
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 10; i++) {
      store.recordFactUsage([deadId], [], now - 10 + i);
      store.recordFactUsage([liveId], [liveId], now - 10 + i);
      store.recordFactUsage([gatedId], [gatedId], now - 10 + i);
    }
    expect(usageRate(store.getFactDetails(deadId)!)).toBeLessThan(0.1);
    expect(usageRate(store.getFactDetails(liveId)!)).toBeGreaterThan(0.9);

    retrieval.setRetrievalClients({ embeddings: flatEmbeddings, rerank: null });
    try {
      const preview = await previewFacts('anything at all');
      const ids = preview.facts.map((f) => f.id);
      // Equal raw cosine (1.0) → the used fact outranks the never-used one.
      expect(ids.indexOf(liveId)).toBeLessThan(ids.indexOf(deadId));
      // The gate tests RAW cosine: perfect usage cannot admit a 0-cosine fact.
      expect(ids).not.toContain(gatedId);
      // Both above-gate facts still injected — the blend reorders, never excludes.
      expect(ids).toContain(deadId);

      // Weight 0 disables the blend: order falls back to the tie order (id ASC).
      store.setUsageWeight(0);
      const flat = await previewFacts('anything at all');
      const flatIds = flat.facts.map((f) => f.id);
      expect(flatIds.indexOf(deadId)).toBeLessThan(flatIds.indexOf(liveId));
    } finally {
      retrieval.setRetrievalClients({ embeddings: null, rerank: null });
      store.setUsageWeight(0.1);
    }
  });
});

describe('consolidation usage hints', () => {
  it('annotates never-used facts and leaves used/fresh ones unmarked', () => {
    store.resetFacts();
    const deadId = store.upsertFact('The user likes obscure trivia', 'distilled', { confidence: 0.9 })!;
    const freshId = store.upsertFact('The user has a cat named Miso', 'distilled', { confidence: 0.9 })!;
    for (let i = 0; i < 6; i++) store.recordFactUsage([deadId], []);
    const prompt = buildConsolidationPrompt(store.getAllFacts());
    expect(prompt).toContain(`[${deadId}] The user likes obscure trivia  (injected 6×, never used)`);
    expect(prompt.endsWith(`[${freshId}] The user has a cat named Miso`)).toBe(true);
    expect(prompt).toContain('NEVER a reason to drop a fact that is unique and plausibly true');
  });
});
