import { useEffect, useState } from 'react';
import { Plus, FolderOpen, Trash2 } from 'lucide-react';
import type {
  ConnectedFolder
} from '../../../shared/types';

// ---- Folders tab: external folders the assistant reads in place ----
// The user connects folders (an Obsidian vault, a financials folder) by absolute
// path; Stem reads them live, never copying. Per folder: a write toggle (read-only
// is enforced in the backend) and a memorize toggle (off keeps its contents out of
// cross-chat memory — the intended default for a client's private vault).
export function FoldersTab() {
  const [folders, setFolders] = useState<ConnectedFolder[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.stem.listConnectedFolders().then(setFolders);
  }, []);

  async function add() {
    setBusy(true);
    try {
      const paths = await window.stem.pickDirectory();
      if (paths.length) setFolders(await window.stem.addConnectedFolders(paths));
    } finally {
      setBusy(false);
    }
  }

  const setMode = async (id: string, writable: boolean) =>
    setFolders(await window.stem.updateConnectedFolder(id, { mode: writable ? 'readwrite' : 'read' }));
  const setMemorize = async (id: string, memorize: boolean) =>
    setFolders(await window.stem.updateConnectedFolder(id, { memorize }));
  const remove = async (id: string) => setFolders(await window.stem.removeConnectedFolder(id));

  return (
    <div>
      <div className="grp-head cfolders-head">
        Connected folders
        <span className="grp-head-actions">
          <button className="grp-head-add" onClick={() => window.stem.openWorkspaceFolder()} title="Open Stem's own folder in Finder" aria-label="Open Stem's folder">
            <FolderOpen size={14} />
          </button>
          <button className="grp-head-add" onClick={add} disabled={busy} title="Connect an external folder Stem can read" aria-label="Add folder">
            <Plus size={14} />
          </button>
        </span>
      </div>

      {folders.length === 0 ? (
        <p className="muted">
          Connect a folder — an Obsidian vault, a project folder — and Stem can read its files in
          place (never copied). Read-only by default; turn off Memorize to keep a private folder's
          contents out of Stem's memory.
        </p>
      ) : (
        <div className="group">
          {folders.map((f) => (
            <div key={f.id} className="cfolder-item">
              <div className="cfolder-head">
                <span className="row-main">
                  <strong>
                    {f.label}
                    {f.missing && <span className="muted cfolder-missing"> · missing</span>}
                  </strong>
                  <em>{f.path}</em>
                </span>
                <button className="icon-action sm" onClick={() => window.stem.revealConnectedFolder(f.id)} title="Reveal in Finder" aria-label="Reveal in Finder">
                  <FolderOpen size={14} />
                </button>
                <button className="icon-action sm" onClick={() => remove(f.id)} title="Disconnect (does not delete the folder)" aria-label="Disconnect folder">
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="cfolder-opts">
                <button
                  className="cfolder-opt"
                  role="switch"
                  aria-checked={f.mode === 'readwrite'}
                  title="Allow Stem to edit files in this folder (off = read-only, enforced by Stem)"
                  onClick={() => setMode(f.id, f.mode !== 'readwrite')}
                >
                  <span>Writable</span>
                  <span className={`switch${f.mode === 'readwrite' ? ' on' : ''}`} />
                </button>
                <button
                  className="cfolder-opt"
                  role="switch"
                  aria-checked={f.memorize}
                  title="Let Stem remember this folder's contents across chats (off = private)"
                  onClick={() => setMemorize(f.id, !f.memorize)}
                >
                  <span>Memorize</span>
                  <span className={`switch${f.memorize ? ' on' : ''}`} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
