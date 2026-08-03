// The extractor-independent truth-maintenance layer: the write-time neighbour
// sweep, the fact_relation_checks memo/queue, the background classify pass, the
// retroactive backfill, and the merge-evidence recency fix that makes any
// "later evidence wins" comparison trustworthy in the first place.
// Stateful, order-dependent (shared per-process DB) like the sibling suites.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recallStore as store, newestEvidenceTs } from '../../src/main/recall/store';
import {
  RELATION_PROMPT_HEADER,
  SWEEP_CONFLICT_REASON,
  processPendingRelationChecks,
  relationSweepBackfillDone,
  stepRelationSweepBackfill,
  sweepFactAgainstNeighbours,
  type FactRelation
} from '../../src/main/recall/reconcile';
import { buildPrompt as buildConsolidationPrompt } from '../../src/main/recall/consolidate';
import * as distill from '../../src/main/recall/distill';
import * as retrieval from '../../src/main/recall/retrieval';
import type { LlmClient } from '../../src/main/recall/llm';

afterAll(() => store.close());
beforeEach(() => {
  store.resetFacts();
});

const MODEL = 'fake-model';

/** A counting LLM that answers every relation prompt with a fixed verdict. */
function verdictLlm(verdict: FactRelation): LlmClient & { calls: number } {
  const llm = {
    calls: 0,
    complete: async (prompt: string) => {
      if (!prompt.includes(RELATION_PROMPT_HEADER)) throw new Error(`unexpected prompt: ${prompt.slice(0, 60)}`);
      llm.calls += 1;
      return JSON.stringify({ verdict });
    }
  };
  return llm;
}

/** Seed a fact with a vector and one dated evidence row. */
function seedFact(text: string, vec: number[], over: { source?: string; ts?: number; pinned?: boolean } = {}): number {
  const id = store.upsertFact(text, {
    source: over.source ?? 'distilled',
    evidence: [{
      messageId: null, threadId: null, role: null,
      timestamp: over.ts ?? Math.floor(Date.now() / 1000) - 86_400,
      excerpt: `evidence: ${text}`, origin: 'folder_doc', folderId: 'f', relPath: 'x.pdf'
    }]
  })!;
  if (over.pinned) store.setFactPinned(id, true);
  store.upsertFactVector(id, MODEL, Float32Array.from(vec));
  return id;
}

const relationRows = () =>
  store.dbHandle().prepare('SELECT fact_a AS a, fact_b AS b, verdict, origin FROM fact_relation_checks ORDER BY id').all() as
    Array<{ a: number; b: number; verdict: string | null; origin: string }>;

describe('sweepFactAgainstNeighbours', () => {
  it('auto-supersedes a differently-worded stale neighbour on a directUser supersede verdict', async () => {
    const stale = seedFact('The user has switched to Firefox as their web browser.', [1, 0, 0]);
    const fresh = seedFact('The user uses Arc Browser on macOS.', [0.95, 0.3, 0]);
    const llm = verdictLlm('b_supersedes_a');
    expect(await sweepFactAgainstNeighbours(fresh, MODEL, llm, { directUser: true })).toBe(true);
    expect(llm.calls).toBe(1);
    expect(store.getFactDetails(stale)?.status).toBe('superseded');
    expect(store.getFactDetails(stale)?.supersededBy).toBe(fresh);
    expect(store.getFactDetails(fresh)?.status).toBe('active');
    expect(relationRows()).toEqual([{ a: stale, b: fresh, verdict: 'b_supersedes_a', origin: 'sweep' }]);
  });

  it('raises a conflict instead when the new fact is not directly user-stated', async () => {
    const stale = seedFact('The user has switched to Firefox as their web browser.', [1, 0, 0]);
    const fresh = seedFact('The user uses Arc Browser on macOS.', [0.95, 0.3, 0]);
    await sweepFactAgainstNeighbours(fresh, MODEL, verdictLlm('b_supersedes_a'), { directUser: false });
    expect(store.getFactDetails(stale)?.status).toBe('conflicted');
    const conflicts = store.getMemoryConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toBe(SWEEP_CONFLICT_REASON);
  });

  it('never auto-supersedes an explicit or pinned neighbour', async () => {
    const explicit = seedFact('The user works at Awantech.', [1, 0, 0], { source: 'explicit' });
    const pinned = seedFact('The user is employed by Awantech s.r.o.', [0.99, 0.05, 0], { pinned: true });
    const fresh = seedFact('The user left Awantech last month.', [0.97, 0.2, 0]);
    await sweepFactAgainstNeighbours(fresh, MODEL, verdictLlm('b_supersedes_a'), { directUser: true });
    expect(store.getFactDetails(explicit)?.status).not.toBe('superseded');
    expect(store.getFactDetails(pinned)?.status).not.toBe('superseded');
    expect(store.getMemoryConflicts().length).toBeGreaterThan(0);
  });

  it('memoizes compatible verdicts: the same pair never costs a second model call', async () => {
    seedFact('The user has a dog named Rex.', [1, 0, 0]);
    const fresh = seedFact('The user walks their dog every morning.', [0.9, 0.4, 0]);
    const first = verdictLlm('compatible');
    await sweepFactAgainstNeighbours(fresh, MODEL, first, { directUser: true });
    expect(first.calls).toBe(1);
    expect(store.getMemoryConflicts()).toHaveLength(0);
    const second = verdictLlm('contradicts');
    await sweepFactAgainstNeighbours(fresh, MODEL, second, { directUser: true });
    expect(second.calls).toBe(0);
    expect(store.getMemoryConflicts()).toHaveLength(0);
  });

  it('ignores neighbours below the cosine floor and ids the extractor already handled', async () => {
    const far = seedFact('The user lives in Bratislava.', [0, 0, 1]);
    const named = seedFact('The user uses Zen browser.', [0.99, 0.1, 0]);
    const fresh = seedFact('The user uses Arc Browser on macOS.', [1, 0, 0]);
    const llm = verdictLlm('contradicts');
    await sweepFactAgainstNeighbours(fresh, MODEL, llm, { directUser: true, skipIds: new Set([named]) });
    expect(llm.calls).toBe(0);
    expect(store.getFactDetails(far)?.status).toBe('active');
    expect(store.getFactDetails(named)?.status).toBe('active');
  });

  it('over-budget pairs queue for the background pass instead of classifying inline', async () => {
    const stale = seedFact('The user has switched to Firefox as their web browser.', [1, 0, 0]);
    const fresh = seedFact('The user uses Arc Browser on macOS.', [0.95, 0.3, 0]);
    const llm = verdictLlm('contradicts');
    await sweepFactAgainstNeighbours(fresh, MODEL, llm, { directUser: true, budget: { remaining: 0 } });
    expect(llm.calls).toBe(0);
    expect(relationRows()).toEqual([{ a: stale, b: fresh, verdict: null, origin: 'sweep' }]);
  });
});

describe('processPendingRelationChecks', () => {
  it('is conflict-only: even a supersede verdict just raises a conflict', async () => {
    const a = seedFact('The fee is 129 euro per month.', [1, 0, 0]);
    const b = seedFact('The fee is 134 euro per month.', [0.99, 0.1, 0]);
    store.enqueueRelationChecks([[a, b]], 'backfill');
    const res = await processPendingRelationChecks(verdictLlm('b_supersedes_a'));
    expect(res).toEqual({ checked: 1, conflicts: 1 });
    expect(store.getFactDetails(a)?.status).toBe('conflicted');
    expect(store.getFactDetails(b)?.status).toBe('conflicted');
    expect(relationRows()[0].verdict).toBe('b_supersedes_a');
  });

  it('settles rows whose side went inactive as stale, without a model call', async () => {
    const a = seedFact('Fact one.', [1, 0, 0]);
    const b = seedFact('Fact two.', [0.99, 0.1, 0]);
    store.enqueueRelationChecks([[a, b]], 'coinject');
    store.supersedeFact(a, null);
    const llm = verdictLlm('contradicts');
    const res = await processPendingRelationChecks(llm);
    expect(llm.calls).toBe(0);
    expect(res).toEqual({ checked: 0, conflicts: 0 });
    expect(relationRows()[0].verdict).toBe('stale');
  });

  it('compatible verdicts leave both facts active and raise nothing', async () => {
    const a = seedFact('The user has a UZ Gent appointment on 17 July.', [1, 0, 0]);
    const b = seedFact('A Slovak interpreter was secured for the appointment.', [0.99, 0.1, 0]);
    store.enqueueRelationChecks([[a, b]], 'coinject');
    const res = await processPendingRelationChecks(verdictLlm('compatible'));
    expect(res).toEqual({ checked: 1, conflicts: 0 });
    expect(store.getMemoryConflicts()).toHaveLength(0);
    expect(store.getFactDetails(a)?.status).toBe('active');
  });
});

describe('enqueueRelationChecks', () => {
  it('dedupes the unordered pair and skips pairs the conflict machinery already owns', () => {
    const a = seedFact('Fact A.', [1, 0, 0]);
    const b = seedFact('Fact B.', [0, 1, 0]);
    const c = seedFact('Fact C.', [0, 0, 1]);
    expect(store.enqueueRelationChecks([[a, b], [b, a], [a, a]], 'coinject')).toBe(1);
    store.createFactConflict(a, c, 'existing conflict');
    expect(store.enqueueRelationChecks([[c, a]], 'sweep')).toBe(0);
    expect(relationRows()).toHaveLength(1);
  });
});

describe('stepRelationSweepBackfill', () => {
  const embeddings = {
    available: async () => true,
    modelId: async () => MODEL,
    embed: async (texts: string[]) => texts.map(() => Float32Array.from([0, 0, 1]))
  };

  it('enumerates neighbour pairs cursor-batch by batch, then reports done for good', async () => {
    const a = seedFact('The user has switched to Firefox as their web browser.', [1, 0, 0]);
    const b = seedFact('The user uses Arc Browser on macOS.', [0.95, 0.3, 0]);
    seedFact('The user lives in Bratislava.', [0, 1, 0]); // no neighbour above the floor
    retrieval.setRetrievalClients({ embeddings, rerank: null });
    try {
      const step1 = await stepRelationSweepBackfill(2);
      expect(step1.done).toBe(false);
      expect(relationRows()).toEqual([
        { a, b, verdict: null, origin: 'backfill' }
      ]);
      const step2 = await stepRelationSweepBackfill(2);
      expect(step2).toEqual({ done: false, enqueued: 0 });
      expect(await stepRelationSweepBackfill(2)).toEqual({ done: true, enqueued: 0 });
      expect(relationSweepBackfillDone()).toBe(true);
    } finally {
      retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    }
  });

  it('leaves the cursor alone when embeddings are unavailable', async () => {
    seedFact('Fact one.', [1, 0, 0]);
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    expect(await stepRelationSweepBackfill(5)).toEqual({ done: false, enqueued: 0 });
    expect(relationSweepBackfillDone()).toBe(false);
  });
});

describe('merge keeps truth-recency', () => {
  it('copies the merge loser\'s evidence to the survivor, so the newest assertion date survives', () => {
    const now = Math.floor(Date.now() / 1000);
    const survivorId = seedFact('The user uses Arc as their browser.', [1, 0, 0], { ts: now - 10 * 86_400 });
    const loserId = seedFact('The user now uses Arc Browser instead of Zen.', [0.99, 0.1, 0], { ts: now - 86_400 });
    expect(survivorId).toBeLessThan(loserId);
    store.applyConsolidation({
      merge: [{ ids: [survivorId, loserId], text: 'The user uses Arc Browser on macOS.' }],
      correct: [],
      drop: []
    });
    const survivor = store.getFactDetails(survivorId)!;
    expect(survivor.status).toBe('active');
    // Before the fix the survivor kept only its own, 10-day-old evidence and the
    // absorbed fact's recency was silently destroyed.
    expect(newestEvidenceTs(survivor)).toBe(now - 86_400);
    // The loser keeps its provenance for the audit/restore path.
    expect(store.getFactDetails(loserId)!.evidence).toHaveLength(1);
  });
});

describe('consolidation prompt dates', () => {
  it('renders each fact\'s newest evidence date and states the later-evidence rule', () => {
    const ts = Math.floor(new Date('2026-07-26T12:00:00Z').getTime() / 1000);
    const id = seedFact('The user uses Arc Browser.', [1, 0, 0], { ts });
    const facts = store.getAllFacts();
    const prompt = buildConsolidationPrompt(facts, store.getNewestEvidenceTsByFact());
    expect(prompt).toContain(`[${id}] (evidence dated 2026-07-26) The user uses Arc Browser.`);
    expect(prompt).toContain('later evidence date');
    // Without the map the line renders undated rather than lying.
    expect(buildConsolidationPrompt(facts)).toContain(`[${id}] The user uses Arc Browser.`);
  });
});

describe('the Firefox regression, end to end through distill', () => {
  it('retires a stale differently-worded fact the extractor never named', async () => {
    const stale = store.upsertFact('The user has switched to Firefox as their web browser.', 'distilled')!;
    // In production the stale fact has a cached vector (inject's lazy backfill
    // embeds every fact); the write-time sweep only sees vectored neighbours.
    store.upsertFactVector(stale, MODEL, Float32Array.from([1, 0]));
    store.recordMessage({ threadId: 'fx', turnId: 'fx1', role: 'user', text: 'I switched back to Arc, Zen had too many bugs.' });
    const [message] = store.getMessagesForDistillFrom(1);
    // Both browser facts embed close together; everything else far away.
    const embeddings = {
      available: async () => true,
      modelId: async () => MODEL,
      embed: async (texts: string[]) => texts.map((t) => Float32Array.from(/browser|arc|firefox/i.test(t) ? [1, 0] : [0, 1]))
    };
    retrieval.setRetrievalClients({ embeddings, rerank: null });
    const llm: LlmClient = {
      complete: async (prompt: string) =>
        prompt.includes(RELATION_PROMPT_HEADER)
          ? JSON.stringify({ verdict: 'b_supersedes_a' })
          : JSON.stringify({
              claims: [{
                text: 'The user uses Arc Browser, having switched back from Zen.',
                category: 'preference',
                sensitivity: 'standard',
                validUntil: null,
                evidenceMessageIds: [message.id],
                // The extractor names NOTHING — exactly the failure that let the
                // Firefox fact survive in production. Only the sweep can catch it.
                supersedesFactIds: [],
                conflictsWithFactIds: []
              }]
            })
    };
    try {
      expect(await distill.distillNewMessages(llm)).toBe(1);
    } finally {
      retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    }
    const staleDetails = store.getFactDetails(stale)!;
    expect(staleDetails.status).toBe('superseded');
    const fresh = store.getAllFacts().find((f) => /Arc Browser/.test(f.text) && f.status === 'active')!;
    expect(staleDetails.supersededBy).toBe(fresh.id);
  });
});
