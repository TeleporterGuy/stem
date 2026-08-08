import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type {
  ChatsSettings,
  CustomInstructionsSettings,
  ExecSettings,
  WebSearchSettings
} from '../../../../shared/types';
import { InfoTip } from '../../../ui/InfoTip';
import { ModelPicker } from '../../../ui/ModelPicker';
import type { ModelTabProps } from '../shared';

/**
 * Settings → Chat: everything that shapes an ordinary conversation — which model
 * answers, how chats get named, the instructions carried into every turn, and
 * what the assistant is allowed to run while it works.
 */
export function ChatSettings({ models, modelId, onSelectModel }: ModelTabProps) {
  const [ws, setWs] = useState<WebSearchSettings>({
    main: true,
    quickChat: true,
    provider: 'auto',
    credentials: {}
  });
  const [ci, setCi] = useState<CustomInstructionsSettings>({ main: '', quickChat: '' });
  const [chats, setChats] = useState<ChatsSettings | null>(null);
  const [exec, setExec] = useState<ExecSettings | null>(null);
  const [allowInput, setAllowInput] = useState('');
  // Per-field debounce so typing doesn't spam the atomic settings writer.
  const ciMainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void window.stem.getSettings().then((s) => {
      setWs(s.webSearch);
      setCi(s.customInstructions);
      setChats(s.chats);
      setExec(s.exec);
    });
  }, []);

  function updateWebSearch(patch: Partial<WebSearchSettings>) {
    setWs((cur) => ({ ...cur, ...patch })); // optimistic; reconcile below
    window.stem.updateWebSearch(patch).then((s) => setWs(s.webSearch));
  }

  function updateChats(patch: Partial<ChatsSettings>) {
    setChats((cur) => (cur ? { ...cur, ...patch } : cur)); // optimistic; reconcile below
    window.stem.updateChatsSettings(patch).then((s) => {
      setChats(s.chats);
      // The chat list lives in this same window and re-reads the settings for
      // itself. Told after the write, not before, or it would read the old value.
      window.dispatchEvent(new CustomEvent('stem:chat-settings'));
    });
  }

  function updateExec(patch: Partial<ExecSettings>) {
    setExec((cur) => (cur ? { ...cur, ...patch } : cur)); // optimistic; reconcile below
    window.stem.updateExecSettings(patch).then((s) => setExec(s.exec));
  }

  function saveCiMain(value: string) {
    setCi((c) => ({ ...c, main: value }));
    if (ciMainTimer.current) clearTimeout(ciMainTimer.current);
    ciMainTimer.current = setTimeout(() => void window.stem.updateCustomInstructions({ main: value }), 400);
  }

  return (
    <div>
      <div className="grp-head">Model</div>
      <div className="formgroup">
        {models.length === 0 ? (
          <p className="muted">Loading models…</p>
        ) : (
          <>
            <ModelPicker
              models={models}
              value={modelId}
              onChange={(id) => onSelectModel(id ?? '')}
              ariaLabel="Model"
            />
            <label className="set-check" title="Search the live web for current info, with citations">
              <input type="checkbox" checked={ws.main} onChange={(e) => updateWebSearch({ main: e.target.checked })} />
              Web search
            </label>
          </>
        )}
      </div>

      <div className="grp-head">Chats</div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">
            Subjects{' '}
            <InfoTip label="About chat subjects">
              Stem writes each new chat a short subject from your first message, the way an email
              names a thread. <strong>Everywhere</strong> uses it as the chat's name, so the list,
              search and the window title all agree. <strong>Inbox only</strong> shows it in the
              Inbox and leaves names alone. <strong>Off</strong> never calls a model — a chat is
              named after the first line you typed. A name you type yourself is never overwritten.
            </InfoTip>
          </span>
          <div className="seg-ctl">
            <button
              className={chats?.subjects === 'off' ? 'active' : ''}
              onClick={() => updateChats({ subjects: 'off' })}
              title="Never write subjects"
            >
              Off
            </button>
            <button
              className={chats?.subjects === 'inbox' ? 'active' : ''}
              onClick={() => updateChats({ subjects: 'inbox' })}
              title="Write subjects, but don't rename chats"
            >
              Inbox only
            </button>
            <button
              className={chats?.subjects === 'everywhere' ? 'active' : ''}
              onClick={() => updateChats({ subjects: 'everywhere' })}
              title="Use the subject as the chat's name"
            >
              Everywhere
            </button>
          </div>
        </div>
        <div className="set-block">
          <span className="set-sub">
            Subject model{' '}
            <InfoTip label="About the subject model">
              Writes the subject line, once per new chat. A small, fast model is plenty — this is a
              few words from your opening message, not a summary of the conversation.
            </InfoTip>
          </span>
          <ModelPicker
            models={models}
            value={chats?.subjectModel ?? null}
            onChange={(id) => updateChats({ subjectModel: id })}
            emptyLabel="Default (recommended)"
            ariaLabel="Subject model"
            disabled={chats?.subjects === 'off'}
          />
        </div>
        <div className="set-block">
          <span className="set-sub">
            Preview lines in the Inbox{' '}
            <InfoTip label="About preview lines">
              How much of the newest message each Inbox row shows underneath its subject. The Chats
              tree is unaffected — it stays one line per chat.
            </InfoTip>
          </span>
          <div className="seg-ctl">
            <button
              className={chats?.previewLines === 0 ? 'active' : ''}
              onClick={() => updateChats({ previewLines: 0 })}
            >
              None
            </button>
            <button
              className={chats?.previewLines === 1 ? 'active' : ''}
              onClick={() => updateChats({ previewLines: 1 })}
            >
              1 line
            </button>
            <button
              className={chats?.previewLines === 2 ? 'active' : ''}
              onClick={() => updateChats({ previewLines: 2 })}
            >
              2 lines
            </button>
          </div>
        </div>
      </div>

      <div className="grp-head">Custom instructions</div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">
            Standing instructions{' '}
            <InfoTip label="About standing instructions">
              High-priority directives Stem follows in every reply — in the main app and in Quick
              Chat. Stem can also update these itself when you ask it to.
            </InfoTip>
          </span>
          <textarea
            className="ci-textarea"
            value={ci.main}
            onChange={(e) => saveCiMain(e.target.value)}
            rows={5}
            placeholder="e.g. Reply briefly and to the point. Use plain Markdown unless I ask for components."
          />
        </div>
      </div>

      <div className="grp-head">Command execution</div>
      <div className="formgroup">
        <div className="set-row">
          <span className="set-label">
            <strong>Run commands</strong>
            <em>
              Let Stem run shell commands (CLIs, git, agent-browser){' '}
              <InfoTip label="How command approval works">
                What runs on its own is governed by the approval mode below — from manual (you
                approve everything unlisted) to yolo (everything runs). Folders you marked
                read-only are always protected.
              </InfoTip>
            </em>
          </span>
          <button
            className={`switch${exec?.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={exec?.enabled ?? false}
            aria-label="Run commands"
            onClick={() => exec && updateExec({ enabled: !exec.enabled })}
          />
        </div>

        {exec?.enabled && (
          <>
            <div className="set-block">
              <span className="set-sub">
                Approval mode{' '}
                <InfoTip label="About approval modes">
                  <strong>Manual</strong> — only allowlisted commands run on their own; everything
                  else pauses for your approval. <strong>Assisted</strong> — an AI safety check
                  clears commands that serve your request; only flagged ones pause.{' '}
                  <strong>Yolo</strong> — every command runs immediately, no questions asked (folders
                  you marked read-only stay protected). The safety check is a heuristic, not a
                  security boundary.
                </InfoTip>
              </span>
              <div className="seg-ctl">
                <button
                  className={exec.approvalMode === 'manual' ? 'active' : ''}
                  onClick={() => updateExec({ approvalMode: 'manual' })}
                >
                  Manual
                </button>
                <button
                  className={exec.approvalMode === 'assisted' ? 'active' : ''}
                  onClick={() => updateExec({ approvalMode: 'assisted' })}
                >
                  Assisted
                </button>
                <button
                  className={exec.approvalMode === 'yolo' ? 'active' : ''}
                  onClick={() => updateExec({ approvalMode: 'yolo' })}
                  title="Every command runs immediately — use with care"
                >
                  Yolo
                </button>
              </div>
            </div>

            {exec.approvalMode === 'assisted' && (
              <div className="set-block">
                <span className="set-sub">
                  Safety-check model{' '}
                  <InfoTip label="About the safety-check model">
                    On <b>Auto</b>, Stem uses the cheapest model your chat's provider offers — a
                    Haiku, mini, or flash tier. A provider that publishes no cheap tier gets checked
                    by the chat's own model instead, so the check stays on a provider you're signed
                    in to. Pick a model here to pin it.
                  </InfoTip>
                </span>
                <ModelPicker
                  models={models}
                  value={exec.judgeModel}
                  onChange={(id) => updateExec({ judgeModel: id })}
                  emptyLabel="Auto"
                  ariaLabel="Safety-check model"
                />
              </div>
            )}

            {exec.approvalMode !== 'yolo' && (
              <div className="set-block">
                <span className="set-sub">
                  Always-allowed commands{' '}
                  <InfoTip label="About the allowlist">
                    Command prefixes that run without the safety check — grown by the approval card's
                    "Always allow" button or added here (e.g. <code>git push</code> or <code>npm</code>).
                  </InfoTip>
                </span>
                {exec.allowlist.length > 0 && (
                  <div className="exec-allowlist">
                    {exec.allowlist.map((prefix) => (
                      <span key={prefix} className="pill">
                        {prefix}
                        <button
                          title={`Remove "${prefix}"`}
                          aria-label={`Remove "${prefix}" from the allowlist`}
                          onClick={() => updateExec({ allowlist: exec.allowlist.filter((p) => p !== prefix) })}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const prefix = allowInput.trim();
                    if (!prefix || exec.allowlist.includes(prefix)) return;
                    updateExec({ allowlist: [...exec.allowlist, prefix] });
                    setAllowInput('');
                  }}
                >
                  <input
                    className="ifield"
                    type="text"
                    placeholder="Add a prefix, e.g. git push"
                    aria-label="Add an allowlisted command prefix"
                    value={allowInput}
                    onChange={(e) => setAllowInput(e.target.value)}
                  />
                </form>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
