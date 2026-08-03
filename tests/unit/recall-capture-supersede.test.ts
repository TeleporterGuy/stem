import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RecallStore } from '../../src/main/recall/store';

// One turn can hold several assistant messages (see pi/normalize.ts), and each
// completed one carries the reply SO FAR — so a single reply reaches capture two or
// three times, each time longer. Without superseding, Recall ends up holding the
// same answer nested inside itself once per message.

const dir = mkdtempSync(join(tmpdir(), 'stem-recall-supersede-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('recordMessage superseding a growing reply', () => {
  it('keeps only the longest capture of one turn', () => {
    const store = new RecallStore(() => join(dir, 'grow.sqlite'));
    try {
      store.recordMessage({ threadId: 'T', turnId: 'turn1', role: 'assistant', text: 'Odporúčam Beko' });
      store.recordMessage({
        threadId: 'T',
        turnId: 'turn1',
        role: 'assistant',
        text: 'Odporúčam Beko\n\nBeko je najlepšia kúpa.'
      });
      expect(store.messageCount()).toBe(1);
      expect(store.search('najlepšia')).toHaveLength(1);
      // The FTS mirror follows the delete, so the superseded row leaves no ghost hit.
      expect(store.search('Odporúčam')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('leaves a different turn, role, or thread alone', () => {
    const store = new RecallStore(() => join(dir, 'scoped.sqlite'));
    try {
      store.recordMessage({ threadId: 'T', turnId: 'turn1', role: 'user', text: 'Compare' });
      store.recordMessage({ threadId: 'T', turnId: 'turn2', role: 'assistant', text: 'Compare' });
      store.recordMessage({ threadId: 'U', turnId: 'turn1', role: 'assistant', text: 'Compare' });
      store.recordMessage({ threadId: 'T', turnId: 'turn1', role: 'assistant', text: 'Compare these two' });
      expect(store.messageCount()).toBe(4);
    } finally {
      store.close();
    }
  });

  // The prefix test is literal: `%` and `_` in a stored reply are not wildcards.
  it('does not treat SQL LIKE wildcards in a stored reply as a match', () => {
    const store = new RecallStore(() => join(dir, 'wild.sqlite'));
    try {
      store.recordMessage({ threadId: 'T', turnId: 'turn1', role: 'assistant', text: '50% off' });
      store.recordMessage({ threadId: 'T', turnId: 'turn1', role: 'assistant', text: '50X off, actually' });
      expect(store.messageCount()).toBe(2);
    } finally {
      store.close();
    }
  });

  // An unrelated shorter message is not a prefix, so it survives.
  it('keeps an unrelated message from the same turn', () => {
    const store = new RecallStore(() => join(dir, 'unrelated.sqlite'));
    try {
      store.recordMessage({ threadId: 'T', turnId: 'turn1', role: 'assistant', text: 'first thought' });
      store.recordMessage({ threadId: 'T', turnId: 'turn1', role: 'assistant', text: 'a different answer' });
      expect(store.messageCount()).toBe(2);
    } finally {
      store.close();
    }
  });
});
