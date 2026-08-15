// The remote-endpoint verdict cache behind the Memory tab's red markers: the
// wrapped clients must record real request outcomes (and only those — a
// "not configured" throw is the router declining, not the endpoint failing),
// emit only on actual change, and forget a verdict when asked (settings edits).
import { describe, expect, it } from 'vitest';
import { createRemoteHealthTracker } from '../../src/server/recall/remote-health';
import { EmbeddingsUnavailableError, type EmbeddingsClient } from '../../src/server/recall/embeddings';
import type { RerankClient } from '../../src/server/recall/rerank';

function embeddingsClient(embed: EmbeddingsClient['embed']): EmbeddingsClient {
  return { available: async () => true, modelId: async () => 'm', embed };
}

function rerankClient(rerank: RerankClient['rerank']): RerankClient {
  return { available: async () => true, rerank };
}

describe('remote retrieval health tracker', () => {
  it('starts unknown and records success/failure from wrapped calls', async () => {
    const tracker = createRemoteHealthTracker();
    expect(tracker.get()).toEqual({ embeddings: { state: 'unknown' }, reranker: { state: 'unknown' } });

    const ok = tracker.wrapEmbeddings(embeddingsClient(async () => [new Float32Array([1])]));
    await ok.embed(['hi']);
    expect(tracker.get().embeddings).toEqual({ state: 'ok' });

    const dead = tracker.wrapRerank(
      rerankClient(async () => {
        throw new Error('rerank: http://x/rerank → HTTP 502');
      })
    );
    await expect(dead.rerank('q', ['d'], 1)).rejects.toThrow('HTTP 502');
    expect(tracker.get().reranker).toEqual({ state: 'error', error: 'rerank: http://x/rerank → HTTP 502' });
  });

  it('rethrows failures unchanged so callers keep their fallbacks', async () => {
    const tracker = createRemoteHealthTracker();
    const err = new Error('boom');
    const wrapped = tracker.wrapEmbeddings(
      embeddingsClient(async () => {
        throw err;
      })
    );
    await expect(wrapped.embed(['hi'])).rejects.toBe(err);
  });

  it('does not count "not configured" as an endpoint failure', async () => {
    const tracker = createRemoteHealthTracker();
    const wrapped = tracker.wrapEmbeddings(
      embeddingsClient(async () => {
        throw new EmbeddingsUnavailableError();
      })
    );
    await expect(wrapped.embed(['hi'])).rejects.toBeInstanceOf(EmbeddingsUnavailableError);
    expect(tracker.get().embeddings.state).toBe('unknown');
  });

  it('emits only when the verdict actually changes', async () => {
    const tracker = createRemoteHealthTracker();
    const seen: string[] = [];
    tracker.onChange((h) => seen.push(`${h.embeddings.state}:${h.embeddings.error ?? ''}`));
    const wrapped = tracker.wrapEmbeddings(embeddingsClient(async () => [new Float32Array([1])]));
    await wrapped.embed(['a']);
    await wrapped.embed(['b']); // same verdict — must not re-emit
    tracker.recordError('embeddings', 'HTTP 500');
    tracker.recordError('embeddings', 'HTTP 500'); // same error — must not re-emit
    tracker.recordError('embeddings', 'HTTP 502'); // new message — must emit
    expect(seen).toEqual(['ok:', 'error:HTTP 500', 'error:HTTP 502']);
  });

  it('reset forgets one stage and leaves the other alone', () => {
    const tracker = createRemoteHealthTracker();
    tracker.recordError('embeddings', 'HTTP 500');
    tracker.recordOk('reranker');
    tracker.reset('embeddings');
    expect(tracker.get()).toEqual({ embeddings: { state: 'unknown' }, reranker: { state: 'ok' } });
  });
});
