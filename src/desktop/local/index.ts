import { dialog, shell, type BrowserWindow } from 'electron';
import { handleLocal } from '../ipc-bridge';
import { ensureFilesRoot } from '../../server/files/store';
import { imagePreviewDataUrl } from '../../server/pi/attachments';
import { connectedFolderPath } from '../../server/workspace/connected-folders';
import { workspaceRoot } from '../../server/workspace/paths';
import { readClientIdentity } from '../client-store';
import type { ClientInfo } from '../../shared/types';

// Handlers that act on THIS machine — a native picker, a file manager, a local
// image read — and so can never be answered by a server that might be somewhere
// else. They were `dialog`/`shell` calls sitting among the server's handlers in
// ipc/workspace.ts and files/store.ts; the split is what separated them.
//
// Two of them reveal a path the SERVER knows: cfolders:reveal and
// cfolders:revealWorkspace. They resolve it by calling into the server's path
// helpers directly rather than over the transport, because the answer is only
// ever useful when both halves share a filesystem — which is exactly the case
// where the direct call is correct. That the whole handler is meaningless when
// the server is on another machine is a known gap (Phase 2), not an accident of
// this refactor; an RPC here would move the gap, not close it.

export interface LocalIpcDeps {
  /** Picker parent. Null only if the main window was closed mid-flight. */
  mainWindow(): BrowserWindow | null;
  /** Where this client is connected, and whether it started that server itself. */
  connection(): { serverUrl: string; remote: boolean };
}

export function registerLocalIpc(deps: LocalIpcDeps): void {
  // Who this client is. Deliberately answered here and not by the server: the
  // server has no notion of "the device asking" (dispatchLocal carries no caller
  // — see ipc/guard.ts), and every fact here is about this machine anyway. It is
  // what lets Settings → Devices point at your own row instead of offering to
  // revoke the credential you are holding.
  handleLocal('client:info', async (): Promise<ClientInfo> => {
    const identity = await readClientIdentity();
    return { deviceId: identity?.deviceId ?? null, ...deps.connection() };
  });

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
