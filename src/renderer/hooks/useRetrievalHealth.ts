import { useEffect, useState } from 'react';
import type { LocalEmbedStatus, LocalRerankStatus, RemoteRetrievalHealth } from '../../shared/types';

/** One broken retrieval stage: what failed, and whether it was the user's own
 *  server endpoint (mode 'remote') rather than a built-in model. */
export interface StageFailure {
  error: string;
  remote: boolean;
}

export interface RetrievalHealth {
  /** The embeddings stage failure, else null. */
  embed: StageFailure | null;
  /** The reranker stage failure, else null. */
  rerank: StageFailure | null;
  /** Either stage is down — drives the red alert dots on the Memory tab. */
  broken: boolean;
}

/**
 * Live health of the retrieval stages (embedder + reranker), for the red
 * "something is broken" markers on the Memory tab and inside it. Two sources,
 * one verdict per stage: the built-in models' status streams, and the recorded
 * outcome of the last request to a user-configured remote endpoint. An error
 * from either always means a stage the user has switched ON is down and recall
 * is silently degraded (selection falls back to lexical/recency) — the server
 * reports 'idle'/'unknown' for stages left off or running the other way, clears
 * the remote verdict when its settings change, and goes back to 'loading' the
 * moment a local retry starts — so the marker never outlives the problem it
 * points at.
 */
export function useRetrievalHealth(): RetrievalHealth {
  const [embed, setEmbed] = useState<LocalEmbedStatus | null>(null);
  const [rerank, setRerank] = useState<LocalRerankStatus | null>(null);
  const [remote, setRemote] = useState<RemoteRetrievalHealth | null>(null);
  useEffect(() => {
    window.stem.getLocalEmbedStatus().then(setEmbed);
    window.stem.getLocalRerankStatus().then(setRerank);
    window.stem.getRemoteRetrievalHealth().then(setRemote);
    const offEmbed = window.stem.onLocalEmbedStatus(setEmbed);
    const offRerank = window.stem.onLocalRerankStatus(setRerank);
    const offRemote = window.stem.onRemoteRetrievalHealth(setRemote);
    return () => {
      offEmbed();
      offRerank();
      offRemote();
    };
  }, []);
  // Local and remote can't both be in error for one stage (the mode picks one
  // backend and the server resets the loser), so first-non-null is not a ranking.
  const failure = (
    local: { state: string; error?: string } | null,
    remoteStage: { state: string; error?: string } | undefined
  ): StageFailure | null => {
    if (local?.state === 'error') return { error: local.error ?? 'model failed to load', remote: false };
    if (remoteStage?.state === 'error') return { error: remoteStage.error ?? 'request failed', remote: true };
    return null;
  };
  const embedFailure = failure(embed, remote?.embeddings);
  const rerankFailure = failure(rerank, remote?.reranker);
  return { embed: embedFailure, rerank: rerankFailure, broken: embedFailure !== null || rerankFailure !== null };
}
