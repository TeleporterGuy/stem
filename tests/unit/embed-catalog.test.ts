// Catalog suite — the pure data/helpers behind the local embedding backend:
// prompt prefixes (the multilingual models are prefix-sensitive), the vector-
// cache key namespace, and the mode → effective-cache-key mapping.
import { describe, expect, it } from 'vitest';
import {
  applyPrefixes,
  DEFAULT_LOCAL_EMBED_MODEL,
  effectiveEmbedModelKey,
  EMBED_CATALOG,
  localModelCacheKey
} from '../../src/server/recall/embed-catalog';
import type { EmbeddingsSettings } from '../../src/shared/types';

const base: EmbeddingsSettings = {
  mode: 'local',
  localModel: 'multilingual-e5-small',
  baseUrl: 'http://localhost:11434',
  model: 'qwen3-embedding:8b',
  apiKey: null
};

describe('embed catalog', () => {
  it('applies the e5 query/passage prefixes verbatim', () => {
    const spec = EMBED_CATALOG['multilingual-e5-small'];
    expect(applyPrefixes(spec, 'query', ['kde bývam?'])).toEqual(['query: kde bývam?']);
    expect(applyPrefixes(spec, 'passage', ['I live in Košice'])).toEqual(['passage: I live in Košice']);
  });

  it('applies the EmbeddingGemma prompt prefixes from its model card', () => {
    const spec = EMBED_CATALOG['embeddinggemma-300m'];
    expect(applyPrefixes(spec, 'query', ['x'])).toEqual(['task: search result | query: x']);
    expect(applyPrefixes(spec, 'passage', ['x'])).toEqual(['title: none | text: x']);
  });

  it('namespaces local cache keys so they can never collide with remote model ids', () => {
    for (const spec of Object.values(EMBED_CATALOG)) {
      expect(localModelCacheKey(spec)).toBe(`local:${spec.repo}`);
    }
  });

  it('has a default model that exists in the catalog', () => {
    expect(EMBED_CATALOG[DEFAULT_LOCAL_EMBED_MODEL]).toBeDefined();
  });

  it('maps mode to the effective vector-cache key', () => {
    expect(effectiveEmbedModelKey(base)).toBe('local:Xenova/multilingual-e5-small');
    expect(effectiveEmbedModelKey({ ...base, mode: 'remote' })).toBe('qwen3-embedding:8b');
    expect(effectiveEmbedModelKey({ ...base, mode: 'off' })).toBe('');
  });
});
