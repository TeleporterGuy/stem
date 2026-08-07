import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recallStore as store } from '../../src/server/recall/store';
import { LONG_NOTE_THRESHOLD, extractNoteFacts, normalizeExplicitNote, processExplicitNote } from '../../src/server/recall/note';
import { addMemoryNote, setMemoryEnabled } from '../../src/server/workspace/memory';

afterAll(() => store.close());
beforeEach(async () => {
  store.resetFacts();
  await setMemoryEnabled(true);
});

const llmReturning = (reply: string) => ({ complete: async () => reply });
const rewriteReply = (text: string) => JSON.stringify({ text });
/** Answers the note-rewrite prompt with `text`; any other prompt (reconcile,
 *  contradiction) gets an empty relation reply. */
const rewriteOnlyLlm = (text: string) => ({
  complete: async (prompt: string) =>
    /Rewrite it as ONE short/.test(prompt)
      ? rewriteReply(text)
      : JSON.stringify({ supersedeIds: [], conflictIds: [] })
});

describe('updateFactText', () => {
  it('rewrites text + norm in place and invalidates the cached vector', () => {
    const id = store.upsertFact('radsej taby ako medzery', { source: 'explicit', confidence: 1 })!;
    store.upsertFactVector(id, 'test-model', new Float32Array([1, 0]));
    expect(store.getFactVectors('test-model').has(id)).toBe(true);

    const survivor = store.updateFactText(id, 'The user prefers tabs over spaces.');
    expect(survivor).toBe(id);
    const fact = store.getFactDetails(id)!;
    expect(fact.text).toBe('The user prefers tabs over spaces.');
    expect(fact.status).toBe('active');
    // The stale embedding must not survive a text change.
    expect(store.getFactVectors('test-model').has(id)).toBe(false);
    // The FTS trigger followed the update: the new wording is searchable.
    expect(store.factTermSearch('"tabs" AND "spaces"', 10).some((f) => f.id === id)).toBe(true);
  });

  it('merges into an existing fact on a norm collision instead of violating UNIQUE', () => {
    const existing = store.upsertFact('The user prefers tabs over spaces.', 'distilled')!;
    const note = store.upsertFact('taby > medzery', { source: 'explicit', confidence: 1 })!;

    const survivor = store.updateFactText(note, 'The user prefers tabs over spaces.');
    expect(survivor).toBe(existing);
    // The user just re-asserted the claim: the survivor ratchets to explicit…
    const kept = store.getFactDetails(existing)!;
    expect(kept.source).toBe('explicit');
    expect(kept.confidence).toBe(1);
    // …and the duplicate note is retired, pointing at the survivor.
    const retired = store.getFactDetails(note)!;
    expect(retired.status).toBe('superseded');
    expect(retired.supersededBy).toBe(existing);
  });

  it('returns null for empty text, a missing fact, or a superseded fact', () => {
    const id = store.upsertFact('The user lives in Bratislava.', 'explicit')!;
    expect(store.updateFactText(id, '   ')).toBeNull();
    expect(store.updateFactText(999_999, 'The user is nobody.')).toBeNull();
    store.supersedeFact(id);
    expect(store.updateFactText(id, 'The user lives in Košice.')).toBeNull();
  });

  it('is a no-op survivor when the text is unchanged', () => {
    const id = store.upsertFact('The user prefers dark mode.', 'explicit')!;
    expect(store.updateFactText(id, 'The user prefers dark mode.')).toBe(id);
    expect(store.getFactDetails(id)!.text).toBe('The user prefers dark mode.');
  });
});

describe('addMemoryNote', () => {
  it('saves an explicit, confidence-1, unpinned fact with explicit_user evidence', async () => {
    const result = await addMemoryNote('prefers tabs over spaces');
    expect(result.saved).toBe(true);
    const fact = store.getFactDetails(result.factId!)!;
    expect(fact.source).toBe('explicit');
    expect(fact.confidence).toBe(1);
    expect(fact.pinned).toBe(false);
    expect(fact.status).toBe('active');
    expect(fact.evidence).toHaveLength(1);
    expect(fact.evidence[0].origin).toBe('explicit_user');
  });

  it('rejects empty / whitespace-only notes', async () => {
    expect(await addMemoryNote('   ')).toEqual({ saved: false, reason: 'empty' });
  });

  it('refuses when memory is disabled', async () => {
    await setMemoryEnabled(false);
    expect(await addMemoryNote('prefers tabs')).toEqual({ saved: false, reason: 'disabled' });
  });

  it('never stores credential-looking notes', async () => {
    expect(await addMemoryNote('my password is hunter2')).toEqual({ saved: false, reason: 'secret' });
    expect(store.getAllFacts()).toHaveLength(0);
  });

  it('keeps long pastes (fact-extraction input) and only truncates runaway ones', async () => {
    const wall = await addMemoryNote(`insurance details: ${'x'.repeat(5000)}`);
    expect(wall.saved).toBe(true);
    expect(store.getFactDetails(wall.factId!)!.text.length).toBeGreaterThan(5000);

    const runaway = await addMemoryNote(`log dump ${'y'.repeat(30_000)}`);
    expect(runaway.saved).toBe(true);
    expect(store.getFactDetails(runaway.factId!)!.text.length).toBeLessThanOrEqual(20_000);
  });
});

describe('normalizeExplicitNote / processExplicitNote', () => {
  it('rewrites the note to the canonical form in place', async () => {
    const { factId } = await addMemoryNote('radsej taby ako medzery');
    const survivor = await normalizeExplicitNote(factId!, llmReturning(rewriteReply('The user prefers tabs over spaces.')));
    expect(survivor).toBe(factId);
    expect(store.getFactDetails(factId!)!.text).toBe('The user prefers tabs over spaces.');
  });

  it('leaves the raw note intact when the model is unreachable', async () => {
    const { factId } = await addMemoryNote('radsej taby ako medzery');
    const dead = { complete: async (): Promise<string> => { throw new Error('backend down'); } };
    await expect(processExplicitNote(factId!, dead)).resolves.toBeUndefined();
    expect(store.getFactDetails(factId!)!.text).toBe('radsej taby ako medzery');
  });

  it('rejects garbage, empty, and oversized rewrites', async () => {
    const { factId } = await addMemoryNote('prefers tabs');
    for (const reply of ['not json at all', rewriteReply(''), rewriteReply(`The user ${'x'.repeat(600)}`)]) {
      expect(await normalizeExplicitNote(factId!, llmReturning(reply))).toBe(factId);
      expect(store.getFactDetails(factId!)!.text).toBe('prefers tabs');
    }
  });

  it('does not write when the facts store is reset mid-flight', async () => {
    const { factId } = await addMemoryNote('prefers tabs');
    const resettingLlm = {
      complete: async () => {
        store.resetFacts();
        return rewriteReply('The user prefers tabs over spaces.');
      }
    };
    expect(await normalizeExplicitNote(factId!, resettingLlm)).toBe(factId);
    expect(store.getAllFacts()).toHaveLength(0);
  });

  it('does not write when the fact text changed while the model was thinking', async () => {
    const { factId } = await addMemoryNote('prefers tabs');
    const racingLlm = {
      complete: async () => {
        store.updateFactText(factId!, 'The user prefers spaces, actually.');
        return rewriteReply('The user prefers tabs over spaces.');
      }
    };
    expect(await normalizeExplicitNote(factId!, racingLlm)).toBe(factId);
    expect(store.getFactDetails(factId!)!.text).toBe('The user prefers spaces, actually.');
  });

  it('merges onto an existing claim and reconciles with the surviving id', async () => {
    const existing = store.upsertFact('The user prefers tabs over spaces.', 'distilled')!;
    const { factId } = await addMemoryNote('taby > medzery');
    await processExplicitNote(factId!, rewriteOnlyLlm('The user prefers tabs over spaces.'));
    expect(store.getFactDetails(factId!)!.status).toBe('superseded');
    const kept = store.getFactDetails(existing)!;
    expect(kept.source).toBe('explicit');
    expect(kept.status).toBe('active');
  });
});

describe('long notes: extractNoteFacts', () => {
  // A wall of text long enough to cross the split threshold.
  const wall = `Trip notes. ${'Flight details and packing thoughts. '.repeat(20)}We fly to Ghent on 17 July, staying at Hotel Harmony, booking ref GH-4411. Miriam is vegetarian.`;
  // validUntil must lie in the future: expireFacts() retires past-dated facts on
  // every store read. (A hardcoded date here once turned into a time bomb — the
  // suite started failing the day the fixture's trip dates passed.)
  const tripDay = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const claimsReply = JSON.stringify({
    claims: [
      { text: `The user flies to Ghent on ${tripDay}.`, category: 'schedule', sensitivity: 'sensitive', validUntil: tripDay },
      { text: 'The user is staying at Hotel Harmony in Ghent, booking ref GH-4411.', category: 'schedule', sensitivity: 'sensitive', validUntil: tripDay },
      { text: "The user's companion Miriam is vegetarian.", category: 'relationship', sensitivity: 'standard', validUntil: null }
    ]
  });
  /** Answers the extraction prompt with `reply`; reconcile prompts get empty relations. */
  const extractLlm = (reply: string) => ({
    complete: async (prompt: string) =>
      /Break it into separate DURABLE facts/.test(prompt)
        ? reply
        : JSON.stringify({ supersedeIds: [], conflictIds: [] })
  });

  it('splits a pasted wall of text into individual explicit facts and retires the blob', async () => {
    expect(wall.length).toBeGreaterThan(LONG_NOTE_THRESHOLD);
    const { factId } = await addMemoryNote(wall);
    await processExplicitNote(factId!, extractLlm(claimsReply));

    const active = store.getAllFacts().filter((f) => f.status === 'active');
    expect(active).toHaveLength(3);
    for (const f of active) {
      expect(f.source).toBe('explicit');
      expect(f.confidence).toBe(1);
      // Provenance: each piece carries the original note as evidence.
      expect(store.getFactEvidence(f.id)[0]?.origin).toBe('explicit_user');
    }
    // The raw blob no longer competes at inject time, but points at its pieces.
    const blob = store.getFactDetails(factId!)!;
    expect(blob.status).toBe('superseded');
    expect(blob.supersededBy).toBe(active[0].id);
  });

  it('keeps the raw blob active when the model is unreachable or finds nothing', async () => {
    const { factId } = await addMemoryNote(wall);
    const dead = { complete: async (): Promise<string> => { throw new Error('backend down'); } };
    await expect(processExplicitNote(factId!, dead)).resolves.toBeUndefined();
    expect(store.getFactDetails(factId!)!.status).toBe('active');

    expect(await extractNoteFacts(factId!, extractLlm(JSON.stringify({ claims: [] })))).toEqual([]);
    expect(store.getFactDetails(factId!)!.status).toBe('active');
  });

  it('does not write when the store is reset while the model was thinking', async () => {
    const { factId } = await addMemoryNote(wall);
    const resettingLlm = {
      complete: async () => {
        store.resetFacts();
        return claimsReply;
      }
    };
    expect(await extractNoteFacts(factId!, resettingLlm)).toEqual([]);
    expect(store.getAllFacts()).toHaveLength(0);
  });

  it('accepts a list kept together as one fact even past the distill length cap', async () => {
    // A coherent list fact between distill's 300-char cap and the note ceiling.
    const listFact = `The user still wants to visit these Bratislava restaurants: ${Array.from({ length: 25 }, (_, i) => `Restaurant ${i + 1}`).join(', ')}.`;
    expect(listFact.length).toBeGreaterThan(300);
    expect(listFact.length).toBeLessThanOrEqual(500);
    const { factId } = await addMemoryNote(wall);
    const ids = await extractNoteFacts(factId!, extractLlm(JSON.stringify({
      claims: [{ text: listFact, category: 'preference', sensitivity: 'standard', validUntil: null }]
    })));
    expect(ids).toHaveLength(1);
    expect(store.getFactDetails(ids[0])!.text).toBe(listFact);
  });

  it('dedups extracted claims onto existing facts instead of duplicating them', async () => {
    const existing = store.upsertFact("The user's companion Miriam is vegetarian.", 'distilled')!;
    const { factId } = await addMemoryNote(wall);
    const ids = await extractNoteFacts(factId!, extractLlm(claimsReply));
    expect(ids).toContain(existing);
    // The re-asserted fact ratchets to explicit; no duplicate row appears.
    const kept = store.getFactDetails(existing)!;
    expect(kept.source).toBe('explicit');
    expect(store.getAllFacts().filter((f) => f.status === 'active')).toHaveLength(3);
  });
});

describe('long-note extraction failure fallback', () => {
  it('reconciles the raw note when extraction returns nothing', async () => {
    const existing = store.upsertFact('The user rents a flat in Bratislava.', 'distilled')!;
    const noteText = `I bought an apartment in Nitra. ${'More context about the purchase and the mortgage details. '.repeat(20)}`;
    expect(noteText.length).toBeGreaterThan(LONG_NOTE_THRESHOLD);
    const factId = store.upsertFact(noteText, { source: 'explicit', confidence: 1 })!;
    const llm = {
      complete: async (prompt: string) =>
        prompt.includes('Return ONLY JSON {"supersedeIds":[],"conflictIds":[]}')
          ? JSON.stringify({ supersedeIds: [existing], conflictIds: [] })
          : 'garbled nonsense the extractor cannot parse'
    };
    // Extraction fails (unparseable reply) -> before the fix the raw blob was
    // never reconciled and silently coexisted with the facts it contradicts.
    await processExplicitNote(factId, llm);
    expect(store.getFactDetails(existing)?.status).toBe('superseded');
    expect(store.getFactDetails(existing)?.supersededBy).toBe(factId);
  });
});
