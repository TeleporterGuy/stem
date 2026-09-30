// Model-written mail subjects (server/mail/subject.ts). The made-up-subject
// detection is pure; the live trigger and the one-time sweep run against the
// REAL mail and settings stores (throwaway paths from tests/setup-unit.ts)
// with only the model stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MailItem } from '../../src/shared/types';
import { NO_SUBJECT } from '../../src/shared/mail-subject';
import {
  isMadeUpMailSubject,
  mailOpeningExcerpt,
  nameAfterFirstReply,
  nameMailConversation,
  PASS_CAP,
  runMailSubjectPass
} from '../../src/server/mail/subject';
import {
  appendMailItem,
  createConversation,
  mailSubjectPassDone,
  readMail,
  setConversationSubject
} from '../../src/server/workspace/mail';
import { updateChatsSettings } from '../../src/server/workspace/settings';
import { mailStorePath, settingsStorePath } from '../../src/server/workspace/paths';

const mailPath = mailStorePath();
const settingsPath = settingsStorePath();

beforeEach(() => {
  mkdirSync(dirname(mailPath), { recursive: true });
  rmSync(mailPath, { force: true });
  rmSync(settingsPath, { force: true });
});
afterEach(() => {
  rmSync(mailPath, { force: true });
  rmSync(settingsPath, { force: true });
});

const PROMPT = 'Prosím pozri si to čo písal na slacku na cf_developers Šimon a zhrň mi to do troch bodov';

function stub(reply = 'Slack cf_developers súhrn') {
  const complete = vi.fn(
    async (_prompt: string, _opts: { model?: string | null; effort?: string | null; timeoutMs?: number }) => reply
  );
  return { complete, deps: { complete } };
}

let clock = 1_000_000;
/** A composed conversation (subject as the user typed it, '' = none) and, optionally, its first reply. */
async function conversation(opts: { subject?: string; body?: string; reply?: boolean; taskId?: string } = {}) {
  const body = opts.body ?? PROMPT;
  const c = await createConversation(opts.subject ?? '', ['normal'], body);
  await appendMailItem({ conversationId: c.id, from: 'user', to: ['normal'], body, at: (clock += 10) });
  let reply: MailItem | undefined;
  if (opts.reply !== false) {
    const result = await appendMailItem({
      conversationId: c.id,
      from: 'normal',
      to: ['user'],
      body: 'Šimon navrhuje presunúť deploy na štvrtok.',
      at: (clock += 10),
      ...(opts.taskId ? { taskId: opts.taskId } : {})
    });
    reply = result.items.at(-1);
  }
  return { id: c.id, reply };
}

async function subjectOf(id: string): Promise<string | undefined> {
  return (await readMail()).conversations.find((c) => c.id === id)?.subject;
}

const item = (over: Partial<MailItem>): MailItem => ({
  id: Math.random().toString(36),
  conversationId: 'c',
  from: 'user',
  to: ['normal'],
  body: '',
  at: 0,
  ...over
});

describe('isMadeUpMailSubject', () => {
  it('recognises the derived first line, the shrug and a blank as ours', () => {
    const mails = [item({ body: PROMPT })];
    expect(isMadeUpMailSubject('Prosím pozri si to čo písal na slacku na cf_developers Šimo…', mails)).toBe(true);
    expect(isMadeUpMailSubject(NO_SUBJECT, mails)).toBe(true);
    expect(isMadeUpMailSubject('  ', mails)).toBe(true);
  });

  it('treats anything else as the user’s — a typed subject, a forward', () => {
    const mails = [item({ body: PROMPT })];
    expect(isMadeUpMailSubject('Slack recap', mails)).toBe(false);
    expect(isMadeUpMailSubject('Fwd: Deploy plan', mails)).toBe(false);
  });

  it('derives from the first user mail that says anything, skipping an attachments-only opener', () => {
    const mails = [item({ body: '', attachments: [{ kind: 'image', name: 'a.png' }] }), item({ body: 'second one' })];
    expect(isMadeUpMailSubject('second one', mails)).toBe(true);
    // Persona text never counts as the derivation source.
    expect(isMadeUpMailSubject('persona text', [item({ from: 'normal', to: ['user'], body: 'persona text' })])).toBe(false);
  });

  it('shows the model the opening exchange only', () => {
    const excerpt = mailOpeningExcerpt([
      item({ body: 'first ask', at: 1 }),
      item({ from: 'normal', to: ['user'], body: 'first answer', at: 2 }),
      item({ body: 'follow-up', at: 3 })
    ]);
    expect(excerpt).toBe('User: first ask\nAssistant: first answer');
  });
});

describe('nameAfterFirstReply', () => {
  it('replaces the derived subject once the first reply lands', async () => {
    const s = stub();
    const { id, reply } = await conversation();
    expect(await subjectOf(id)).toMatch(/…$/);
    expect(await nameAfterFirstReply(s.deps, reply!)).toBe('Slack cf_developers súhrn');
    expect(await subjectOf(id)).toBe('Slack cf_developers súhrn');
    expect(s.complete.mock.calls[0][0]).toContain(PROMPT);
    expect(s.complete.mock.calls[0][1].timeoutMs).toBeGreaterThan(0);
  });

  it('never touches a subject the user typed', async () => {
    const s = stub();
    const { id, reply } = await conversation({ subject: 'Slack recap' });
    expect(await nameAfterFirstReply(s.deps, reply!)).toBeNull();
    expect(s.complete).not.toHaveBeenCalled();
    expect(await subjectOf(id)).toBe('Slack recap');
  });

  it('leaves scheduled-task conversations alone', async () => {
    const s = stub();
    const { reply } = await conversation({ taskId: 't1' });
    expect(await nameAfterFirstReply(s.deps, reply!)).toBeNull();
    expect(s.complete).not.toHaveBeenCalled();
  });

  it('fires on the first reply only — a later one never retries', async () => {
    const s = stub('');
    const { id } = await conversation();
    const second = (
      await appendMailItem({ conversationId: id, from: 'normal', to: ['user'], body: 'more', at: (clock += 10) })
    ).items.at(-1)!;
    expect(await nameAfterFirstReply(s.deps, second)).toBeNull();
    expect(s.complete).not.toHaveBeenCalled();
  });

  it('does nothing with subjects off', async () => {
    await updateChatsSettings({ subjects: 'off' });
    const s = stub();
    const { reply } = await conversation();
    expect(await nameAfterFirstReply(s.deps, reply!)).toBeNull();
    expect(s.complete).not.toHaveBeenCalled();
  });

  it('keeps the old subject when the model answers nothing usable or throws', async () => {
    const { id } = await conversation();
    const before = await subjectOf(id);
    expect(await nameMailConversation(stub('').deps, id)).toBeNull();
    const failing = { complete: vi.fn(async () => { throw new Error('model down'); }) };
    expect(await nameMailConversation(failing, id)).toBeNull();
    expect(await subjectOf(id)).toBe(before);
  });

  it('yields to a subject changed while the model was writing', async () => {
    const { id } = await conversation();
    const slow = {
      complete: vi.fn(async () => {
        await setConversationSubject(id, 'Renamed meanwhile');
        return 'Model subject';
      })
    };
    expect(await nameMailConversation(slow, id)).toBeNull();
    expect(await subjectOf(id)).toBe('Renamed meanwhile');
  });
});

describe('runMailSubjectPass', () => {
  it('names the newest eligible conversations up to the cap, then marks itself done', async () => {
    const ids: string[] = [];
    for (let i = 0; i < PASS_CAP + 2; i += 1) ids.push((await conversation({ body: `task number ${i}` })).id);
    const typed = await conversation({ subject: 'Mine' });
    const unanswered = await conversation({ reply: false });
    let n = 0;
    const s = { complete: vi.fn(async () => `Subject ${++n}`) };

    expect(await runMailSubjectPass(s)).toBe(PASS_CAP);
    expect(s.complete).toHaveBeenCalledTimes(PASS_CAP);
    // Newest first: the two oldest are the ones left over the cap.
    expect(await subjectOf(ids[0])).toBe('task number 0');
    expect(await subjectOf(ids[1])).toBe('task number 1');
    expect(await subjectOf(ids[PASS_CAP + 1])).toBe('Subject 1');
    expect(await subjectOf(typed.id)).toBe('Mine');
    expect(await subjectOf(unanswered.id)).toBe(PROMPT.slice(0, 59).trimEnd() + '…');

    expect(await mailSubjectPassDone()).toBe(true);
    expect(typeof JSON.parse(readFileSync(mailPath, 'utf8')).subjectPassAt).toBe('number');
    // The flag survives an unrelated write and stops any rerun.
    await appendMailItem({ conversationId: typed.id, from: 'user', to: ['normal'], body: 'hi' });
    expect(await runMailSubjectPass(s)).toBe(0);
    expect(s.complete).toHaveBeenCalledTimes(PASS_CAP);
  });

  it('with subjects off, marks itself done without naming anything', async () => {
    await updateChatsSettings({ subjects: 'off' });
    const { id } = await conversation();
    const s = stub();
    expect(await runMailSubjectPass(s.deps)).toBe(0);
    expect(s.complete).not.toHaveBeenCalled();
    expect(await mailSubjectPassDone()).toBe(true);
    expect(await subjectOf(id)).toMatch(/…$/);
  });

  it('a failed call leaves that conversation as it was and moves on', async () => {
    const a = await conversation({ body: 'first thing to do' });
    const b = await conversation({ body: 'second thing to do' });
    const s = {
      complete: vi
        .fn<(prompt: string) => Promise<string>>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce('Written subject')
    };
    expect(await runMailSubjectPass(s)).toBe(1);
    // b is newer, so it was asked first and failed.
    expect(await subjectOf(b.id)).toBe('second thing to do');
    expect(await subjectOf(a.id)).toBe('Written subject');
  });
});
