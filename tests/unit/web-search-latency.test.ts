// The latency CONTRACT of a multi-query web search, asserted on shape rather than
// on a stopwatch.
//
// History: search used to be an openai-codex-only trick — the provider's own
// server-side web_search tool injected into the chat model's request, so searching
// cost zero extra round trips and barely registered as tool time. Moving to the
// vendored pi-web-access extension bought search on every provider, and quietly
// changed the cost model: each query became a separate full inference against a
// Responses endpoint, and the package ran them in an indexed `for` loop with an
// `await` inside. Stem's own turn_timings tell the story — median web-search turn
// 39.6s before the switch, 99.8s after, with average tool time up ~10x.
//
// Nobody noticed because nothing measured it. A wall-clock threshold would not
// have caught it either: on a live network it flakes, and under pressure the
// threshold is what gets raised. What actually regressed is the SHAPE of the work
// (one inference -> N sequential inferences), and shape is testable offline and
// deterministically. That is what this file pins:
//
//   1. N queries issue N upstream calls — no hidden fan-out.
//   2. They overlap. A serial regression fails here, with no timing assertion.
//   3. The call as a whole has a deadline, and blowing it degrades to partial
//      results instead of hanging the turn.
//   4. The model behind the search is pinned, not "first id found in the registry".
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runSearchBatch,
  DEFAULT_SEARCH_CONCURRENCY,
  DEFAULT_SEARCH_BUDGET_MS
} from 'pi-web-access/search-batch.ts';

const QUERIES = ['alpha', 'beta', 'gamma', 'delta'];

/** A search stub that never settles on its own — the test decides when each one does. */
function gatedSearch() {
  const gates: { query: string; resolve: (v: string) => void; reject: (e: unknown) => void }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const search = (query: string): Promise<string> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<string>((resolve, reject) => {
      gates.push({
        query,
        resolve: (v) => {
          inFlight--;
          resolve(v);
        },
        reject: (e) => {
          inFlight--;
          reject(e);
        }
      });
    });
  };
  return {
    search,
    gates,
    get maxInFlight() {
      return maxInFlight;
    }
  };
}

/** Let the microtask queue drain so started-but-unsettled workers are observable. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('multi-query search fans out instead of queueing', () => {
  it('issues exactly one upstream call per query', async () => {
    const calls: string[] = [];
    const entries = await runSearchBatch(
      QUERIES,
      { search: async (q) => (calls.push(q), `answer:${q}`) },
      { concurrency: 4 }
    );
    expect(calls).toEqual(QUERIES);
    expect(entries.map((e) => e.value)).toEqual(QUERIES.map((q) => `answer:${q}`));
  });

  // THE regression test. Before this, four queries meant four round trips end to
  // end: ~53s of a 132s turn for one call, twice over. Nothing here measures
  // duration — a serial implementation simply never gets past the first gate.
  it('starts every query before any of them has answered', async () => {
    const stub = gatedSearch();
    const batch = runSearchBatch(QUERIES, { search: stub.search }, { concurrency: 4 });

    await settle();
    expect(stub.gates.map((g) => g.query)).toEqual(QUERIES);
    expect(stub.maxInFlight).toBe(4);

    for (const gate of stub.gates) gate.resolve('ok');
    await batch;
  });

  it('honours the concurrency cap so a 20-query call cannot stampede a provider', async () => {
    const stub = gatedSearch();
    const many = Array.from({ length: 20 }, (_, i) => `q${i}`);
    const batch = runSearchBatch(many, { search: stub.search }, { concurrency: 4 });

    await settle();
    expect(stub.gates).toHaveLength(4);

    // Draining one slot starts exactly one more.
    stub.gates[0].resolve('ok');
    await settle();
    expect(stub.gates).toHaveLength(5);

    // Release the rest in waves; each wave admits only as many as it freed.
    for (let next = 1; next < many.length; ) {
      for (; next < stub.gates.length; next++) stub.gates[next].resolve('ok');
      await settle();
    }
    await batch;
    expect(stub.maxInFlight).toBeLessThanOrEqual(4);
  });

  it('returns results in query order, not completion order', async () => {
    const stub = gatedSearch();
    const batch = runSearchBatch(QUERIES, { search: stub.search }, { concurrency: 4 });
    await settle();

    // Settle backwards.
    for (const gate of [...stub.gates].reverse()) gate.resolve(`answer:${gate.query}`);

    const entries = await batch;
    expect(entries.map((e) => e.query)).toEqual(QUERIES);
    expect(entries.map((e) => e.value)).toEqual(QUERIES.map((q) => `answer:${q}`));
  });

  it('keeps a failed query local to its own slot', async () => {
    const entries = await runSearchBatch(
      QUERIES,
      {
        search: async (q) => {
          if (q === 'beta') throw new Error('provider exploded');
          return `answer:${q}`;
        }
      },
      { concurrency: 4 }
    );
    expect(entries[1]).toEqual({ query: 'beta', error: 'provider exploded' });
    expect(entries.filter((e) => e.error === null)).toHaveLength(3);
  });
});

describe('the call as a whole is bounded', () => {
  // Per-query timeouts are 30-60s each depending on backend and there was no
  // ceiling above them, so a slow provider could hold a turn for minutes with the
  // user watching a spinner. The deadline must degrade the answer, not fail it.
  it('returns partial results when the budget runs out', async () => {
    const stub = gatedSearch();
    const batch = runSearchBatch(
      QUERIES,
      { search: (q, _i, signal) => (q === 'alpha' ? stub.search(q) : new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) },
      { concurrency: 4, budgetMs: 25 }
    );

    await settle();
    stub.gates[0].resolve('answer:alpha');

    const entries = await batch;
    expect(entries[0].value).toBe('answer:alpha');
    expect(entries[0].error).toBeNull();
    for (const entry of entries.slice(1)) {
      expect(entry.value).toBeUndefined();
      expect(entry.error).toMatch(/budget/i);
    }
  });

  it('accounts for queries the deadline never let start', async () => {
    const entries = await runSearchBatch(
      ['a', 'b', 'c'],
      { search: (_q, _i, signal) => new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) },
      { concurrency: 1, budgetMs: 25 }
    );
    expect(entries).toHaveLength(3);
    // Silence here would let the model believe it searched all three.
    for (const entry of entries) expect(entry.error).toMatch(/budget/i);
  });

  it('still fails the whole call when the user cancels the turn', async () => {
    const controller = new AbortController();
    const batch = runSearchBatch(
      QUERIES,
      { search: (_q, _i, signal) => new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) },
      { concurrency: 4, signal: controller.signal }
    );
    await settle();
    controller.abort();
    await expect(batch).rejects.toThrow();
  });

  it('keeps the defaults inside what a turn can absorb', () => {
    expect(DEFAULT_SEARCH_CONCURRENCY).toBeGreaterThanOrEqual(3);
    // A user is watching a spinner for this long. 4 queries x 60s serial was 4min.
    expect(DEFAULT_SEARCH_BUDGET_MS).toBeLessThanOrEqual(120_000);
  });
});

describe('the search model is pinned, not discovered', () => {
  // pi-web-access resolves the OpenAI backend by walking AUTH_MODEL_CANDIDATES and
  // taking the first id present in pi's registry. Signing into an account that has
  // a newer flagship therefore re-points every search at it — slower and dearer,
  // with no setting touched and nothing logged. Worse, it is invisible: the model
  // doing your searches is not the model in the picker.
  it('writes the pinned model into the file the extension reads', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stem-websearch-perf-'));
    vi.doMock('../../src/main/workspace/paths', () => ({ piHome: () => home }));
    const { writeWebSearchConfig, webSearchConfigPath, OPENAI_SEARCH_MODEL } = await import(
      '../../src/main/pi/web-search'
    );
    try {
      await writeWebSearchConfig({ main: true, quickChat: true, provider: 'auto', credentials: {} });
      const file = JSON.parse(readFileSync(webSearchConfigPath(), 'utf8')) as Record<string, unknown>;
      expect(file.openaiSearchModel).toBe(OPENAI_SEARCH_MODEL);
    } finally {
      rmSync(home, { recursive: true, force: true });
      vi.doUnmock('../../src/main/workspace/paths');
    }
  });
});
