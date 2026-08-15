import { useEffect, useState } from 'react';
import type { LocalEmbedStatus, LocalRerankStatus } from '../../shared/types';

export interface RetrievalHealth {
  /** Failure text while the built-in embedding model is down, else null. */
  embedError: string | null;
  /** Failure text while the built-in reranker model is down, else null. */
  rerankError: string | null;
  /** Either stage is down — drives the red alert dots on the Memory tab. */
  broken: boolean;
}

/**
 * Live health of the built-in retrieval models (embedder + reranker), for the
 * red "something is broken" markers on the Memory tab and inside it. An 'error'
 * here always means a stage the user has switched ON is down and recall is
 * silently degraded (selection falls back to lexical/recency): the manager
 * reports 'idle' for stages left off or set to a server endpoint, and goes back
 * to 'loading' the moment a retry starts — so the marker never outlives the
 * problem it points at.
 */
export function useRetrievalHealth(): RetrievalHealth {
  const [embed, setEmbed] = useState<LocalEmbedStatus | null>(null);
  const [rerank, setRerank] = useState<LocalRerankStatus | null>(null);
  useEffect(() => {
    window.stem.getLocalEmbedStatus().then(setEmbed);
    window.stem.getLocalRerankStatus().then(setRerank);
    const offEmbed = window.stem.onLocalEmbedStatus(setEmbed);
    const offRerank = window.stem.onLocalRerankStatus(setRerank);
    return () => {
      offEmbed();
      offRerank();
    };
  }, []);
  const embedError = embed?.state === 'error' ? (embed.error ?? 'model failed to load') : null;
  const rerankError = rerank?.state === 'error' ? (rerank.error ?? 'model failed to load') : null;
  return { embedError, rerankError, broken: embedError !== null || rerankError !== null };
}
