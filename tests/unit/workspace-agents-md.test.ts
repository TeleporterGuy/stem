import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureWorkspace } from '../../src/server/workspace/bootstrap';
import { agentsMdPath } from '../../src/server/workspace/paths';

// AGENTS.md is a leftover from the codex backend. pi receives the instructions as
// --append-system-prompt AND loads any AGENTS.md in its cwd, so the file was a
// second copy of the same ~4KB every turn — and, being written only when absent, a
// copy from before the interactive components existed went on telling the model
// "use ONLY these components" over a list of three, suppressing the rest.

describe('the duplicate AGENTS.md in the backend cwd', () => {
  it('is removed on startup', async () => {
    const path = agentsMdPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '# Stem Assistant\n\nOnly <Callout> exists.\n', 'utf8');

    await ensureWorkspace();

    expect(existsSync(path)).toBe(false);
  });

  it('is not recreated, and a second pass over a clean workspace is a no-op', async () => {
    await ensureWorkspace();
    await ensureWorkspace();
    expect(existsSync(agentsMdPath())).toBe(false);
  });
});
