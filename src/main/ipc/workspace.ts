import { dialog, shell } from 'electron';
import { handleIpc } from './guard';
import type { IpcDeps } from './deps';
import { listSkills, setSkillEnabled } from '../workspace/skills';
import { addFiles, createSubdir, listFiles, removeFile, removeSubdir, revealFiles } from '../files/store';
import {
  addConnectedFolders,
  connectedFolderPath,
  listConnectedFolders,
  removeConnectedFolder,
  updateConnectedFolder
} from '../workspace/connected-folders';
import { getFolderIndexStatuses, seedFolderLearnMarks, syncFolderIndexes } from '../folder-index';
import { recallStore } from '../recall/store';
import { workspaceRoot } from '../workspace/paths';
import { readSettings, updateMobileSettings } from '../workspace/settings';
import { imagePreviewDataUrl } from '../pi/attachments';
import { curateSkills } from '../skills/curate';
import { drainSkillDistill } from '../skills/distill';
import { mobilePairingInfo, rerollMobilePairing, syncMobileBridge } from '../startup/mobile';
import type { LlmClient } from '../recall/llm';
import type { ConnectedFolderPatch, MobileSettings, ScheduledTask, TaskSchedulePatch } from '../../shared/types';

/**
 * Skills, the Files place, connected folders, file dialogs, scheduled tasks, and
 * the phone bridge's settings pair.
 */
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
  handleIpc('files:mkdir', (_e, name: string) => createSubdir(name));
  handleIpc('files:rmdir', (_e, name: string) => removeSubdir(name));
  handleIpc('files:reveal', () => revealFiles());
  handleIpc('files:preview', (_e, path: string) => imagePreviewDataUrl(path));

  // ---- connected folders (external folders the assistant reads in place) ----
  // Distinct `cfolders:*` namespace — `folders:*` is the chat-folder tree.
  handleIpc('cfolders:list', () => listConnectedFolders());
  handleIpc('cfolders:add', (_e, paths: string[]) => addConnectedFolders(paths));
  handleIpc('cfolders:update', async (_e, id: string, patch: ConnectedFolderPatch) => {
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
  handleIpc('cfolders:remove', async (_e, id: string) => {
    const folders = await removeConnectedFolder(id);
    void syncFolderIndexes(); // Drops the disconnected folder's index DB.
    return folders;
  });
  // The disconnect flow's "also forget the facts learned from this folder"
  // choice. Separate from cfolders:remove so keeping the facts stays the
  // default; pinned facts always survive (enforced in the store).
  handleIpc('cfolders:forgetFacts', (_e, id: string) => recallStore.forgetFactsBySource(`folder:${id}`));
  handleIpc('cfolders:indexStatus', () => getFolderIndexStatuses());
  handleIpc('cfolders:reveal', async (_e, id: string) => {
    const path = await connectedFolderPath(id);
    if (path) await shell.openPath(path);
  });
  handleIpc('cfolders:revealWorkspace', () => shell.openPath(workspaceRoot()));

  // Scheduled tasks. Mutations return the fresh list (like the cfolders handlers).
  handleIpc('tasks:list', (): ScheduledTask[] => deps.scheduler()?.snapshot() ?? []);
  // What a scheduled run of this thread would execute on (Tasks tab "runs on" chip).
  handleIpc('tasks:threadSettings', (_e, threadId: string) => deps.runtime().threadTurnSettings(threadId));
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

  // ---- the phone bridge (see startup/mobile.ts) ----
  // Deliberately NOT reachable from the phone itself: settings:updateMobile is
  // absent from the mobile allowlist, so a phone can never turn the bridge off
  // (or move it) from under the user.
  handleIpc('settings:updateMobile', async (_e, patch: Partial<MobileSettings>) => {
    const next = await updateMobileSettings(patch);
    // Apply now rather than at next launch: enabling starts the loopback server,
    // disabling stops it, a port change rebinds. Never throws — a port that
    // won't bind is logged and reported as `running: false` by mobile:pairingInfo.
    await syncMobileBridge();
    return next;
  });
  // The QR's contents: the URL to open plus the bearer token. Never pushed
  // anywhere — the Settings pane pulls it when the user opens the pairing UI.
  handleIpc('mobile:pairingInfo', () => mobilePairingInfo());
  // Revocation. Also absent from the mobile allowlist: a phone must not be able
  // to lock the other phones out, or itself.
  handleIpc('mobile:rerollToken', () => rerollMobilePairing());

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
