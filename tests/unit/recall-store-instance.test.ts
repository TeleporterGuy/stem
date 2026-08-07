import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RecallStore } from '../../src/server/recall/store';

// The point of the class refactor: a store is constructible over any path, so
// tests can run isolated instances side by side (no shared module-global handle).

const dir = mkdtempSync(join(tmpdir(), 'stem-recall-instance-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('RecallStore instances', () => {
  it('two instances over different paths are fully isolated', () => {
    const a = new RecallStore(() => join(dir, 'a.sqlite'));
    const b = new RecallStore(() => join(dir, 'b.sqlite'));
    try {
      a.recordMessage({ threadId: 't-a', role: 'user', text: 'Only store A holds the venice trip plan.' });
      b.recordMessage({ threadId: 't-b', role: 'user', text: 'Only store B holds the tax deadline note.' });
      expect(a.messageCount()).toBe(1);
      expect(b.messageCount()).toBe(1);
      expect(a.search('venice')).toHaveLength(1);
      expect(a.search('tax deadline')).toHaveLength(0);
      expect(b.search('tax deadline')).toHaveLength(1);
      const factId = a.upsertFact('The user visits Venice each spring', 'distilled', { confidence: 0.9 })!;
      expect(a.getFactDetails(factId)).not.toBeNull();
      expect(b.getFactDetails(factId)).toBeNull();
    } finally {
      a.close();
      b.close();
    }
  });

  it('methods stay bound when destructured (arrow-property contract)', () => {
    const store = new RecallStore(() => join(dir, 'c.sqlite'));
    try {
      const { recordMessage, messageCount } = store;
      recordMessage({ threadId: 't-c', role: 'user', text: 'Detached call still hits the right instance.' });
      expect(messageCount()).toBe(1);
    } finally {
      store.close();
    }
  });

  it('close() allows reopening over a repointed path getter', () => {
    let path = join(dir, 'd1.sqlite');
    const store = new RecallStore(() => path);
    try {
      store.recordMessage({ threadId: 't-d', role: 'user', text: 'First database file.' });
      expect(store.messageCount()).toBe(1);
      store.close();
      path = join(dir, 'd2.sqlite');
      expect(store.messageCount()).toBe(0); // fresh file, fresh schema
    } finally {
      store.close();
    }
  });
});
