import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STEM_ASSISTANT_INSTRUCTIONS, ensureWorkspace } from '../../src/main/workspace/bootstrap';
import { agentsMdPath } from '../../src/main/workspace/paths';

// AGENTS.md is generated from STEM_ASSISTANT_INSTRUCTIONS, and pi loads it from the
// backend cwd IN ADDITION to the same text we pass as --append-system-prompt. It used
// to be seeded once and never rewritten, so a copy written before the interactive
// components existed kept telling the model "use ONLY these components" over a list
// of three — a narrower instruction that suppressed DataTable/Chart/Tabs for the life
// of the install.

describe('AGENTS.md stays in step with the instructions it is generated from', () => {
  it('rewrites a stale copy on startup', async () => {
    const path = agentsMdPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '# Stem Assistant\n\nOnly <Callout> exists.\n', 'utf8');

    await ensureWorkspace();

    const written = readFileSync(path, 'utf8');
    expect(written).toContain(STEM_ASSISTANT_INSTRUCTIONS);
    expect(written).toContain('<DataTable');
    expect(written).not.toContain('Only <Callout> exists.');
  });

  it('is idempotent — a current copy is left byte-identical', async () => {
    const path = agentsMdPath();
    await ensureWorkspace();
    const first = readFileSync(path, 'utf8');
    await ensureWorkspace();
    expect(readFileSync(path, 'utf8')).toBe(first);
  });
});
