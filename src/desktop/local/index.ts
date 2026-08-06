import { dialog, shell, type BrowserWindow } from 'electron';
import { handleLocal } from '../ipc-bridge';
import { ensureFilesRoot } from '../../server/files/store';
import { imagePreviewDataUrl } from '../../server/pi/attachments';
import { connectedFolderPath } from '../../server/workspace/connected-folders';
import { workspaceRoot } from '../../server/workspace/paths';

// Handlers that act on THIS machine — a native picker, a file manager, a local
// image read — and so can never be answered by a server that might be somewhere
// else. They were `dialog`/`shell` calls sitting among the server's handlers in
// ipc/workspace.ts and files/store.ts; the split is what separated them.
//
// Two of them reveal a path the SERVER knows: cfolders:reveal and
// cfolders:revealWorkspace. The shape that survives the move is "ask the server
// where, open it here" — today a direct call, an RPC once there is a transport.
// That it is meaningless when the server is on another machine is a known gap
// (Phase 2), not an accident of this refactor.

export interface LocalIpcDeps {
  /** Picker parent. Null only if the main window was closed mid-flight. */
  mainWindow(): BrowserWindow | null;
}

export function registerLocalIpc(deps: LocalIpcDeps): void {
  handleLocal('dialog:openFiles', () =>
    dialog
      .showOpenDialog(deps.mainWindow()!, { properties: ['openFile', 'multiSelections'] })
      .then((r) => (r.canceled ? [] : r.filePaths))
  );
  handleLocal('dialog:openDirectory', () =>
    dialog
      .showOpenDialog(deps.mainWindow()!, { properties: ['openDirectory', 'multiSelections'] })
      .then((r) => (r.canceled ? [] : r.filePaths))
  );

  /** Open the Files folder in Finder/Explorer. */
  handleLocal('files:reveal', async () => {
    await shell.openPath(await ensureFilesRoot());
  });
  // Read-only, and reached only from the `att.path` branch of
  // renderer/attachments.ts — i.e. for an image the user picked or dropped, which
  // by construction is on the client's own disk.
  handleLocal('files:preview', (_e, path: string) => imagePreviewDataUrl(path));

  handleLocal('cfolders:reveal', async (_e, id: string) => {
    const path = await connectedFolderPath(id);
    if (path) await shell.openPath(path);
  });
  handleLocal('cfolders:revealWorkspace', () => shell.openPath(workspaceRoot()));
}
