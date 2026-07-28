import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CloudOff, Link2Off, RotateCw, Sparkles } from 'lucide-react';
import type { ChatMessage, ChatSummary, TurnAttachment } from '../../shared/types';
import { EMPTY_STATE, mergeDraftIntoReal, mergeHydratedThread, type ThreadState } from '../chatState';
import { deletePendingIfCurrent, rekeyPendingIfCurrent } from '../pendingTurn';
import { RequestGate } from '../requestGate';
import { useThreadStates } from '../session/store';
import {
  attachBackendEvents,
  createSessionCore,
  interruptActiveTurn,
  sendTurn,
  type SessionCore
} from '../session/turns';
import { createApprovalStore } from './approvals';
import { ApprovalSheet } from './ApprovalSheet';
import { ChatList } from './ChatList';
import { ThreadView } from './ThreadView';
import { mobileStartTurnInput } from './turn';
import { pairFromPastedLink } from './transport';
import type { ConnectionState, MobileTransport } from './transport';

// The phone client. It is the third host of session/turns.ts, after the main
// window and the Quick Chat overlay: the streaming state machine, the settled-
// turn race guard and the optimistic-send skeleton are all shared code, and what
// is host-specific — how events are routed, what a settled turn does to a chat
// row, what happens to a draft when its real thread id arrives — is supplied
// here, exactly as the other two surfaces supply theirs.
//
// Two things shape this file and are deliberate:
//
//   * One screen at a time. A phone shows the chat list OR a conversation, never
//     both, so there is no sidebar, no folder tree, no Manage tabs. Memory
//     management, model selection and Spaces stay at the desk by decision.
//   * The Mac is allowed to be asleep. Stem does not keep it awake, so
//     "unreachable" is a normal resting state rather than an error: the banner
//     says so in words, EventSource reconnects on its own, and when it comes back
//     the client re-reads the chat list and the open transcript instead of
//     waiting for the user to reload.

/** Slice key for a chat that has no thread id yet (the first turn creates it). */
const DRAFT = '__mobile_draft__';

export function MobileApp({ transport }: { transport: MobileTransport }) {
  const connection = useSyncExternalStore(transport.connection.subscribe, transport.connection.get);

  const coreRef = useRef<SessionCore | null>(null);
  if (!coreRef.current) coreRef.current = createSessionCore();
  const core = coreRef.current;
  const states = useThreadStates(core.store);
  // Inert until the sheet mounts and attaches it, so nothing here subscribes
  // twice under StrictMode's double render.
  const approvals = useMemo(() => createApprovalStore(), []);

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loadingChats, setLoadingChats] = useState(true);
  const [threadId, setThreadId] = useState<string | null>(null);
  /** A new chat is being composed: the draft slice is on screen, with no thread. */
  const [composing, setComposing] = useState(false);
  /** Why the open transcript may be incomplete (a failed read), if it is. */
  const [loadNotice, setLoadNotice] = useState<string | null>(null);

  // Refs so event routing and IPC continuations never read a stale closure.
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  /** Bumped whenever navigation abandons the current draft (see onSend). */
  const draftSeqRef = useRef(0);
  const openGateRef = useRef(new RequestGate());

  const refreshChats = useCallback(async () => {
    setLoadingChats(true);
    try {
      const list = await window.stem.listChats();
      setChats([...list.chats].sort((a, b) => b.updatedAt - a.updatedAt));
    } catch {
      // Unreachable is the expected failure here, and the banner already says so.
    } finally {
      setLoadingChats(false);
    }
  }, []);

  /**
   * Re-read a thread's transcript from disk and fold the live slice over it. The
   * phone is away far more than the desktop is, so a slice assembled from events
   * alone can easily be partial (or, for a thread that ran at the desk while the
   * stream was down, missing entirely). mergeHydratedThread is built for exactly
   * this: disk supplies history, anything newer in memory wins.
   */
  const hydrateThread = useCallback(
    async (id: string) => {
      const request = openGateRef.current.begin();
      const before = core.store.getThread(id);
      try {
        const history = await window.stem.openChat(id);
        if (!openGateRef.current.isCurrent(request)) return;
        core.store.update((prev) => ({
          ...prev,
          [history.threadId]: mergeHydratedThread(history.messages, prev[history.threadId], before)
        }));
        setLoadNotice(null);
      } catch (e) {
        if (!openGateRef.current.isCurrent(request)) return;
        setLoadNotice(
          `Couldn’t load this chat — ${String(e instanceof Error ? e.message : e)}`
        );
      }
    },
    [core]
  );

  useEffect(() => {
    void refreshChats();
  }, [refreshChats]);

  // The shared backend-event pipeline. Every non-internal thread's events reach
  // the phone (the bridge doesn't track which chat is open), so routing is by
  // thread id just as it is in the main window; opening a chat always re-reads
  // it from disk, which is what keeps a partially-observed slice honest.
  useEffect(() => {
    const events = attachBackendEvents(core, {
      routeEvent: (eventThreadId) => eventThreadId ?? null,
      settledStatus: (method, id) => {
        if (method === 'turn/failed') return 'error';
        // Finished while another chat (or the list) was on screen → unread dot.
        if (method === 'turn/completed') return id === threadIdRef.current ? 'idle' : 'done';
        return 'idle';
      }
    });
    return events.detach;
  }, [core]);

  // Follow the stream back up. EventSource reconnects by itself, but events that
  // landed while it was down are simply gone — so a recovered connection re-reads
  // the list and the open transcript rather than leaving the phone showing a
  // conversation frozen at whatever it last saw.
  const wasOnlineRef = useRef(false);
  useEffect(() => {
    if (connection !== 'online') {
      wasOnlineRef.current = false;
      return;
    }
    if (wasOnlineRef.current) return;
    wasOnlineRef.current = true;
    void refreshChats();
    const open = threadIdRef.current;
    if (open) void hydrateThread(open);
  }, [connection, refreshChats, hydrateThread]);

  // A phone spends most of its life with the screen off. Coming back to the app
  // re-opens the stream unconditionally — iOS suspends the page, and a stream
  // that survived on paper usually did not survive in fact — and re-reads what
  // is on screen, because that swap can happen without the state ever leaving
  // 'online' (which is deliberate: foregrounding must not flash a banner).
  useEffect(() => {
    const nudge = (): void => {
      if (document.visibilityState !== 'visible') return;
      transport.connection.retryNow(true);
      void refreshChats();
      const open = threadIdRef.current;
      if (open) void hydrateThread(open);
    };
    document.addEventListener('visibilitychange', nudge);
    window.addEventListener('online', nudge);
    window.addEventListener('pageshow', nudge);
    return () => {
      document.removeEventListener('visibilitychange', nudge);
      window.removeEventListener('online', nudge);
      window.removeEventListener('pageshow', nudge);
    };
  }, [transport, refreshChats, hydrateThread]);

  const openChat = useCallback(
    (id: string) => {
      // Navigating abandons any draft in flight (its turn still lands on its own
      // thread — it just must not pull the view along with it).
      draftSeqRef.current += 1;
      setComposing(false);
      setLoadNotice(null);
      threadIdRef.current = id;
      setThreadId(id);
      // Show whatever slice we already hold immediately; the disk read fills in
      // the rest a moment later.
      core.store.patch(id, (s) => ({ status: s.status === 'done' ? 'idle' : s.status }));
      void hydrateThread(id);
    },
    [core, hydrateThread]
  );

  const backToList = useCallback(() => {
    draftSeqRef.current += 1;
    openGateRef.current.invalidate();
    threadIdRef.current = null;
    setThreadId(null);
    setComposing(false);
    setLoadNotice(null);
    void refreshChats();
  }, [refreshChats]);

  const newChat = useCallback(() => {
    draftSeqRef.current += 1;
    core.pendingSends.delete(DRAFT);
    core.store.replace(DRAFT, EMPTY_STATE);
    threadIdRef.current = null;
    setThreadId(null);
    setLoadNotice(null);
    setComposing(true);
  }, [core]);

  const onSend = useCallback(
    async (text: string, attachments: TurnAttachment[]) => {
      const key = threadIdRef.current ?? DRAFT;
      const isDraft = key === DRAFT;
      // Ownership is captured before any await: a send belongs to the draft that
      // was on screen when it left, whatever the user does next.
      const sendSeq = draftSeqRef.current;
      await sendTurn(core, {
        key,
        text,
        attachments,
        // turnMeta feeds the desktop avatar's "what produced this reply" tooltip,
        // which the phone does not render — there is nothing to stamp here.
        meta: {},
        isNewChat: isDraft,
        ...(isDraft ? { draftGeneration: sendSeq, captureDraftMessages: true } : {}),
        // Continuing a thread means re-pinning its model — see ./turn.ts.
        start: async (input) =>
          window.stem.startTurn(
            await mobileStartTurnInput({
              text: input.text,
              threadId: isDraft ? null : key,
              attachments: input.attachments
            })
          ),
        onStarted: (result, { pending, alreadySettled, userMsgId }) => {
          const stampTurn = (messages: ChatMessage[]): ChatMessage[] =>
            messages.map((m) => (m.id === userMsgId ? { ...m, turnId: result.turnId ?? undefined } : m));

          if (!isDraft || !result.threadId) {
            pending.threadId = key;
            if (alreadySettled) deletePendingIfCurrent(core.pendingSends, key, pending);
            core.store.patch(key, (s) => ({
              activeTurnId: alreadySettled ? null : result.turnId ?? null,
              messages: stampTurn(s.messages)
            }));
            return;
          }

          // First turn of a new chat: the slice moves from DRAFT to its real
          // thread id, which is also the id events are routed by.
          const realId = result.threadId;
          pending.threadId = realId;
          if (!rekeyPendingIfCurrent(core.pendingSends, DRAFT, realId, pending)) {
            // A newer draft took the key while this start was pending; keep this
            // one alive under the identity it now has.
            core.pendingSends.set(realId, pending);
          }
          if (alreadySettled) deletePendingIfCurrent(core.pendingSends, realId, pending);
          const stillMine = draftSeqRef.current === sendSeq && threadIdRef.current === null;
          core.store.update((prev) => {
            const next = { ...prev };
            // The sent snapshot always moves to the real thread; only dropping
            // the DRAFT slice depends on it still being the visible one.
            const snapshot: ThreadState = { ...EMPTY_STATE, messages: pending.draftMessages ?? [] };
            const live = prev[realId];
            const merged = mergeDraftIntoReal(stillMine ? prev[DRAFT] ?? snapshot : snapshot, live);
            if (stillMine) delete next[DRAFT];
            const messages = stampTurn(merged.messages);
            next[realId] = live
              ? { ...merged, messages }
              : {
                  ...merged,
                  messages,
                  running: !alreadySettled,
                  activeTurnId: alreadySettled ? null : result.turnId ?? null,
                  status: alreadySettled ? 'idle' : 'running'
                };
            return next;
          });
          if (stillMine) {
            threadIdRef.current = realId;
            setThreadId(realId);
            setComposing(false);
          }
          // The backend won't list a thread until its first turn persists, so
          // seed the row here — otherwise the chat is invisible in the list for
          // as long as the turn runs.
          const now = Math.floor(Date.now() / 1000);
          setChats((prev) =>
            prev.some((c) => c.threadId === realId)
              ? prev
              : [
                  { threadId: realId, title: text.trim() || 'New chat', folderId: null, createdAt: now, updatedAt: now },
                  ...prev
                ]
          );
        }
      });
    },
    [core]
  );

  const onInterrupt = useCallback(async () => {
    const key = threadIdRef.current ?? DRAFT;
    await interruptActiveTurn(core, {
      pendingKey: key,
      // A draft's send may have migrated to its real thread mid-flight.
      resolveTargetKey: (pending) => pending?.threadId ?? key
    });
  }, [core]);

  const activeKey = threadId ?? DRAFT;
  const slice = states[activeKey] ?? EMPTY_STATE;
  const inThread = composing || threadId !== null;
  const title = threadId ? chats.find((c) => c.threadId === threadId)?.title ?? 'Chat' : 'New chat';

  return (
    <div className="m-shell">
      <ConnectionBanner state={connection} onRetry={transport.connection.retryNow} />
      {/* Above both screens: an approval can arrive while the chat list is open
          (a turn started here keeps running when you navigate away), and a turn
          waiting on one is stuck until it is answered. */}
      <ApprovalSheet store={approvals} />
      {inThread ? (
        <ThreadView
          key={activeKey}
          title={title}
          threadId={threadId}
          notice={loadNotice}
          messages={slice.messages}
          running={slice.running}
          streamingId={slice.streamingId}
          activity={slice.activity}
          activities={slice.activities}
          onBack={backToList}
          onSend={(text, attachments) => void onSend(text, attachments)}
          onInterrupt={() => void onInterrupt()}
        />
      ) : (
        <ChatList
          chats={chats}
          states={states}
          loading={loadingChats}
          onOpen={openChat}
          onNew={newChat}
          onRefresh={() => void refreshChats()}
        />
      )}
    </div>
  );
}

/**
 * The honest connection strip. Silent while the stream is up; otherwise it says
 * what is actually true — including that a sleeping Mac is a normal condition
 * the phone will recover from by itself.
 */
function ConnectionBanner({ state, onRetry }: { state: ConnectionState; onRetry: () => void }) {
  if (state === 'online') return null;
  if (state === 'unauthorized') {
    return (
      <div className="m-banner danger" role="status">
        <Link2Off size={15} />
        <span>This phone is no longer paired. Open Stem → Settings on your Mac and scan the code again.</span>
      </div>
    );
  }
  if (state === 'connecting') {
    return (
      <div className="m-banner" role="status">
        <RotateCw size={15} className="m-spin" />
        <span>Connecting to Stem…</span>
      </div>
    );
  }
  return (
    <div className="m-banner" role="status">
      <CloudOff size={15} />
      <span>Stem is unreachable — your Mac may be asleep. Retrying…</span>
      <button type="button" className="m-banner-btn" onClick={onRetry}>
        Try now
      </button>
    </div>
  );
}

/**
 * No token: this browser was never paired (or its storage was cleared). Say that
 * plainly instead of mounting a client that would 401 on everything — the fix is
 * on the Mac, and the user needs to be told where.
 *
 * The paste field is here for the installed-to-Home-Screen case: iOS gives a
 * standalone web app its own storage container and no address bar, so an app
 * installed from an already-paired Safari tab can land here with nothing stored
 * and no way to open a pairing URL. Pasting the link Settings copied fixes it.
 * Pairing reloads rather than mounting in place, because `window.stem` has to
 * exist before React does (see mobile/main.tsx).
 */
export function PairingNotice() {
  const [link, setLink] = useState('');
  const [rejected, setRejected] = useState(false);

  function pair() {
    if (pairFromPastedLink(link, window.localStorage)) window.location.reload();
    else setRejected(true);
  }

  return (
    <div className="m-shell m-pairing">
      <Sparkles size={28} className="m-pairing-mark" />
      <h1>Stem</h1>
      <p>This phone isn’t paired yet.</p>
      <p className="m-pairing-hint">
        On your Mac, open Stem → Settings → Mobile and scan the pairing code. The link it gives you
        carries the key for this device.
      </p>
      <form
        className="m-pairing-form"
        onSubmit={(e) => {
          e.preventDefault();
          pair();
        }}
      >
        <input
          className="m-pairing-input"
          type="text"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Pairing link"
          placeholder="…or paste the pairing link"
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            setRejected(false);
          }}
        />
        <button type="submit" disabled={!link.trim()}>
          Pair
        </button>
      </form>
      {rejected && <p className="m-pairing-error">That doesn’t look like a pairing link.</p>}
    </div>
  );
}
