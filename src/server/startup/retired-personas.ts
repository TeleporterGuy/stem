import { listPersonas, RETIRED_PERSONA_SUCCESSORS } from '../workspace/personas';
import { readTasksStore, updateTasks } from '../workspace/tasks';
import { repointParticipants } from '../workspace/mail';
import type { ScheduledTask } from '../../shared/types';

/**
 * A retired built-in (Orchestrator, 0.6.0) is removed from the registry on
 * upgrade, but scheduled tasks and mail conversations still name it: a task
 * would quietly fall back to the app default and a mail to it would fail with
 * "no longer exists". Point both at its successor instead. Runs on every start
 * and is a no-op once nothing names the retired id; an edited row the user
 * kept (same id, still in the registry) is left alone, and so is everything
 * pointing at it.
 *
 * Must run before the scheduler loads its tasks: it holds the list in memory
 * and writes it back whole.
 */
export async function repointRetiredPersonas(): Promise<{ tasks: number; conversations: number }> {
  const ids = new Set((await listPersonas()).map((p) => p.id));
  const successors = new Map(
    Object.entries(RETIRED_PERSONA_SUCCESSORS).filter(([from, to]) => !ids.has(from) && ids.has(to))
  );
  if (!successors.size) return { tasks: 0, conversations: 0 };
  // Read first so a start with nothing to move writes nothing. A version-1
  // store is left for the scheduler's own one-time rewrite, which a write here
  // would skip by stamping the current version; the next start moves it.
  const store = await readTasksStore();
  const named = (task: ScheduledTask) => task.runsAs.kind === 'persona' && successors.has(task.runsAs.personaId);
  const tasks = store.legacy || !store.tasks.some(named) ? 0 : await updateTasks((list) => {
    let n = 0;
    for (const task of list) {
      const to = task.runsAs.kind === 'persona' ? successors.get(task.runsAs.personaId) : undefined;
      if (!to) continue;
      task.runsAs = { kind: 'persona', personaId: to };
      n++;
    }
    return { tasks: list, result: n };
  });
  const conversations = await repointParticipants(successors);
  return { tasks, conversations };
}
