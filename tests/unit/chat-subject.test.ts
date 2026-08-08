// Chat subjects — the naming pipeline behind an Inbox row. The sanitizer and the
// auto-title fingerprint are pure; writeSubject runs against the REAL settings and
// chat stores (throwaway paths from tests/setup-unit.ts) with only the model
// stubbed, so the mode gate, the hand-renamed-thread guard and the persistence all
// get exercised the way they run in the app.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { autoTitle, MAX_SUBJECT, sanitizeSubject, subjectPrompt, writeSubject } from '../../src/server/chats/subject';
import { getSubjects, removeChat, setSubject } from '../../src/server/workspace/chats';
import { updateChatsSettings, updateDefaults } from '../../src/server/workspace/settings';
import { chatStorePath, settingsStorePath } from '../../src/server/workspace/paths';

const chatPath = chatStorePath();
const settingsPath = settingsStorePath();

beforeEach(() => {
  mkdirSync(dirname(chatPath), { recursive: true });
  rmSync(chatPath, { force: true });
  rmSync(settingsPath, { force: true });
});
afterEach(() => {
  rmSync(chatPath, { force: true });
  rmSync(settingsPath, { force: true });
});

/**
 * A stubbed thread: the model's canned reply, the name the thread currently
 * carries, and a record of what happened to it.
 */
function stub(opts: { reply?: string; title?: string | null } = {}) {
  const state = { title: opts.title === undefined ? '' : opts.title };
  // Typed the way SubjectDeps declares it, so a test can assert on the run
  // options (model, effort) the writer resolved for this call.
  const complete = vi.fn(
    async (_prompt: string, _opts: { model?: string | null; effort?: string | null; timeoutMs?: number }) =>
      opts.reply ?? 'Quarterly revenue breakdown'
  );
  const rename = vi.fn(async (_id: string, name: string) => {
    state.title = name;
  });
  return {
    state,
    complete,
    rename,
    deps: {
      complete,
      currentTitle: async () => state.title,
      rename
    }
  };
}

describe('autoTitle', () => {
  it('takes the first non-empty line', () => {
    expect(autoTitle('\n\n  pull the Q3 numbers  \nand compare')).toBe('pull the Q3 numbers');
  });

  it('caps a long line with an ellipsis', () => {
    const title = autoTitle('x'.repeat(200));
    expect(title.length).toBe(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('is empty for a message with nothing in it', () => {
    expect(autoTitle('   \n \n')).toBe('');
  });
});

describe('sanitizeSubject', () => {
  it('keeps a well-formed reply as-is', () => {
    expect(sanitizeSubject('Quarterly revenue breakdown')).toBe('Quarterly revenue breakdown');
  });

  it('takes only the first line — models like to explain themselves', () => {
    expect(sanitizeSubject('CI flake in the retry path\n\nI chose this because…')).toBe('CI flake in the retry path');
  });

  it('strips the shape of the question back out', () => {
    expect(sanitizeSubject('Subject: CI flake')).toBe('CI flake');
    expect(sanitizeSubject('Title – CI flake')).toBe('CI flake');
  });

  it('strips wrapping quotes, backticks and asterisks, including nested ones', () => {
    expect(sanitizeSubject('"CI flake"')).toBe('CI flake');
    expect(sanitizeSubject('“CI flake”')).toBe('CI flake');
    expect(sanitizeSubject('**`CI flake`**')).toBe('CI flake');
  });

  it('drops trailing punctuation and collapses inner whitespace', () => {
    expect(sanitizeSubject('CI   flake  in   retries.')).toBe('CI flake in retries');
  });

  it('truncates a slightly-too-long subject and rejects a wildly long one', () => {
    const long = sanitizeSubject('word '.repeat(20).trim());
    expect(long.length).toBe(MAX_SUBJECT);
    expect(long.endsWith('…')).toBe(true);
    // A reply this far past the brief isn't a subject line at all — better no
    // subject than a paragraph as the thread's name.
    expect(sanitizeSubject('x'.repeat(MAX_SUBJECT * 3 + 1))).toBe('');
  });

  it('is empty for an empty or whitespace-only reply', () => {
    expect(sanitizeSubject('')).toBe('');
    expect(sanitizeSubject('\n  \n')).toBe('');
  });
});

describe('subjectPrompt', () => {
  it('carries the message and caps how much of it the model sees', () => {
    const prompt = subjectPrompt(`short one${'x'.repeat(5000)}`);
    expect(prompt).toContain('short one');
    expect(prompt.length).toBeLessThan(3000);
  });
});

describe('writeSubject', () => {
  it('writes the subject and renames the thread at the everywhere default', async () => {
    const s = stub({ title: 'pull the Q3 numbers' });
    const subject = await writeSubject(s.deps, 'a', 'pull the Q3 numbers');
    expect(subject).toBe('Quarterly revenue breakdown');
    expect(s.rename).toHaveBeenCalledWith('a', 'Quarterly revenue breakdown');
    expect((await getSubjects()).a).toBe('Quarterly revenue breakdown');
  });

  it('runs on the subject role’s own model and effort, else the Background work ones', async () => {
    // The seam that swallowed this before: SubjectDeps.complete took `{ model,
    // timeoutMs }` and the effort rode in on a spread, so it type-checked either
    // way and a destructure at the other end would have dropped it silently.
    await updateDefaults({ backgroundModel: 'x/bg', backgroundEffort: 'low' });
    const shared = stub({ title: '' });
    await writeSubject(shared.deps, 'a', 'pull the Q3 numbers');
    expect(shared.complete.mock.calls[0][1]).toMatchObject({ model: 'x/bg', effort: 'low' });

    await updateChatsSettings({ subjectModel: 'x/tiny', subjectEffort: 'off' });
    const pinned = stub({ title: '' });
    await writeSubject(pinned.deps, 'b', 'pull the Q3 numbers');
    expect(pinned.complete.mock.calls[0][1]).toMatchObject({ model: 'x/tiny', effort: 'off' });
  });

  it('at `inbox` it stores the subject but leaves the thread’s name alone', async () => {
    await updateChatsSettings({ subjects: 'inbox' });
    const s = stub({ title: 'pull the Q3 numbers' });
    expect(await writeSubject(s.deps, 'a', 'pull the Q3 numbers')).toBe('Quarterly revenue breakdown');
    expect(s.rename).not.toHaveBeenCalled();
    // The whole point of the mode: the two names deliberately differ.
    expect(s.state.title).toBe('pull the Q3 numbers');
    expect((await getSubjects()).a).toBe('Quarterly revenue breakdown');
  });

  it('at `off` it never calls the model', async () => {
    await updateChatsSettings({ subjects: 'off' });
    const s = stub({ title: 'pull the Q3 numbers' });
    expect(await writeSubject(s.deps, 'a', 'pull the Q3 numbers')).toBeNull();
    expect(s.complete).not.toHaveBeenCalled();
    expect((await getSubjects()).a).toBeUndefined();
  });

  it('leaves a thread the user has renamed alone, without spending a model call', async () => {
    const s = stub({ title: 'Numbers for the board' });
    expect(await writeSubject(s.deps, 'a', 'pull the Q3 numbers')).toBeNull();
    expect(s.complete).not.toHaveBeenCalled();
    expect(s.rename).not.toHaveBeenCalled();
  });

  it('treats an empty name and pi’s "New chat" as ours to replace', async () => {
    for (const title of ['', 'New chat']) {
      const s = stub({ title });
      expect(await writeSubject(s.deps, 'a', 'pull the Q3 numbers')).toBe('Quarterly revenue breakdown');
      expect(s.rename).toHaveBeenCalled();
    }
  });

  it('does not rename when the user renames the thread while the model is thinking', async () => {
    const s = stub({ title: 'pull the Q3 numbers' });
    // The completion is where the window is: rename mid-flight, as a user would.
    s.complete.mockImplementation(async () => {
      s.state.title = 'Numbers for the board';
      return 'Quarterly revenue breakdown';
    });
    const subject = await writeSubject(s.deps, 'a', 'pull the Q3 numbers');
    // The subject is still worth keeping — it just doesn't get to win the name.
    expect(subject).toBe('Quarterly revenue breakdown');
    expect(s.rename).not.toHaveBeenCalled();
    expect((await getSubjects()).a).toBe('Quarterly revenue breakdown');
  });

  it('force runs whatever the mode is, and may replace a name the user typed', async () => {
    await updateChatsSettings({ subjects: 'off' });
    const s = stub({ title: 'Numbers for the board' });
    expect(await writeSubject(s.deps, 'a', 'pull the Q3 numbers', { force: true })).toBe(
      'Quarterly revenue breakdown'
    );
    // `off` still means "don't rename" — force overrides the initiative, not the mode.
    expect(s.rename).not.toHaveBeenCalled();

    await updateChatsSettings({ subjects: 'everywhere' });
    const s2 = stub({ title: 'Numbers for the board' });
    await writeSubject(s2.deps, 'a', 'pull the Q3 numbers', { force: true });
    expect(s2.rename).toHaveBeenCalledWith('a', 'Quarterly revenue breakdown');
  });

  it('writes nothing when the model answers with nothing usable', async () => {
    const s = stub({ reply: '   ', title: '' });
    expect(await writeSubject(s.deps, 'a', 'pull the Q3 numbers')).toBeNull();
    expect(s.rename).not.toHaveBeenCalled();
    expect((await getSubjects()).a).toBeUndefined();
  });

  it('swallows a failing model rather than breaking the turn it rode in on', async () => {
    const s = stub({ title: '' });
    s.complete.mockRejectedValue(new Error('the worker is wedged'));
    await expect(writeSubject(s.deps, 'a', 'pull the Q3 numbers')).resolves.toBeNull();
  });

  it('skips a thread whose first message is empty', async () => {
    const s = stub({ title: '' });
    expect(await writeSubject(s.deps, 'a', '   ')).toBeNull();
    expect(s.complete).not.toHaveBeenCalled();
  });
});

describe('the subject store', () => {
  it('round-trips, and an empty subject clears the entry', async () => {
    await setSubject('a', '  Quarterly revenue  ');
    expect((await getSubjects()).a).toBe('Quarterly revenue');
    await setSubject('a', '');
    expect((await getSubjects()).a).toBeUndefined();
  });

  it('is dropped when the chat is deleted', async () => {
    await setSubject('a', 'Quarterly revenue');
    await setSubject('b', 'CI flake');
    await removeChat('a');
    const subjects = await getSubjects();
    expect(subjects.a).toBeUndefined();
    expect(subjects.b).toBe('CI flake');
  });
});
