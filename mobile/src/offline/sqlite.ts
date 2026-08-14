// The one place expo-sqlite is imported.
//
// Everything that decides anything lives in ./cache.ts and takes this as an
// injected `open()`, so the cache's rules — what is kept, what is served, what is
// evicted — can be tested in Node with no simulator and no native module, which
// is the same bargain the rest of this app makes (see vitest.config.mts).
//
// The file is deliberately named for what it is. It sits in the app's own
// documents/SQLite directory, is never backed up anywhere Stem knows about, and
// deleting it costs one catch-up run: it holds only copies of what the server
// still has.

import { openDatabaseSync } from 'expo-sqlite';
import type { CacheDatabase } from './cache';

export const CACHE_DATABASE_NAME = 'stem-offline-cache.db';

export function openCacheDatabase(): CacheDatabase {
  return openDatabaseSync(CACHE_DATABASE_NAME);
}
