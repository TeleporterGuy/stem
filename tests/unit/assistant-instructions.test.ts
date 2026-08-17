import { afterEach, describe, expect, it } from 'vitest';
import { setHost } from '../../src/server/host';
import { stemAssistantInstructions } from '../../src/server/workspace/bootstrap';

// The system prompt has to tell the assistant which computer it is on, because
// it has no other way of finding out — and it was telling everybody the same
// thing. On a server install that produced the "grafana" conversation: the
// assistant looked for a missing `uvx` on the user's Mac, then explained that
// its shell "isn't running on your Mac", when the shell it had was the server's
// and the server was exactly where the missing `uvx` was.

const asHost = (kind: 'desktop' | 'server') => setHost({ kind: () => kind });

// The suite's shared host is the headless default; put it back.
afterEach(() => asHost('server'));

describe('stemAssistantInstructions', () => {
  it('says the machine is the user’s own when Stem runs on the desktop', () => {
    asHost('desktop');
    const prompt = stemAssistantInstructions();
    expect(prompt).toContain('## Where you are running');
    expect(prompt).toMatch(/running on the user's own computer/);
    expect(prompt).not.toContain('NOT running on the computer the user is typing on');
  });

  it('says the machine is the server, and what follows from that, when headless', () => {
    asHost('server');
    const prompt = stemAssistantInstructions();
    expect(prompt).toContain('NOT running on the computer the user is typing on');
    // The two consequences the failed conversation needed: the missing program is
    // missing HERE, and the assistant does have a shell — the server's.
    expect(prompt).toMatch(/which machine is missing it/);
    expect(prompt).toMatch(/you have the server's/);
  });

  it('keeps the deployment section between the guide index and the output rules', () => {
    const prompt = stemAssistantInstructions();
    expect(prompt.indexOf('## About Stem itself')).toBeLessThan(prompt.indexOf('## Where you are running'));
    expect(prompt.indexOf('## Where you are running')).toBeLessThan(prompt.indexOf('## Output format'));
    // The whole prompt is still there, both sides of the splice.
    expect(prompt).toContain('You are Stem, a general-purpose personal assistant');
    expect(prompt).toContain('read_stem_guide');
    expect(prompt).toContain('<Callout type="info|warn|success|danger">');
  });

  it('explains what a missing command on the wrong machine looks like', () => {
    const prompt = stemAssistantInstructions();
    expect(prompt).toContain('spawn uvx ENOENT');
    expect(prompt).toContain('Move to');
  });

  it('tells the server assistant the ladder for a missing program', () => {
    asHost('server');
    const prompt = stemAssistantInstructions();
    // Run-on-demand first, then a persistent install, then apt with its caveat.
    expect(prompt).toContain('uvx <tool>');
    expect(prompt).toContain('npx -y <package>');
    expect(prompt).toContain('uv tool install');
    expect(prompt).toMatch(/apt install goes with it/);
    expect(prompt).toContain('Dockerfile.local');
    // None of that applies to a desktop install, where PATH is the user's own.
    asHost('desktop');
    expect(stemAssistantInstructions()).not.toContain('uv tool install');
  });
});
