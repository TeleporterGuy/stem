import { useCallback, useEffect, useState } from 'react';
import { Plus, FolderOpen, Trash2, ChevronRight } from 'lucide-react';
import type {
  ConnectedFolder,
  FolderIndexStatus,
  ModelSummary
} from '../../../shared/types';
import { InfoTip } from '../../ui/InfoTip';
import { ModelPicker } from '../../ui/ModelPicker';
import { FilesTab } from './FilesTab';

// ---- Sources tab: everywhere the assistant can read from ----
// Two kinds, split into sub-tabs because they are different things wearing the
// same word "files". Files holds *copies* inside Stem's workspace and every name
// is listed to the assistant each turn — a small, always-in-view pile, so its
// surface is a file browser. Connected folders are *references* to folders that
// stay where they live; nothing is enumerated (a vault has thousands of files),
// so the assistant searches them instead — and each one carries settings that
// govern how far it may go.
export function SourcesTab({ models }: { models: ModelSummary[] }) {
  const [sub, setSub] = useState<'files' | 'folders'>('files');
  return (
    <div>
      <div className="seg-ctl">
        <button className={sub === 'files' ? 'active' : ''} onClick={() => setSub('files')}>
          Files
        </button>
        <button className={sub === 'folders' ? 'active' : ''} onClick={() => setSub('folders')}>
          Connected folders
        </button>
      </div>
      {sub === 'files' ? <FilesTab /> : <ConnectedFoldersTab models={models} />}
    </div>
  );
}

// ---- Connected folders: external folders the assistant reads in place ----
// The user connects folders (an Obsidian vault, a financials folder) by absolute
// path; Stem reads them live, never copying. Per folder: a write toggle (read-only
// is enforced in the backend), a memorize toggle (off keeps its contents out of
// cross-chat memory — the intended default for a client's private vault), an
// index toggle (a local search index so relevant files surface in recall), and —
// when indexed and memorized — a "Learn facts" mode governing whether Stem
// distills durable facts from the folder's files.
//
// Cards are collapsed by default: name, path, and a one-line state summary.
// The settings list only renders for expanded cards, so the folder list stays
// scannable no matter how many per-folder settings accrue.

type LearnMode = NonNullable<ConnectedFolder['learnMode']>;

const LEARN_LABELS: Record<LearnMode, string> = {
  off: 'Off',
  use: 'On use',
  new: 'New & changed',
  all: 'Full history'
};

/** Average prompt chars one learning call consumes (MAX_TRANSCRIPT_CHARS-ish). */
const LEARN_CHARS_PER_CALL = 14_000;

/** Below this many indexed files, dropping the index is cheap enough to skip the confirm. */
const CONFIRM_DROP_INDEX_MIN_DOCS = 100;

/** Collapsed-card state summary: "Read-only · Indexed 3,412 · Learning 214/3,412". */
function cardSummary(f: ConnectedFolder, status: FolderIndexStatus | undefined): string {
  const parts = [f.mode === 'readwrite' ? 'Writable' : 'Read-only'];
  if (!f.memorize) parts.push('Private');
  if (f.index) {
    parts.push(
      !status || status.lastScanTs === null
        ? 'Indexing…'
        : `Indexed ${status.indexedCount.toLocaleString()}`
    );
  }
  if (f.index && f.memorize) {
    const mode = f.learnMode ?? 'use';
    if (mode === 'use') parts.push('Learns on use');
    else if (mode !== 'off') {
      const pending = status?.learn.pending ?? 0;
      const facts = status?.learn.facts ?? 0;
      if (status && pending > 0) {
        const done = Math.max(0, status.indexedCount - pending);
        parts.push(`Learning ${done.toLocaleString()}/${status.indexedCount.toLocaleString()}`);
      } else if (facts > 0) {
        parts.push(`Learned ${facts.toLocaleString()} fact${facts === 1 ? '' : 's'}`);
      } else {
        parts.push(`Learns ${LEARN_LABELS[mode].toLowerCase()}`);
      }
    }
  }
  return parts.join(' · ');
}

/** "Indexed 3,412 · 214 skipped" with the skip breakdown in an InfoTip. */
function IndexStatusLine({ status }: { status: FolderIndexStatus }) {
  const skipped = Object.entries(status.skippedByExt).sort((a, b) => b[1] - a[1]);
  return (
    <div className="muted cfolder-index-status">
      {status.lastScanTs === null
        ? 'Indexing…'
        : `Indexed ${status.indexedCount.toLocaleString()} file${status.indexedCount === 1 ? '' : 's'}`}
      {status.skippedCount > 0 && (
        <>
          {' · '}
          {status.skippedCount.toLocaleString()} skipped
          <InfoTip label="Which files were skipped">
            Text files (.md, .txt) and PDFs with a text layer are indexed; scanned image-only
            PDFs are skipped (no OCR). Skipped here:{' '}
            {skipped.map(([ext, n]) => `${ext} ×${n}`).join(', ')}.
          </InfoTip>
        </>
      )}
      {status.pendingEmbeds > 0 && ` · ${status.pendingEmbeds.toLocaleString()} awaiting embedding`}
    </div>
  );
}

/** "Learning… 214/3,412 files · 12 facts" while draining; "Learned 38 facts" after. */
function LearnStatusLine({ status }: { status: FolderIndexStatus }) {
  const { pending, facts, lastTs } = status.learn;
  if (pending > 0) {
    const done = Math.max(0, status.indexedCount - pending);
    return (
      <div className="muted cfolder-index-status">
        Learning… {done.toLocaleString()}/{status.indexedCount.toLocaleString()} files
        {facts > 0 && ` · ${facts.toLocaleString()} fact${facts === 1 ? '' : 's'}`}
      </div>
    );
  }
  if (facts > 0) {
    return (
      <div className="muted cfolder-index-status">
        Learned {facts.toLocaleString()} fact{facts === 1 ? '' : 's'}
        {lastTs != null && ` · ${new Date(lastTs * 1000).toLocaleDateString()}`}
      </div>
    );
  }
  if (lastTs != null) {
    return <div className="muted cfolder-index-status">No durable facts found yet</div>;
  }
  return null;
}

function ConnectedFoldersTab({ models }: { models: ModelSummary[] }) {
  const [folders, setFolders] = useState<ConnectedFolder[]>([]);
  const [indexStatus, setIndexStatus] = useState<Record<string, FolderIndexStatus>>({});
  const [busy, setBusy] = useState(false);
  // Folder ids with an unconfirmed "Full history" selection (cost confirm shown).
  const [confirmAll, setConfirmAll] = useState<Record<string, boolean>>({});
  // Expanded cards (settings visible). Collapsed cards show a summary line instead.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleOpen = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const refreshStatus = useCallback(() => {
    window.stem.folderIndexStatus().then(setIndexStatus).catch(() => undefined);
  }, []);

  useEffect(() => {
    window.stem.listConnectedFolders().then(setFolders);
    refreshStatus();
  }, [refreshStatus]);

  // While any folder is indexed, poll the status line lazily (scans/embeds/learn
  // batches run in the background; counts drift without user action).
  useEffect(() => {
    if (!folders.some((f) => f.index)) return;
    const timer = setInterval(refreshStatus, 10_000);
    return () => clearInterval(timer);
  }, [folders, refreshStatus]);

  async function add() {
    setBusy(true);
    try {
      const paths = await window.stem.pickDirectory();
      if (paths.length) {
        const before = new Set(folders.map((x) => x.id));
        const next = await window.stem.addConnectedFolders(paths);
        setFolders(next);
        // A just-connected folder is about to be configured — open its card.
        setExpanded((s) => new Set([...s, ...next.filter((x) => !before.has(x.id)).map((x) => x.id)]));
      }
    } finally {
      setBusy(false);
    }
  }

  const setMode = async (id: string, writable: boolean) =>
    setFolders(await window.stem.updateConnectedFolder(id, { mode: writable ? 'readwrite' : 'read' }));
  const setMemorize = async (id: string, memorize: boolean) =>
    setFolders(await window.stem.updateConnectedFolder(id, { memorize }));
  const setIndex = async (id: string, index: boolean) => {
    // Turning Index off deletes the folder's index DB outright — for a big
    // folder that throws away a long scan/extract/embed run (and the per-doc
    // learn marks live in the same DB), so confirm before dropping it.
    if (!index) {
      const f = folders.find((x) => x.id === id);
      const docs = indexStatus[id]?.indexedCount ?? 0;
      if (docs >= CONFIRM_DROP_INDEX_MIN_DOCS) {
        const mode = f?.learnMode ?? 'use';
        const learnNote =
          mode === 'new' || mode === 'all'
            ? '\n\nFact-learning progress is kept in the index, so turning it back on would also send every file through the learning model again.'
            : '';
        const ok = window.confirm(
          `Turn off indexing for “${f?.label ?? 'this folder'}”?\n\nIts search index (${docs.toLocaleString()} files) is deleted; turning indexing back on later re-scans and re-embeds everything from scratch.${learnNote}`
        );
        if (!ok) return;
      }
    }
    setFolders(await window.stem.updateConnectedFolder(id, { index }));
    setTimeout(refreshStatus, 1_500); // The toggle-on scan starts ~0.5s later.
  };
  const setLearnMode = async (id: string, learnMode: LearnMode) => {
    setConfirmAll((c) => ({ ...c, [id]: false }));
    setFolders(await window.stem.updateConnectedFolder(id, { learnMode }));
    setTimeout(refreshStatus, 2_000); // The learn drain kicks ~1s later.
  };
  const setLearnModel = async (id: string, model: string | null) =>
    setFolders(await window.stem.updateConnectedFolder(id, { learnModel: model ?? '' }));
  const remove = async (id: string) => {
    const f = folders.find((x) => x.id === id);
    const facts = indexStatus[id]?.learn.facts ?? 0;
    setFolders(await window.stem.removeConnectedFolder(id));
    // Facts are memories, not an index — keeping them is the default. Offer the
    // cleanup, since the folder tag now points at a disconnected source.
    if (
      facts > 0 &&
      window.confirm(
        `Also forget the ${facts.toLocaleString()} fact${facts === 1 ? '' : 's'} Stem learned from “${f?.label ?? 'this folder'}”?\n\nOK forgets them; Cancel keeps them in memory (pinned facts are always kept).`
      )
    ) {
      await window.stem.forgetConnectedFolderFacts(id).catch(() => undefined);
    }
  };

  /** The mode to render for a folder: an unconfirmed 'all' keeps showing 'all' in the select. */
  const shownLearnMode = (f: ConnectedFolder): LearnMode =>
    confirmAll[f.id] ? 'all' : f.learnMode ?? 'use';

  const learnCalls = (status: FolderIndexStatus | undefined): number | null =>
    status ? Math.max(1, Math.ceil(status.totalTextChars / LEARN_CHARS_PER_CALL)) : null;

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
          {folders.map((f) => {
            const status = indexStatus[f.id];
            const mode = shownLearnMode(f);
            const learnRows = !!f.index && f.memorize;
            const calls = learnCalls(status);
            const open = expanded.has(f.id);
            return (
              <div key={f.id} className="cfolder-item">
                <div className="cfolder-head cfolder-head-toggle" onClick={() => toggleOpen(f.id)}>
                  <button
                    className="cfolder-chev"
                    aria-expanded={open}
                    aria-label={open ? 'Collapse folder settings' : 'Expand folder settings'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleOpen(f.id);
                    }}
                  >
                    <ChevronRight size={13} className={open ? 'open' : ''} />
                  </button>
                  <span className="row-main">
                    <strong>
                      {f.label}
                      {f.missing && <span className="muted cfolder-missing"> · missing</span>}
                    </strong>
                    {/* LRM guards stop the RTL truncation trick (styles.css) from
                        visually relocating the path's leading slash to the end. */}
                    <em title={f.path}>{`‎${f.path}‎`}</em>
                  </span>
                  <button
                    className="icon-action sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      window.stem.revealConnectedFolder(f.id);
                    }}
                    title="Reveal in Finder"
                    aria-label="Reveal in Finder"
                  >
                    <FolderOpen size={14} />
                  </button>
                  <button
                    className="icon-action sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(f.id);
                    }}
                    title="Disconnect (does not delete the folder)"
                    aria-label="Disconnect folder"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {!open && <div className="muted cfolder-summary">{cardSummary(f, status)}</div>}
                {open && (
                <div className="cfolder-opts">
                  <div className="cfolder-opt">
                    <span className="cfolder-opt-label">Writable</span>
                    <button
                      className={`switch${f.mode === 'readwrite' ? ' on' : ''}`}
                      role="switch"
                      aria-checked={f.mode === 'readwrite'}
                      aria-label="Writable"
                      title="Allow Stem to edit files in this folder (off = read-only, enforced by Stem)"
                      onClick={() => setMode(f.id, f.mode !== 'readwrite')}
                    />
                  </div>
                  <div className="cfolder-opt">
                    <span className="cfolder-opt-label">Memorize</span>
                    <button
                      className={`switch${f.memorize ? ' on' : ''}`}
                      role="switch"
                      aria-checked={f.memorize}
                      aria-label="Memorize"
                      title="Let Stem remember this folder's contents across chats (off = private)"
                      onClick={() => setMemorize(f.id, !f.memorize)}
                    />
                  </div>
                  <div className="cfolder-opt">
                    <span className="cfolder-opt-label">
                      Index
                      <InfoTip label="What indexing does">
                        Indexing builds a private local search index (keyword + semantic) over this
                        folder's .md, .txt and .pdf files, so relevant notes surface automatically in
                        conversations and the assistant can search them. The folder itself is never
                        modified, and turning this off deletes the index. Folders kept in sync by an
                        external tool (e.g. a mail or cloud mirror) re-index automatically as files
                        change.
                      </InfoTip>
                    </span>
                    <button
                      className={`switch${f.index ? ' on' : ''}`}
                      role="switch"
                      aria-checked={!!f.index}
                      aria-label="Index"
                      title="Build a local search index over this folder's text files"
                      onClick={() => setIndex(f.id, !f.index)}
                    />
                  </div>
                  {f.index && status && <IndexStatusLine status={status} />}
                  {learnRows && (
                    <div className="cfolder-opt">
                      <span className="cfolder-opt-label">
                        Learn facts
                        <InfoTip label="How fact learning works">
                          Whether Stem distills durable facts (amounts, dates, clients, plans) from
                          this folder into its memory. On use: only from excerpts that actually
                          surface in your chats — free, rides the normal memory pass. New &amp;
                          changed: also processes files added or edited from now on, in the
                          background. Full history: first sweeps every indexed file (you confirm
                          the cost), then continues like New &amp; changed. Learned facts appear in
                          the Memory tab attributed to this folder and are kept even if a file is
                          later deleted.
                        </InfoTip>
                      </span>
                      <select
                        className="ifield cfolder-learn-select"
                        aria-label="Learn facts mode"
                        value={mode}
                        onChange={(e) => {
                          const next = e.target.value as LearnMode;
                          if (next === 'all' && (f.learnMode ?? 'use') !== 'all') {
                            // Full history sweeps the whole folder — confirm the cost first.
                            setConfirmAll((c) => ({ ...c, [f.id]: true }));
                            return;
                          }
                          void setLearnMode(f.id, next);
                        }}
                      >
                        {(Object.keys(LEARN_LABELS) as LearnMode[]).map((m) => (
                          <option key={m} value={m}>
                            {LEARN_LABELS[m]}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {learnRows && confirmAll[f.id] && (
                    <div className="cfolder-learn-confirm">
                      <span className="muted">
                        Sweep {status ? status.indexedCount.toLocaleString() : 'all'} files
                        {calls != null && ` (≈${calls.toLocaleString()} model calls)`}
                      </span>
                      {/* The model is part of the commit decision — pick it right
                          beside the cost estimate it determines. */}
                      <div className="cfolder-opt">
                        <span className="cfolder-opt-label">Model</span>
                        <span className="cfolder-learn-model">
                          <ModelPicker
                            models={models}
                            value={f.learnModel ?? null}
                            onChange={(id) => void setLearnModel(f.id, id)}
                            emptyLabel="Memory default"
                            ariaLabel="Fact-learning model"
                          />
                        </span>
                      </div>
                      <span className="push-row">
                        <button type="button" className="push" onClick={() => setConfirmAll((c) => ({ ...c, [f.id]: false }))}>
                          Cancel
                        </button>
                        <button type="button" className="push default" onClick={() => void setLearnMode(f.id, 'all')}>
                          Start
                        </button>
                      </span>
                    </div>
                  )}
                  {learnRows && (mode === 'new' || mode === 'all') && !confirmAll[f.id] && (
                    <div className="cfolder-opt">
                      <span className="cfolder-opt-label">Model</span>
                      <span className="cfolder-learn-model">
                        <ModelPicker
                          models={models}
                          value={f.learnModel ?? null}
                          onChange={(id) => void setLearnModel(f.id, id)}
                          emptyLabel="Memory default"
                          ariaLabel="Fact-learning model"
                        />
                      </span>
                    </div>
                  )}
                  {learnRows && (mode === 'new' || mode === 'all') && !confirmAll[f.id] && status && (
                    <LearnStatusLine status={status} />
                  )}
                </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
