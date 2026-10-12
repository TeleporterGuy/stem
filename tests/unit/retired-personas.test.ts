// Upgrading to 0.6.0 removes an untouched Orchestrator; what pointed at it
// (scheduled tasks, mail conversations) moves to Normal. Real files at the
// unit-test STEM_STATE_DIR paths.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mailStorePath, personasStorePath, tasksStorePath } from '../../src/server/workspace/paths';
import { listPersonas } from '../../src/server/workspace/personas';
import { repointRetiredPersonas } from '../../src/server/startup/retired-personas';

const ORCHESTRATOR_SEED =
  "You are Orchestrator. Split large tasks into independent pieces and delegate each piece to an agent: spawn_agent with an existing persona as its role, a short name, and the piece as its brief (blind true for a reviewer that must judge without knowing who wrote the work). Start all the pieces in the same turn: their replies come back to you together as one mail, which is when you combine the results. Report one assembled answer to whoever gave you the task. When a task cannot be split, do the work directly and say so.";

const paths = [personasStorePath(), tasksStorePath(), mailStorePath()];
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), 'utf8');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

function v5Personas(orchestratorPrompt: string) {
  return {
    version: 5,
    personas: [
      { id: 'normal', name: 'Normal', prompt: 'x' },
      { id: 'orchestrator', name: 'Orchestrator', prompt: orchestratorPrompt }
    ]
  };
}

const task = (id: string, personaId: string) => ({
  id,
  threadId: `thread-${id}`,
  title: id,
  prompt: 'p',
  schedule: { kind: 'cron', expr: '0 8 * * *' },
  runsAs: { kind: 'persona', personaId },
  enabled: true,
  createdAt: 1
});

const conversation = (id: string, participants: string[]) => ({
  id,
  subject: 's',
  participants,
  sessions: Object.fromEntries(participants.map((p) => [p, `t-${p}`])),
  sendCounts: { orchestrator: 2 },
  status: 'idle',
  exchangeCount: 0,
  updatedAt: 1,
  createdAt: 1
});

beforeEach(() => {
  for (const path of paths) {
    mkdirSync(dirname(path), { recursive: true });
    rmSync(path, { force: true });
  }
});
afterEach(() => {
  for (const path of paths) rmSync(path, { force: true });
});

describe('repointRetiredPersonas', () => {
  it('moves tasks and conversations from an untouched Orchestrator to Normal', async () => {
    write(personasStorePath(), v5Personas(ORCHESTRATOR_SEED));
    write(tasksStorePath(), { version: 2, tasks: [task('a', 'orchestrator'), task('b', 'secretary')] });
    write(mailStorePath(), {
      version: 1,
      conversations: [
        conversation('c1', ['orchestrator', 'critic']),
        conversation('c2', ['normal', 'orchestrator']),
        conversation('c3', ['secretary'])
      ],
      items: []
    });

    expect(await repointRetiredPersonas()).toEqual({ tasks: 1, conversations: 2 });
    expect((await listPersonas()).some((p) => p.id === 'orchestrator')).toBe(false);

    const tasks = read(tasksStorePath()).tasks;
    expect(tasks.map((t: { runsAs: { personaId: string } }) => t.runsAs.personaId)).toEqual(['normal', 'secretary']);

    const [c1, c2, c3] = read(mailStorePath()).conversations;
    expect(c1.participants).toEqual(['normal', 'critic']); // the driver seat stays first
    expect(c1.sessions).toEqual({ critic: 't-critic' });
    expect(c1.sendCounts).toEqual({});
    expect(c2.participants).toEqual(['normal']);
    expect(c2.sessions).toEqual({ normal: 't-normal' });
    expect(c3.participants).toEqual(['secretary']);
  });

  it('leaves an edited Orchestrator and everything pointing at it alone', async () => {
    write(personasStorePath(), v5Personas('my own orchestrator'));
    write(tasksStorePath(), { version: 2, tasks: [task('a', 'orchestrator')] });
    write(mailStorePath(), { version: 1, conversations: [conversation('c1', ['orchestrator'])], items: [] });

    expect(await repointRetiredPersonas()).toEqual({ tasks: 0, conversations: 0 });
    expect(read(tasksStorePath()).tasks[0].runsAs.personaId).toBe('orchestrator');
    expect(read(mailStorePath()).conversations[0].participants).toEqual(['orchestrator']);
  });

  it('leaves a version-1 task store for the scheduler to migrate first', async () => {
    write(personasStorePath(), v5Personas(ORCHESTRATOR_SEED));
    write(tasksStorePath(), { version: 1, tasks: [task('a', 'orchestrator')] });

    expect((await repointRetiredPersonas()).tasks).toBe(0);
    expect(read(tasksStorePath()).version).toBe(1);
  });
});
