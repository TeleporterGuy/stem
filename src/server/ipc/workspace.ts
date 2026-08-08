import { registerServer } from './guard';
import type { IpcDeps } from './deps';
import { listSkills, setSkillEnabled } from '../workspace/skills';
import { addFiles, createSubdir, listFiles, removeFile, removeSubdir } from '../files/store';
import {
  addConnectedFolders,
  listConnectedFolders,
  removeConnectedFolder,
  updateConnectedFolder
} from '../workspace/connected-folders';
import { getFolderIndexStatuses, seedFolderLearnMarks, syncFolderIndexes } from '../folder-index';
import { recallStore } from '../recall/store';
import { backgroundRunOf, updateSkillsSettings } from '../workspace/settings';
import { resetSkills, skillsResetStatus } from '../skills/reset';
import { learnFromLastTurn } from '../startup/skills';
import { curateSkills } from '../skills/curate';
import type { LlmClient } from '../recall/llm';
import type { ApprovalId } from '../backend/types';
import type { ConnectedFolderPatch, ScheduledTask, SkillsMode, TaskSchedulePatch } from '../../shared/types';

/**
 * Skills, the Files place, connected folders, scheduled tasks, and the phone
 * bridge's settings pair. The native pickers and the reveal-in-file-manager
 * handlers that used to sit here act on the client's own machine and moved to
 * src/desktop/local.
 */
export function registerWorkspaceIpc(deps: IpcDeps): void {
  registerServer('skills:list', () => listSkills());
  registerServer('skills:setEnabled', async (_e, slug: string, enabled: boolean) => {
    const skills = await setSkillEnabled(slug, enabled);
    // Toggling rewrites the ignore file, which only takes effect on a rescan —
    // without this the switch stayed cosmetic until the next backend restart.
    await deps.runtime().requestSkillReload();
    return skills;
  });
  registerServer(
    'skills:resolveApproval',
    (_e, id: ApprovalId, accept: boolean, skill?: { name: string; description: string; body: string }) => {
      // The write itself happens inside the held manage_skill call (SkillBridge),
      // not here — that keeps one code path for validation and one for the reload,
      // and lets the tool tell the model exactly what happened.
      deps.runtime().resolveSkillApproval(id, accept, skill);
    }
  );
  registerServer('skills:learn', (_e, threadId: string, focus?: string) => learnFromLastTurn(threadId, focus));
  registerServer('skills:resetStatus', () => skillsResetStatus());
  registerServer('skills:reset', async (_e, exportFirst: boolean, mode: SkillsMode) => {
    const result = resetSkills({ export: exportFirst });
    // The dialog is also where the user picks how automatic skills should be, so
    // the answer lands with the migration rather than needing a second trip to
    // Settings that most people would never make.
    await updateSkillsSettings({ mode });
    await deps.runtime().requestSkillReload();
    return result;
  });
  registerServer('skills:curate', async () => {
    // Same hidden one-shot seam the curator uses; `force` bypasses the size floor
    // so a manual "Tidy up" always runs. Reload so pi rescans the updated skills.
    const llm: LlmClient = {
      complete: async (prompt) =>
        deps.runtime().complete(prompt, await backgroundRunOf((s) => s.skills.model))
    };
    await curateSkills(llm, { force: true });
    await deps.runtime().requestSkillReload();
    return listSkills();
  });
  // There is no `skills:distillNow` any more. Its "Collect now" swept the chat
  // backlog for skills, but the recall DB holds no tool calls to sweep; skills
  // are now written at the end of the turn that earned them (skills/settle.ts).

  registerServer('files:list', () => listFiles());
  registerServer('files:add', (_e, paths: string[], subdir?: string) => addFiles(paths, subdir));
  registerServer('files:remove', (_e, rel: string) => removeFile(rel));
  registerServer('files:mkdir', (_e, name: string) => createSubdir(name));
  registerServer('files:rmdir', (_e, name: string) => removeSubdir(name));

  // ---- connected folders (external folders the assistant reads in place) ----
  // Distinct `cfolders:*` namespace — `folders:*` is the chat-folder tree.
  registerServer('cfolders:list', () => listConnectedFolders());
  registerServer('cfolders:add', (_e, paths: string[]) => addConnectedFolders(paths));
  registerServer('cfolders:update', async (_e, id: string, patch: ConnectedFolderPatch) => {
    const folders = await updateConnectedFolder(id, patch);
    // Index toggled: reconcile now (off → the DB file is deleted) and, when
    // turned on, kick a scan so the index fills without waiting for the timer.
    if (typeof patch.index === 'boolean') {
      void syncFolderIndexes();
      if (patch.index) deps.scheduleFolderIndexScan(500);
    }
    // Learn-mode transitions seed the per-doc marks: 'new' stamps everything as
    // already learned ("start from now" — also how a running 'all' sweep is
    // cancelled); 'all' stamps nothing, leaving the backlog pending. Then kick
    // the drain so learning starts without waiting for the next scan cycle.
    if (typeof patch.learnMode === 'string') {
      if (patch.learnMode === 'new') await seedFolderLearnMarks(id);
      if (patch.learnMode === 'new' || patch.learnMode === 'all') deps.scheduleFolderLearn(1_000);
    }
    return folders;
  });
  registerServer('cfolders:remove', async (_e, id: string) => {
    const folders = await removeConnectedFolder(id);
    void syncFolderIndexes(); // Drops the disconnected folder's index DB.
    return folders;
  });
  // The disconnect flow's "also forget the facts learned from this folder"
  // choice. Separate from cfolders:remove so keeping the facts stays the
  // default; pinned facts always survive (enforced in the store).
  registerServer('cfolders:forgetFacts', (_e, id: string) => recallStore.forgetFactsBySource(`folder:${id}`));
  registerServer('cfolders:indexStatus', () => getFolderIndexStatuses());

  // Scheduled tasks. Mutations return the fresh list (like the cfolders handlers).
  registerServer('tasks:list', (): ScheduledTask[] => deps.scheduler()?.snapshot() ?? []);
  // What a scheduled run of this thread would execute on (Tasks tab "runs on" chip).
  registerServer('tasks:threadSettings', (_e, threadId: string) => deps.runtime().threadTurnSettings(threadId));
  registerServer('tasks:setEnabled', (_e, id: string, enabled: boolean) => {
    const scheduler = deps.scheduler();
    return scheduler ? scheduler.setEnabled(id, enabled) : [];
  });
  registerServer('tasks:runNow', (_e, id: string) => deps.scheduler()?.runNow(id) ?? []);
  registerServer('tasks:delete', (_e, id: string) => {
    const scheduler = deps.scheduler();
    return scheduler ? scheduler.remove(id) : [];
  });
  registerServer('tasks:updateSchedule', (_e, id: string, patch: TaskSchedulePatch) => {
    const scheduler = deps.scheduler();
    return scheduler ? scheduler.updateSchedule(id, patch.schedule) : [];
  });


}
