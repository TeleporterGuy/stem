import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatBackend } from '../../src/server/backend/types';
import type { HarnessActivity } from '../../src/server/harness/activities';
import type { HistoricalWorkRun } from '../../src/server/mail/work-history';
import type { MailConversation, MailItem, MailWorkGroup, ScheduledTask } from '../../src/shared/types';
import { readHarnessActivities } from '../../src/server/harness/activities';
import { readRecordedWork } from '../../src/server/mail/work';
import { getMailWork } from '../../src/server/mail/work-query';
import { readMail } from '../../src/server/workspace/mail';
import { readTasks } from '../../src/server/workspace/tasks';

vi.mock('../../src/server/workspace/mail', () => ({ readMail: vi.fn() }));
vi.mock('../../src/server/workspace/tasks', () => ({ readTasks: vi.fn() }));
vi.mock('../../src/server/mail/work', () => ({ readRecordedWork: vi.fn() }));
vi.mock('../../src/server/harness/activities', () => ({ readHarnessActivities: vi.fn() }));

const ID = 'conversation';
let conversation: MailConversation;
let items: MailItem[];
let recorded: MailWorkGroup[];
let tasks: ScheduledTask[];
let histories: Record<string, HistoricalWorkRun[]>;
let inner: HarnessActivity[];
const history = vi.fn(async (threadId: string) => histories[threadId] ?? []);
const runtime = { readWorkHistory: history } as unknown as ChatBackend;

function mail(id: string, body: string, at: number, extra: Partial<MailItem> = {}): MailItem {
  return { id, body, at, conversationId: ID, from: 'user', to: ['lead'], ...extra };
}
function run(id: string, request: string, startedAt: number, extra: Partial<HistoricalWorkRun> = {}): HistoricalWorkRun {
  return { id, turnId: id, request, startedAt, endedAt: startedAt + 10, status: 'ok', personaId: '', threadId: 'lead-thread', activities: [], ...extra };
}
function task(id: string, threadId: string): ScheduledTask {
  return { id, threadId, runsAs: { kind: 'persona', personaId: 'secretary' }, prompt: 'Check fictional news', title: 'News', enabled: true,
    createdAt: new Date(0).toISOString(), schedule: { kind: 'cron', expr: '0 8 * * *' } };
}

beforeEach(() => {
  vi.clearAllMocks();
  conversation = { id: ID, subject: 'Fictional request', participants: ['lead', 'coder'], sessions: { lead: 'lead-thread' },
    status: 'idle', exchangeCount: 0, sendCounts: {}, createdAt: 0, updatedAt: 0, userUpdatedAt: 0, userSentAt: 0 };
  items = [];
  recorded = [];
  tasks = [];
  histories = {};
  inner = [];
  vi.mocked(readMail).mockImplementation(async () => ({ version: 1, conversations: [conversation], items, inbox: { baseline: 0, entries: {} } }));
  vi.mocked(readRecordedWork).mockImplementation(async () => structuredClone(recorded));
  vi.mocked(readTasks).mockImplementation(async () => tasks);
  vi.mocked(readHarnessActivities).mockImplementation(async (filter = {}) => inner.filter((row) => !filter.threadId || row.threadId === filter.threadId));
  history.mockImplementation(async (threadId) => histories[threadId] ?? []);
});

describe('historical mail work linkage', () => {
  it('links delegation to the exact original request, while keeping a later follow-up separate', async () => {
    conversation.sessions.coder = 'coder-thread';
    items = [mail('original', 'Prepare the release', 1_000), mail('followup', 'Only upload the archive', 3_000)];
    histories['lead-thread'] = [run('lead-turn', 'Prepare the release', 1_010), run('followup-turn', 'Only upload the archive', 3_010)];
    // The assignment happens to match the later user mail; its preserved source wins.
    histories['coder-thread'] = [run('delegated-turn', 'Only upload the archive', 4_000, {
      sourceRequest: 'Prepare the release', threadId: 'coder-thread'
    })];
    const { groups } = await getMailWork(runtime, ID);
    const containing = (id: string) => groups.find((group) => group.runs.some((value) => value.id === id));
    expect(containing('lead-turn')?.sourceItemId).toBe('original');
    expect(containing('delegated-turn')?.sourceItemId).toBe('original');
    expect(containing('delegated-turn')?.runs.find((value) => value.id === 'delegated-turn')?.personaId).toBe('coder');
    expect(containing('followup-turn')?.sourceItemId).toBe('followup');
  });

  it('keeps repeated identical requests ambiguous instead of choosing the latest one', async () => {
    items = [mail('first', 'Build it', 1_000), mail('second', 'Build it', 2_000)];
    histories['lead-thread'] = [run('ambiguous-turn', 'Build it', 4_000)];
    const { groups } = await getMailWork(runtime, ID);
    const orphan = groups.find((group) => group.runs.some((value) => value.id === 'ambiguous-turn'));
    expect(orphan?.sourceItemId).toBeUndefined();
    expect(orphan?.gaps?.join(' ')).toMatch(/could not be linked/i);
    for (const id of ['first', 'second']) expect(groups.find((group) => group.sourceItemId === id)).toMatchObject({ runs: [], historical: true });
  });

  it('does not attach an earlier run to a future follow-up with the same text', async () => {
    items = [mail('original', 'Prepare the release', 1_000), mail('future', 'Upload it', 10_000)];
    histories['lead-thread'] = [run('older-turn', 'Upload it', 2_000)];
    const { groups } = await getMailWork(runtime, ID);
    expect(groups.find((group) => group.runs.some((value) => value.id === 'older-turn'))?.sourceItemId).toBeUndefined();
    expect(groups.find((group) => group.sourceItemId === 'future')?.runs).toEqual([]);
  });

  it('does not fall back to an assignment match when its original source cannot be found', async () => {
    items = [mail('followup', 'Upload it', 1_000)];
    histories['lead-thread'] = [run('delegated-turn', 'Upload it', 2_000, { sourceRequest: 'Original mail no longer exists' })];
    const { groups } = await getMailWork(runtime, ID);
    expect(groups.find((group) => group.runs.some((value) => value.id === 'delegated-turn'))?.sourceItemId).toBeUndefined();
    expect(groups.find((group) => group.sourceItemId === 'followup')?.runs).toEqual([]);
  });

  it('deduplicates a recovered session entry by the turn identity already present in recorded work', async () => {
    items = [mail('original', 'Build it', 1_000), mail('missing-source', 'Inspect the build', 2_000)];
    recorded = [{ id: 'original', conversationId: ID, sourceItemId: 'original', runs: [run('saved-row-id', 'Build it', 1_010, { turnId: 'real-turn-id' })] }];
    histories['lead-thread'] = [run('different-session-entry-id', 'Build it', 1_010, { turnId: 'real-turn-id' })];
    const { groups } = await getMailWork(runtime, ID);
    expect(history).toHaveBeenCalledWith('lead-thread');
    expect(groups.find((group) => group.sourceItemId === 'original')?.runs).toHaveLength(1);
    expect(groups.find((group) => group.sourceItemId === 'original')?.runs[0].id).toBe('saved-row-id');
  });

  it('recovers inner coding-agent work only by the outer call ID and leaves cached source history immutable', async () => {
    items = [mail('original', 'Build it', 1_000)];
    const source = run('turn', 'Build it', 1_010, { activities: [{ id: 'outer-call', kind: 'tool', label: 'coding_agent', at: 1_010, status: 'ok' }] });
    histories['lead-thread'] = [source];
    const entry: HarnessActivity = { id: 'inner-tool', threadId: 'lead-thread', runId: 'harness-run', itemId: 'outer-call', agent: 'claude',
      kind: 'tool', title: 'Build', startedAt: new Date(1_011).toISOString(), updatedAt: new Date(1_012).toISOString(), status: 'completed', input: 'npm run build', output: 'Build passed' };
    inner = [entry, { ...entry, id: 'unrelated-tool', itemId: 'different-call' }];
    const first = await getMailWork(runtime, ID);
    const second = await getMailWork(runtime, ID);
    expect(first.groups[0].runs[0].activities).toHaveLength(2);
    expect(second.groups[0].runs[0].activities).toHaveLength(2);
    expect(first.groups[0].runs[0].activities[1]).toMatchObject({ parentId: 'outer-call', input: 'npm run build', output: 'Build passed' });
    expect(source.activities).toHaveLength(1);
  });
});

describe('scheduled historical work', () => {
  // Every firing runs in a thread of its own, named on the mail it sent
  // (`runThreadId`); recovery reads that thread for that item alone.
  it('recovers each notification from the run thread its mail names, as the persona the task runs as', async () => {
    conversation.sessions = {};
    items = [mail('monday-mail', 'Monday report', 2_000, { from: 'secretary', to: ['user'], taskId: 'news', runThreadId: 'run-monday' }),
      mail('tuesday-mail', 'Tuesday report', 4_000, { from: 'secretary', to: ['user'], taskId: 'news', runThreadId: 'run-tuesday' })];
    tasks = [task('news', 'origin-chat')];
    histories['run-monday'] = [run('monday-run', 'Check news', 1_000, { notifications: ['Monday report'], threadId: 'run-monday' })];
    histories['run-tuesday'] = [run('tuesday-run', 'Check news', 3_000, { notifications: ['Tuesday report'], threadId: 'run-tuesday' })];
    histories['origin-chat'] = [run('chat-turn', 'Check news', 500, { notifications: ['Monday report'], threadId: 'origin-chat' })];
    const { groups } = await getMailWork(runtime, ID);
    expect(groups.find((group) => group.notificationItemId === 'monday-mail')?.runs[0]).toMatchObject({ id: 'monday-run', personaId: 'secretary' });
    expect(groups.find((group) => group.notificationItemId === 'tuesday-mail')?.runs[0].id).toBe('tuesday-run');
    // The chat the task was scheduled from is never read: no run happened there.
    expect(history).not.toHaveBeenCalledWith('origin-chat');
  });

  it('a notification whose task is gone still recovers from its own thread, as the plain task sender', async () => {
    conversation.sessions = {};
    items = [mail('notice', 'Report', 2_000, { from: 'task:removed', to: ['user'], taskId: 'removed', runThreadId: 'run-x' })];
    histories['run-x'] = [run('the-run', 'Check', 1_000, { notifications: ['Report'], threadId: 'run-x' })];
    const { groups } = await getMailWork(runtime, ID);
    expect(groups.find((group) => group.notificationItemId === 'notice')?.runs[0]).toMatchObject({ id: 'the-run', personaId: 'task:removed' });
  });

  it('marks mail from before runs had threads of their own explicitly unavailable without guessing a session', async () => {
    conversation.sessions = {};
    items = [mail('old-notification', 'Old report', 1_000, { from: 'secretary', to: ['user'], taskId: 'news' })];
    tasks = [task('news', 'origin-chat')];
    const { groups } = await getMailWork(runtime, ID);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ notificationItemId: 'old-notification', historical: true, runs: [] });
    expect(groups[0].gaps?.join(' ')).toMatch(/no reliably linked work records/i);
    expect(history).not.toHaveBeenCalled();
  });

  it('shows the same saved run beneath each notification it produced', async () => {
    conversation.sessions = {};
    items = [mail('first-update', 'Build complete', 2_000, { from: 'secretary', to: ['user'], taskId: 'build', runThreadId: 'run-1' }),
      mail('second-update', 'Upload complete', 3_000, { from: 'secretary', to: ['user'], taskId: 'build', runThreadId: 'run-1' })];
    tasks = [task('build', 'origin-chat')];
    histories['run-1'] = [run('scheduled-run', 'Build and upload', 1_000, { notifications: ['Build complete', 'Upload complete'] })];
    const { groups } = await getMailWork(runtime, ID);
    for (const id of ['first-update', 'second-update']) expect(groups.find((group) => group.notificationItemId === id)?.runs.map((value) => value.id)).toEqual(['scheduled-run']);
  });

  it('does not guess among runs in one thread that emitted the same notification text', async () => {
    conversation.sessions = {};
    items = [mail('notification', 'No news', 4_000, { from: 'secretary', to: ['user'], taskId: 'news', runThreadId: 'run-1' })];
    tasks = [task('news', 'origin-chat')];
    histories['run-1'] = [run('first-run', 'Check news', 1_000, { notifications: ['No news'] }),
      run('second-run', 'Check news', 3_000, { notifications: ['No news'] })];
    const { groups } = await getMailWork(runtime, ID);
    expect(groups.filter((group) => group.notificationItemId === 'notification').flatMap((group) => group.runs)).toEqual([]);
    expect(groups.find((group) => group.notificationItemId === 'notification')?.gaps?.join(' ')).toMatch(/no reliably linked work records/i);
  });

  it('marks unreadable saved sessions as unavailable while preserving the source mail', async () => {
    items = [mail('original', 'Build it', 1_000)];
    history.mockRejectedValue(new Error('Session file missing'));
    const { groups } = await getMailWork(runtime, ID);
    expect(groups.some((group) => group.gaps?.some((gap) => /saved session could not be read/i.test(gap)))).toBe(true);
    expect(groups.find((group) => group.sourceItemId === 'original')).toMatchObject({ historical: true, runs: [] });
  });
});
