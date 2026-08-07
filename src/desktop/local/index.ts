import { dialog, shell, type BrowserWindow } from 'electron';
import { handleLocal } from '../ipc-bridge';
import { ensureFilesRoot } from '../../server/files/store';
import { imagePreviewDataUrl } from '../../server/pi/attachments';
import { connectedFolderPath } from '../../server/workspace/connected-folders';
import { workspaceRoot } from '../../server/workspace/paths';
import { readClientIdentity, storedServerUrl } from '../client-store';
import { markReleaseNotesRead, releaseNotesSnapshot } from '../release-notes';
import { pairWithServer, useBuiltInServer } from '../server-endpoint';
import { updateClientReleaseNotes, withClientSettings } from '../settings';
import type { AppSettings, ClientInfo, ReleaseNotesSettings } from '../../shared/types';

// Handlers that act on THIS machine — a native picker, a file manager, a local
// image read — and so can never be answered by a server that might be somewhere
// else. They were `dialog`/`shell` calls sitting among the server's handlers in
// ipc/workspace.ts and files/store.ts; the split is what separated them.
//
// Phase 2 adds two more families for the same reason, neither of which touches a
// window. Which server this client talks to is not a question the server being
// replaced can be asked. And the "what's new" popup is decided entirely from the
// version installed HERE and the RELEASE_NOTES.md shipped beside it, so a server
// with two Macs on two builds has no single correct answer to give.
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
  connection(): { serverUrl: string; remote: boolean; pinnedByEnv: boolean };
  /** The settings document, for the handlers that need the server's half of it. */
  settings(): Promise<AppSettings>;
}

export function registerLocalIpc(deps: LocalIpcDeps): void {
  /** Identity + connection, re-read each time so a fresh pairing shows at once. */
  async function clientInfo(): Promise<ClientInfo> {
    const [identity, configuredUrl] = await Promise.all([readClientIdentity(), storedServerUrl()]);
    return { deviceId: identity?.deviceId ?? null, configuredUrl, ...deps.connection() };
  }

  // Who this client is. Deliberately answered here and not by the server: the
  // server has no notion of "the device asking" (dispatchLocal carries no caller
  // — see ipc/guard.ts), and every fact here is about this machine anyway. It is
  // what lets Settings → Devices point at your own row instead of offering to
  // revoke the credential you are holding.
  handleLocal('client:info', clientInfo);

  // Settings → Server. Pairing is the whole act: the address and the credential
  // are written together, because a token means nothing to a server that never
  // issued it. Nothing re-points at runtime — the event stream, the bound channel
  // list and every cached surface hang off the connection made at startup — so
  // this deliberately only changes what the NEXT launch will do, and the pane
  // says so rather than pretending otherwise.
  handleLocal('client:pair', async (_e, url: string, code: string): Promise<ClientInfo> => {
    await pairWithServer(url, code);
    return clientInfo();
  });
  handleLocal('client:useBuiltIn', async (): Promise<ClientInfo> => {
    await useBuiltInServer();
    return clientInfo();
  });

  // "What's new": the snapshot carries the whole decision (which sections are
  // unseen, and the silent marker advance when the popup is switched off), so the
  // renderer only has to render what it's handed. Onboarding is the one input
  // that isn't this machine's — the wizard is about the Stem account, not the
  // laptop — so it comes off the server's settings document.
  handleLocal('releaseNotes:get', async () =>
    releaseNotesSnapshot((await deps.settings()).onboarding.completed)
  );
  handleLocal('releaseNotes:markSeen', async () => {
    await markReleaseNotesRead();
  });
  handleLocal(
    'settings:updateReleaseNotes',
    async (_e, patch: Partial<ReleaseNotesSettings>): Promise<AppSettings> => {
      await updateClientReleaseNotes(patch);
      // The renderer is handed a whole settings document here as it is by every
      // other settings channel, which costs one round trip for the half this
      // machine doesn't own. Cheaper than a second shape for one toggle.
      return withClientSettings(await deps.settings());
    }
  );

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
