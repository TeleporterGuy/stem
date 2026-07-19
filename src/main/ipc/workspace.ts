import { dialog, shell } from 'electron';
import { handleIpc } from './guard';
import type { IpcDeps } from './deps';
import { listSkills, setSkillEnabled } from '../workspace/skills';
import { addFiles, listFiles, removeFile, revealFiles } from '../files/store';
import {
  addConnectedFolders,
  connectedFolderPath,
  listConnectedFolders,
  removeConnectedFolder,
  updateConnectedFolder
} from '../workspace/connected-folders';
import { workspaceRoot } from '../workspace/paths';
import { readSettings } from '../workspace/settings';
import { imagePreviewDataUrl } from '../pi/attachments';
import { curateSkills } from '../skills/curate';
import { drainSkillDistill } from '../skills/distill';
import type { LlmClient } from '../recall/llm';
import type { ConnectedFolderPatch, ScheduledTask, TaskSchedulePatch } from '../../shared/types';

/** Skills, the Files place, connected folders, file dialogs, and scheduled tasks. */
export function registerWorkspaceIpc(deps: IpcDeps): void {
  handleIpc('skills:list', () => listSkills());
  handleIpc('skills:setEnabled', (_e, slug: string, enabled: boolean) => setSkillEnabled(slug, enabled));
  handleIpc('skills:curate', async () => {
    // Same hidden one-shot seam the curator uses; `force` bypasses the size floor
    // so a manual "Tidy up" always runs. Reload so pi rescans the updated skills.
    const llm: LlmClient = {
      complete: async (prompt) => deps.runtime().complete(prompt, { model: (await readSettings()).skills.model })
    };
    await curateSkills(llm, { force: true });
    await deps.runtime().requestSkillReload();
    return listSkills();
  });
  handleIpc('skills:distillNow', async () => {
    // Manual "collect now": drain the whole message backlog through the skill
    // distiller (force bypasses the min-batch gate), then reload so any new
    // skill activates immediately.
    const llm: LlmClient = {
      complete: async (prompt) => deps.runtime().complete(prompt, { model: (await readSettings()).skills.model })
    };
    const written = await drainSkillDistill(llm);
    if (written > 0) await deps.runtime().requestSkillReload();
    return listSkills();
  });

  handleIpc('files:list', () => listFiles());
  handleIpc('files:add', (_e, paths: string[], subdir?: string) => addFiles(paths, subdir));
  handleIpc('files:remove', (_e, rel: string) => removeFile(rel));
  handleIpc('files:reveal', () => revealFiles());
  handleIpc('files:preview', (_e, path: string) => imagePreviewDataUrl(path));

  // ---- connected folders (external folders the assistant reads in place) ----
  // Distinct `cfolders:*` namespace — `folders:*` is the chat-folder tree.
  handleIpc('cfolders:list', () => listConnectedFolders());
  handleIpc('cfolders:add', (_e, paths: string[]) => addConnectedFolders(paths));
  handleIpc('cfolders:update', (_e, id: string, patch: ConnectedFolderPatch) =>
    updateConnectedFolder(id, patch)
  );
  handleIpc('cfolders:remove', (_e, id: string) => removeConnectedFolder(id));
  handleIpc('cfolders:reveal', async (_e, id: string) => {
    const path = await connectedFolderPath(id);
    if (path) await shell.openPath(path);
  });
  handleIpc('cfolders:revealWorkspace', () => shell.openPath(workspaceRoot()));

  // Scheduled tasks. Mutations return the fresh list (like the cfolders handlers).
  handleIpc('tasks:list', (): ScheduledTask[] => deps.scheduler()?.snapshot() ?? []);
  handleIpc('tasks:setEnabled', (_e, id: string, enabled: boolean) => {
    const scheduler = deps.scheduler();
    return scheduler ? scheduler.setEnabled(id, enabled) : [];
  });
  handleIpc('tasks:runNow', (_e, id: string) => deps.scheduler()?.runNow(id) ?? []);
  handleIpc('tasks:delete', (_e, id: string) => {
    const scheduler = deps.scheduler();
    return scheduler ? scheduler.remove(id) : [];
  });
  handleIpc('tasks:updateSchedule', (_e, id: string, patch: TaskSchedulePatch) => {
    const scheduler = deps.scheduler();
    return scheduler ? scheduler.updateSchedule(id, patch.schedule) : [];
  });

  handleIpc('dialog:openFiles', () =>
    dialog
      .showOpenDialog(deps.mainWindow()!, { properties: ['openFile', 'multiSelections'] })
      .then((r) => (r.canceled ? [] : r.filePaths))
  );
  handleIpc('dialog:openDirectory', () =>
    dialog
      .showOpenDialog(deps.mainWindow()!, { properties: ['openDirectory', 'multiSelections'] })
      .then((r) => (r.canceled ? [] : r.filePaths))
  );
}
