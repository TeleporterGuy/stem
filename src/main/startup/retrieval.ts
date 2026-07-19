import { app } from 'electron';
import { readSettings } from '../workspace/settings';
import { embedModelsDir, embedSocketPath, recallDbPath } from '../workspace/paths';

import { embedNewMessages } from '../recall/embed-episodic';
import { getEmbeddingsClient, setRetrievalClients } from '../recall/retrieval';
import { startEmbedEndpoint } from '../recall/embed-endpoint';
import { createHttpEmbeddingsClient } from '../recall/embeddings';
import { createHttpRerankClient } from '../recall/rerank';
import { EMBED_CATALOG, localModelCacheKey } from '../recall/embed-catalog';
import { createEmbedWorkerManager, type EmbedWorkerManager } from '../recall/embed-manager';
import { createEmbeddingsRouter, createLocalEmbeddingsClient } from '../recall/embed-local';
import { RERANK_CATALOG } from '../recall/rerank-catalog';
import { createLocalRerankClient, createRerankRouter } from '../recall/rerank-local';
import { spawnEmbedWorker } from '../recall/embed-worker-host';
import { createScanWorkerManager, type ScanWorkerManager } from '../recall/scan-manager';
import { spawnScanWorker } from '../recall/scan-worker-host';
import { setScanWorkerManager } from '../recall/scan';
import { recallStore } from '../recall/store';
const { getFactsGeneration, getFactsMissingVector, pruneMessageVectorsExceptModel, pruneSummaryVectorsExceptModel, pruneVectorsExceptModel, getSummariesMissingVector, upsertFactVectorForSnapshot, upsertSummaryVector } = recallStore;

export interface RetrievalRuntime {
  embedManager: EmbedWorkerManager;
  scanManager: ScanWorkerManager;
}

/**
 * Stem Recall relevance ranking. Embeddings route per the settings mode: the
 * bundled local model (in a utility process; the out-of-box default) or the
 * user's own HTTP endpoint. Config is read fresh each turn, so switching mode
 * or repointing endpoints in Settings takes effect on the next fact-ranking
 * pass with no restart. Off/not-ready → the clients report unavailable and
 * inject falls back to lexical/recency selection — a chat turn never waits on
 * a model download.
 */
export function initRetrieval(deps: {
  e2e: boolean;
  /** Direct push to the main window (status streams; queueing not needed). */
  sendToMainWindow: (channel: string, payload: unknown) => void;
}): RetrievalRuntime {
  const embedManager = createEmbedWorkerManager({ spawn: spawnEmbedWorker, cacheDir: embedModelsDir });
  // Recall's O(N) cosine scans and episodic VACUUMs run in their own utility
  // process so they never block the main event loop; everything degrades to the
  // in-process implementations if the worker is unavailable (see recall/scan.ts).
  const scanManager = createScanWorkerManager({ spawn: spawnScanWorker, dbPath: () => recallDbPath() });
  setScanWorkerManager(scanManager);
  const getEmbedSettings = async () => (await readSettings()).retrieval.embeddings;
  const getRerankSettings = async () => (await readSettings()).retrieval.reranker;
  const localEmbeddings = createLocalEmbeddingsClient(getEmbedSettings, embedManager);
  setRetrievalClients({
    embeddings: createEmbeddingsRouter({
      getMode: async () => (await getEmbedSettings()).mode,
      local: localEmbeddings,
      remote: createHttpEmbeddingsClient(async () => {
        const e = await getEmbedSettings();
        return e.mode === 'remote' && e.baseUrl && e.model
          ? { baseUrl: e.baseUrl, model: e.model, apiKey: e.apiKey }
          : null;
      })
    }),
    // Precision rerank stage: the bundled cross-encoder (co-hosted in the embed
    // worker) or the user's own Cohere/Jina-style /rerank endpoint (llama.cpp
    // --reranking, vLLM, Infinity, TEI — note Ollama can't serve one). Off/not
    // ready → inject degrades to the cosine ranking.
    rerank: createRerankRouter({
      getMode: async () => (await getRerankSettings()).mode,
      local: createLocalRerankClient(getRerankSettings, embedManager),
      remote: createHttpRerankClient(async () => {
        const r = await getRerankSettings();
        return r.mode === 'remote' && r.baseUrl && r.model
          ? { baseUrl: r.baseUrl, model: r.model, apiKey: r.apiKey }
          : null;
      })
    })
  });
  // Serve query embeddings to the stem-recall MCP server over a local unix
  // socket, so search_past_chats gets the same hybrid (semantic) retrieval as
  // auto-inject. Listen failures are logged and non-fatal (tool stays FTS-only).
  const embedEndpoint = startEmbedEndpoint({
    socketPath: embedSocketPath(),
    getClient: getEmbeddingsClient
  });
  app.on('will-quit', () => {
    void embedEndpoint.close();
  });
  embedManager.onRerankStatus((status) => {
    deps.sendToMainWindow('reranker:localStatus', status);
  });
  embedManager.onStatus((status) => {
    deps.sendToMainWindow('embeddings:localStatus', status);
    // The model just came up: prune vectors from previously-used models (local
    // vectors are cheap to regenerate; keeps recall.sqlite tidy) and backfill any
    // facts missing a vector in the background. Without this, inject would embed
    // the entire fact set inline in the first semantic turn — many seconds on CPU.
    if (status.state !== 'ready') return;
    void (async () => {
      try {
        const e = await getEmbedSettings();
        if (e.mode !== 'local' || e.localModel !== status.model) return;
        const key = localModelCacheKey(EMBED_CATALOG[e.localModel]);
        const factsGeneration = getFactsGeneration();
        pruneVectorsExceptModel(key);
        const missing = getFactsMissingVector(key);
        for (let i = 0; i < missing.length; i += 64) {
          if (getFactsGeneration() !== factsGeneration) break;
          const batch = missing.slice(i, i + 64);
          const vecs = await localEmbeddings.embed(
            batch.map((f) => f.text),
            'passage'
          );
          if (getFactsGeneration() !== factsGeneration) break;
          batch.forEach((f, j) =>
            upsertFactVectorForSnapshot(f.id, f.text, factsGeneration, key, vecs[j])
          );
        }
        // Same hygiene + backfill for thread-summary vectors (Level 1.5 search).
        pruneSummaryVectorsExceptModel(key);
        const summariesMissing = getSummariesMissingVector(key);
        for (let i = 0; i < summariesMissing.length; i += 64) {
          const batch = summariesMissing.slice(i, i + 64);
          const vecs = await localEmbeddings.embed(batch.map((s) => s.text), 'passage');
          batch.forEach((s, j) => upsertSummaryVector(s.id, key, vecs[j]));
        }
        // Same hygiene + backfill for the episodic message vectors (semantic
        // episodic search). Watermark-driven and self-guarding, so a concurrent
        // post-turn kick can't double-embed.
        pruneMessageVectorsExceptModel(key);
        await embedNewMessages(localEmbeddings);
      } catch {
        // non-fatal: inject tops up lazily on the next semantic turn
      }
    })();
  });
  // Kick the download/load shortly after launch (instead of on the first turn
  // that needs it) so the model is usually ready before the user accumulates
  // enough facts to matter. The delay only yields the window/backend startup
  // burst — keep it short, or the Manage panel shows a misleading idle state
  // ("not downloaded yet") on every restart until the kick lands. Skipped under
  // E2E: hermetic runs must not hit the network.
  if (!deps.e2e) {
    setTimeout(() => {
      void getEmbedSettings().then((e) => {
        if (e.mode === 'local') embedManager.ensure(EMBED_CATALOG[e.localModel]);
      });
      void getRerankSettings().then((r) => {
        if (r.mode === 'local') embedManager.ensureRerank(RERANK_CATALOG[r.localModel]);
      });
    }, 1_500);
  }
  return { embedManager, scanManager };
}
