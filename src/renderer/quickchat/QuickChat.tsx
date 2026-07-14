import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, SquarePen, PanelRight, Globe, NotebookPen, Check } from 'lucide-react';
import type {
  BackendEventEnvelope,
  MessageMeta,
  ModelSummary,
  NativeWebSearchSettings,
  QuickChatSettings,
  StartTurnResult,
  TurnAttachment
} from '../../shared/types';
import { ChatView } from '../chat/ChatView';
import { optimisticMessageAttachments, resendAttachments, toMessageAttachments } from '../attachments';
import { EFFORT_LABELS } from '../modelLabels';
import { interruptibleTurnId } from '../pendingTurn';
import { McpApprovalCard } from '../manage/McpApprovalCard';
import { InstructionsApprovalCard } from '../manage/InstructionsApprovalCard';
import { NOTE_CONFIRM_MS, detectNoteTrigger, useNoteMode } from '../noteMode';
import {
  EMPTY_STATE,
  appendSystemMessage,
  applyBackendEventToThread,
  applyProcessExitToThread,
  backendEventThreadId,
  type ThreadState
} from '../chatState';

// The Spotlight-style overlay. It now owns its own conversation: it runs turns in
// its own backend thread and streams the answer in place (the main process hides it
// on submit and re-summons it via the shortcut). A compact bar captures the first
// prompt; once there are messages it expands into a conversation panel.
export function QuickChat() {
  // Model / effort / speed / format — seeded from the saved Quick Chat defaults.
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [serviceTier, setServiceTier] = useState<string | null>(null);
  const [format, setFormat] = useState<'md' | 'mdx'>('mdx');
  // Native web search, toggled independently per context — Quick Chat owns the
  // `quickChat` flag (surfaced here since it can pick a different model than main).
  const [nativeWebSearch, setNativeWebSearch] = useState<NativeWebSearchSettings>({ main: true, quickChat: true });

  // One conversation's state (this overlay only ever holds one thread at a time).
  const [chatState, setChatState] = useState<ThreadState>(EMPTY_STATE);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // `/note` / `//` quick-note capture in the compact bar (the expanded panel gets
  // its own instance inside ChatView).
  const { noteMode, flash: noteFlash, enterNoteMode, exitNoteMode, toggleNoteMode, saveNote } = useNoteMode();

  // Refs so the event subscription (registered once) reads current values.
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const chatStateRef = useRef(chatState);
  const turnMetaRef = useRef(new Map<string, MessageMeta>());
  const sendNonceRef = useRef(0);
  const settledTurnIdsRef = useRef(new Set<string>());
  const pendingStartRef = useRef<{
    promise: Promise<StartTurnResult>;
    turnId: string | null;
    threadId: string | null;
  } | null>(null);
  // A manual New Thread aborts the old session while its final events are still
  // routed here. Ignore those events so they cannot resurrect the cleared panel.
  const ignoredThreadIdsRef = useRef(new Set<string>());

  /** Keep an immediately-readable state mirror for main's handoff barrier. */
  const updateChatState = useCallback((update: ThreadState | ((state: ThreadState) => ThreadState)) => {
    const next = typeof update === 'function' ? update(chatStateRef.current) : update;
    chatStateRef.current = next;
    setChatState(next);
  }, []);

  const selectedModel = models.find((m) => m.id === modelId) ?? null;
  const { messages, running, streamingId, activity, activeTurnId } = chatState;

  useEffect(() => {
    return window.stem.onQuickChatHandoffRequest(({ id, threadId: requestedThreadId }) => {
      void (async () => {
        const ownedThreadId = threadIdRef.current;
        if (ownedThreadId && ownedThreadId !== requestedThreadId) return;
        // A sidebar row appears as soon as main creates the Quick Chat thread,
        // potentially before startTurn returns its interruptible id. Do not hand
        // main an un-cancellable `running:true, activeTurnId:null` slice: wait for
        // that already-running start promise, whose own continuation updates the
        // synchronous state ref before this continuation runs.
        const pending = pendingStartRef.current;
        if (pending && !pending.turnId) await pending.promise.catch(() => undefined);
        const state = chatStateRef.current;
        window.stem.respondQuickChatHandoffRequest(id, {
          threadId: requestedThreadId,
          messages: state.messages,
          running: state.running,
          streamingId: state.streamingId,
          activity: state.activity,
          activities: state.activities,
          activeTurnId: state.activeTurnId,
          status: state.status,
          model: modelId,
          effort,
          serviceTier
        });
      })();
    });
  }, [modelId, effort, serviceTier]);

  useEffect(() => {
    window.stem
      .listModels()
      .then(setModels)
      .catch(() => {});
    window.stem
      .getSettings()
      .then((s) => setNativeWebSearch(s.nativeWebSearch))
      .catch(() => {});
  }, []);

  function toggleNativeSearch(enabled: boolean) {
    window.stem
      .updateNativeWebSearch({ quickChat: enabled })
      .then((s) => setNativeWebSearch(s.nativeWebSearch))
      .catch(() => {});
  }

  // Seed model/effort/speed from the saved Quick Chat defaults (default model
  // falls back to the backend's default when unset).
  const applyDefaults = useCallback((qc: QuickChatSettings, list: ModelSummary[]) => {
    const fallback = list.find((m) => m.isDefault) ?? list[0] ?? null;
    const wanted = qc.defaultModel && list.some((m) => m.id === qc.defaultModel) ? qc.defaultModel : fallback?.id ?? null;
    setModelId(wanted);
    setEffort(qc.defaultEffort);
    setServiceTier(qc.defaultServiceTier);
  }, []);

  useEffect(() => {
    if (!models.length) return;
    window.stem.getSettings().then((s) => applyDefaults(s.quickChat, models));
  }, [models, applyDefaults]);

  // Clear the live session and return to a fresh compact bar (New thread, or an
  // inactivity reset). Re-seed the pickers from the saved defaults.
  const resetSession = useCallback(() => {
    pendingStartRef.current = null;
    ignoredThreadIdsRef.current.clear();
    threadIdRef.current = null;
    setThreadId(null);
    updateChatState(EMPTY_STATE);
    setInput('');
    exitNoteMode();
    if (models.length) window.stem.getSettings().then((s) => applyDefaults(s.quickChat, models));
  }, [models, applyDefaults, updateChatState, exitNoteMode]);

  // Each summon: `reset` => start a fresh thread; otherwise keep showing the
  // existing session (the answer the user re-summoned to read). Always refocus.
  useEffect(() => {
    return window.stem.onQuickChatFocus(({ reset }) => {
      if (reset) resetSession();
      requestAnimationFrame(() => inputRef.current?.focus());
    });
  }, [resetSession]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Window-level Escape => dismiss the overlay, for every mode. The compact bar
  // wires Escape on its own input, but the expanded panel's ChatView composer does
  // not — so without this, Escape stops working once a session has messages. We
  // skip it when an inner handler already consumed the Escape (e.g. cancelling an
  // inline message edit calls preventDefault), so that behavior still wins.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        window.stem.hideQuickChat();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Stream the overlay-owned thread. The main process only forwards this thread's
  // events to the overlay window, so every event we receive belongs to the current
  // session — we adopt its thread id if we don't have it yet (events can arrive
  // before runQuickChat resolves).
  useEffect(() => {
    return window.stem.onBackendEvent((event: BackendEventEnvelope) => {
      if (event.method === 'process/exit') {
        pendingStartRef.current = null;
        updateChatState((s) => applyProcessExitToThread(s));
        return;
      }

      const eventThreadId = backendEventThreadId(event);
      const settled =
        event.method === 'turn/completed' || event.method === 'turn/failed' || event.method === 'turn/aborted';
      if (settled) {
        const turnId = (event.params as { turn?: { id?: string } } | undefined)?.turn?.id;
        if (turnId) {
          settledTurnIdsRef.current.add(turnId);
          if (settledTurnIdsRef.current.size > 32) {
            const oldest = settledTurnIdsRef.current.values().next().value as string | undefined;
            if (oldest) settledTurnIdsRef.current.delete(oldest);
          }
          if (pendingStartRef.current?.turnId === turnId) pendingStartRef.current = null;
        }
      }
      if (eventThreadId && ignoredThreadIdsRef.current.has(eventThreadId)) {
        if (settled) ignoredThreadIdsRef.current.delete(eventThreadId);
        return;
      }
      if (threadIdRef.current && eventThreadId && eventThreadId !== threadIdRef.current) return;
      if (!threadIdRef.current && eventThreadId) {
        threadIdRef.current = eventThreadId;
        setThreadId(eventThreadId);
      }
      updateChatState((s) =>
        applyBackendEventToThread(s, event, {
          turnMeta: turnMetaRef.current,
          settledStatus: () => 'idle'
        }) ?? s
      );
    });
  }, [updateChatState]);

  const pushSystem = useCallback((e: unknown) => {
    updateChatState((s) => appendSystemMessage(s, e));
  }, [updateChatState]);

  const onSend = useCallback(
    async (text: string, attachments: TurnAttachment[] = []) => {
      // Close the double-submit window before React commits `running`.
      if (pendingStartRef.current || running) return;
      const sentAttachments = attachments.map((att) => ({ ...att }));
      const userMsgId = `user-${Date.now()}-${++sendNonceRef.current}`;
      updateChatState((s) => ({
        ...s,
        messages: [
          ...s.messages,
          {
            id: userMsgId,
            role: 'user',
            content: text,
            attachments: sentAttachments.length ? optimisticMessageAttachments(sentAttachments) : undefined,
            turnAttachments: sentAttachments
          }
        ],
        running: true,
        activity: null,
        activities: [],
        status: 'running'
      }));
      const startPromise = window.stem.runQuickChat({
        input: text,
        model: modelId,
        effort,
        serviceTier,
        format,
        threadId: threadId ?? undefined,
        attachments: sentAttachments.length ? sentAttachments : undefined
      });
      const pending = { promise: startPromise, turnId: null as string | null, threadId: null as string | null };
      pendingStartRef.current = pending;

      if (sentAttachments.length) {
        void toMessageAttachments(sentAttachments)
          .then((displayAttachments) => {
            updateChatState((state) => ({
              ...state,
              messages: state.messages.map((message) =>
                message.id === userMsgId ? { ...message, attachments: displayAttachments } : message
              )
            }));
          })
          .catch(() => undefined);
      }

      try {
        const result = await startPromise;
        pending.turnId = result.turnId ?? null;
        pending.threadId = result.threadId ?? null;
        const alreadySettled = result.turnId
          ? settledTurnIdsRef.current.delete(result.turnId)
          : false;
        // New Thread / handoff may have reset this session while start was still
        // pending. Populate the captured record for Stop's waiter, but never let
        // the stale callback resurrect the cleared overlay state.
        if (pendingStartRef.current !== pending) return;
        if (result.threadId) {
          threadIdRef.current = result.threadId;
          setThreadId(result.threadId);
        }
        if (result.turnId) {
          turnMetaRef.current.set(result.turnId, { model: modelId ?? undefined, effort: effort ?? undefined, serviceTier });
          updateChatState((s) => ({
            ...s,
            activeTurnId: alreadySettled ? null : result.turnId ?? null,
            messages: s.messages.map((m) => (m.id === userMsgId ? { ...m, turnId: result.turnId } : m))
          }));
        }
        if (alreadySettled) pendingStartRef.current = null;
        if (result.handled) {
          if (pendingStartRef.current === pending) pendingStartRef.current = null;
          updateChatState((s) => ({
            ...s,
            messages: result.assistantMessage
              ? [...s.messages, { id: `assistant-${Date.now()}`, role: 'assistant', content: result.assistantMessage as string }]
              : s.messages,
            running: false,
            activeTurnId: null,
            status: 'idle'
          }));
        }
      } catch (e) {
        if (pendingStartRef.current === pending) {
          pendingStartRef.current = null;
          pushSystem(e);
        }
      }
    },
    [modelId, effort, serviceTier, format, threadId, running, pushSystem, updateChatState]
  );

  const onInterrupt = useCallback(async () => {
    const pending = pendingStartRef.current;
    const turnId = await interruptibleTurnId(activeTurnId, pending);
    if (!turnId) return; // start failed/was handled; its own path already settled the UI
    try {
      await window.stem.interruptTurn(turnId);
      updateChatState((s) => ({
        ...s,
        running: false,
        streamingId: null,
        activity: null,
        activeTurnId: null,
        status: 'idle'
      }));
    } catch (e) {
      pushSystem(e);
    }
  }, [activeTurnId, pushSystem, updateChatState]);

  // Retry/Edit: roll the thread back to a turn and re-send. No-op while running.
  const rerunFromTurn = useCallback(
    async (turnId: string, text: string) => {
      if (!threadId || running) return;
      const userIdx = messages.findIndex((m) => m.turnId === turnId && m.role === 'user');
      if (userIdx === -1) return;
      const originalAttachments = resendAttachments(messages[userIdx]);
      try {
        await window.stem.rollbackToTurn(threadId, turnId);
      } catch (e) {
        pushSystem(e);
        return;
      }
      updateChatState((s) => ({ ...s, messages: s.messages.slice(0, userIdx) }));
      onSend(text, originalAttachments);
    },
    [threadId, running, messages, onSend, pushSystem, updateChatState]
  );

  const onRetry = useCallback(
    (turnId: string) => {
      const userMsg = messages.find((m) => m.turnId === turnId && m.role === 'user');
      if (userMsg) rerunFromTurn(turnId, userMsg.content);
    },
    [messages, rerunFromTurn]
  );
  const onEdit = useCallback(
    (turnId: string, newText: string) => {
      if (newText.trim()) rerunFromTurn(turnId, newText.trim());
    },
    [rerunFromTurn]
  );
  // Delete this turn and everything after it (truncate, no re-send). First turn →
  // delete the whole thread and reset to a fresh session.
  const onDelete = useCallback(
    async (turnId: string) => {
      if (!threadId || running) return;
      const userIdx = messages.findIndex((m) => m.turnId === turnId && m.role === 'user');
      if (userIdx === -1) return;
      if (userIdx === 0) {
        try {
          await window.stem.deleteChat(threadId);
        } catch (e) {
          pushSystem(e);
          return;
        }
        resetSession();
        return;
      }
      try {
        await window.stem.rollbackToTurn(threadId, turnId);
      } catch (e) {
        pushSystem(e);
        return;
      }
      updateChatState((s) => ({ ...s, messages: s.messages.slice(0, userIdx) }));
    },
    [threadId, running, messages, resetSession, pushSystem, updateChatState]
  );
  // Fork: branch the thread and continue the branch in the main app.
  const onFork = useCallback(
    async (turnId: string) => {
      if (!threadId) return;
      try {
        const { threadId: newId } = await window.stem.forkThread(threadId, turnId);
        const history = await window.stem.openChat(newId);
        await window.stem.handoffQuickChat({
          threadId: newId,
          messages: history.messages,
          running: false,
          streamingId: null,
          activity: null,
          activities: [],
          activeTurnId: null,
          status: 'idle',
          model: modelId,
          effort,
          serviceTier
        });
        resetSession();
      } catch (e) {
        pushSystem(e);
      }
    },
    [threadId, modelId, effort, serviceTier, resetSession, pushSystem]
  );

  async function newThread() {
    if (resetting) return;
    setResetting(true);
    const pending = pendingStartRef.current;
    const oldThreadId = threadIdRef.current;
    if (oldThreadId) ignoredThreadIdsRef.current.add(oldThreadId);
    let resolvedOldId: string | null = oldThreadId;
    try {
      if (running) await onInterrupt();
      resolvedOldId = oldThreadId ?? pending?.threadId ?? threadIdRef.current;
      if (resolvedOldId) ignoredThreadIdsRef.current.add(resolvedOldId);
      await window.stem.newQuickChatThread();
      resetSession();
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (e) {
      if (oldThreadId) ignoredThreadIdsRef.current.delete(oldThreadId);
      if (resolvedOldId) ignoredThreadIdsRef.current.delete(resolvedOldId);
      pushSystem(e);
    } finally {
      setResetting(false);
    }
  }

  async function openInStem() {
    if (!threadId) return;
    try {
      await window.stem.handoffQuickChat({
        threadId,
        messages,
        running: chatState.running,
        streamingId: chatState.streamingId,
        activity: chatState.activity,
        activities: chatState.activities,
        activeTurnId: chatState.activeTurnId,
        status: chatState.status,
        model: modelId,
        effort,
        serviceTier
      });
      resetSession();
    } catch (e) {
      pushSystem(e);
    }
  }

  function submitCompact() {
    const text = input.trim();
    if (!text) return;
    if (noteMode) {
      // Saved locally, no turn — so don't go through quickchat:run (it would hide
      // the overlay and flash the HUD). Show the ✓ here, then collapse ourselves.
      void saveNote(text).then((saved) => {
        if (!saved) return;
        setInput('');
        window.setTimeout(() => window.stem.hideQuickChat(), NOTE_CONFIRM_MS);
      });
      return;
    }
    setInput('');
    onSend(text, []);
  }

  const efforts =
    selectedModel && selectedModel.supportedEfforts.length ? selectedModel.supportedEfforts : ['low', 'medium', 'high'];
  const hasFast = selectedModel ? selectedModel.serviceTiers.some((t) => t.id === 'priority') : true;

  // Native web search toggle for Quick Chat turns, shown only when the selected
  // model's provider supports native search.
  const showSearch = !!selectedModel?.supportsNativeWebSearch;
  const searchOn = nativeWebSearch.quickChat;
  const searchToggle = (key: string) =>
    showSearch ? (
      <div className="seg-ctl compact" role="group" aria-label="Web search" key={key}>
        <button
          type="button"
          className={searchOn ? 'active' : ''}
          onClick={() => toggleNativeSearch(!searchOn)}
          title={`Native web search ${searchOn ? 'on' : 'off'}`}
        >
          <Globe size={13} /> Web
        </button>
      </div>
    ) : null;

  // Expanded conversation panel once the session has any messages.
  if (messages.length > 0) {
    return (
      <div className="qc-root">
        <div className="qc-card qc-panel">
          <div className="qc-head">
            <Sparkles className="qc-mark" size={18} />
            {searchToggle('head')}
            <span className="qc-spacer" />
            <button className="qc-act" title="New thread" onClick={() => void newThread()} disabled={resetting}>
              <SquarePen size={15} />
            </button>
            <button className="qc-act" title="Open in Stem" onClick={() => void openInStem()} disabled={!threadId}>
              <PanelRight size={15} />
            </button>
            <span className="qc-esc" onClick={() => window.stem.hideQuickChat()}>
              esc
            </span>
          </div>
          <ChatView
          messages={messages}
          running={running}
          streamingId={streamingId}
          activity={activity}
          activities={chatState.activities}
          onSend={onSend}
          onInterrupt={onInterrupt}
          escapeAction="off"
          onRetractActiveTurn={() => {}}
          pendingRestore={null}
          onRestoreConsumed={() => {}}
          onRetry={onRetry}
          onEdit={onEdit}
          onFork={onFork}
          onDelete={onDelete}
          models={models}
          model={selectedModel}
          effort={effort}
          serviceTier={serviceTier}
          format={format}
          draftFolderName={null}
          showContextMeter={false}
            onChangeEffort={setEffort}
            onChangeSpeed={setServiceTier}
            onChangeFormat={setFormat}
            onNoteSaved={() => window.stem.hideQuickChat()}
          />
        </div>
        <McpApprovalCard />
        <InstructionsApprovalCard />
      </div>
    );
  }

  // Compact spotlight bar for a fresh session.
  return (
    <div className="qc-root">
      <div className="qc-card">
        <div className="qc-row">
          {noteMode ? <NotebookPen className="qc-mark" size={22} /> : <Sparkles className="qc-mark" size={22} />}
          <input
            ref={inputRef}
            className="qc-input"
            value={input}
            placeholder={noteMode ? 'Save a note to memory…' : 'Ask Stem anything…'}
            onChange={(e) => {
              const value = e.target.value;
              const trigger = noteMode ? null : detectNoteTrigger(value);
              if (trigger) {
                enterNoteMode();
                setInput(trigger.body);
              } else {
                setInput(value);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitCompact();
              } else if (e.key === 'Escape' && noteMode) {
                // First Escape leaves note mode; the preventDefault keeps the
                // window-level handler from hiding the overlay on this press.
                e.preventDefault();
                exitNoteMode();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                window.stem.hideQuickChat();
              }
            }}
          />
          <span className="qc-esc">esc</span>
        </div>
        <div className="qc-foot">
          <div className="seg-ctl compact" role="group" aria-label="Reasoning effort">
            {efforts.map((e) => (
              <button key={e} type="button" className={effort === e ? 'active' : ''} onClick={() => setEffort(e)}>
                {EFFORT_LABELS[e] ?? e}
              </button>
            ))}
          </div>
          {hasFast && (
            <div className="seg-ctl compact" role="group" aria-label="Speed">
              <button type="button" className={serviceTier === 'priority' ? '' : 'active'} onClick={() => setServiceTier(null)}>
                Standard
              </button>
              <button
                type="button"
                className={serviceTier === 'priority' ? 'active' : ''}
                onClick={() => setServiceTier('priority')}
                title="1.5× speed, increased usage"
              >
                Fast
              </button>
            </div>
          )}
          {searchToggle('foot')}
          <div className="seg-ctl compact" role="group" aria-label="Memory note">
            <button
              type="button"
              className={noteMode ? 'active' : ''}
              onClick={toggleNoteMode}
              title="Save a note to memory — or type /note or //"
            >
              <NotebookPen size={13} /> Note
            </button>
          </div>
          <span className="qc-spacer" />
          {noteFlash ? (
            <span className={`note-flash${noteFlash === 'saved' ? ' ok' : ''}`} role="status" aria-live="polite">
              {noteFlash === 'saved' && <><Check size={13} /> Saved to memory</>}
              {noteFlash === 'off' && 'Memory is off — note not saved'}
              {noteFlash === 'secret' && 'Looks like a credential — not saved'}
              {noteFlash === 'error' && 'Couldn’t save the note — try restarting Stem'}
            </span>
          ) : (
            <span className="qc-hint">
              <kbd>⏎</kbd> {noteMode ? 'save note' : 'send'}
            </span>
          )}
        </div>
      </div>
      <McpApprovalCard />
      <InstructionsApprovalCard />
    </div>
  );
}
