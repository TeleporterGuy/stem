import { registerServer } from './guard';
import type { IpcDeps } from './deps';
import { addPin, listPins, removePin, reorderPins, updatePin } from '../pins/store';
import type { ChatMessage, ChatPin, ChatPinInput, ChatPinPatch } from '../../shared/types';

/**
 * The chat pinboards (server/pins/store.ts). Every mutator answers with the
 * chat's fresh board, the contract the folder mutators use, and pushes
 * `pins:changed` so another window or device looking at the same chat refetches.
 */
export function registerPinsIpc(deps: IpcDeps): void {
  const changed = (threadId: string): ChatPin[] => {
    deps.emit('pins:changed', { threadId });
    return listPins(threadId);
  };

  registerServer('pins:list', (_e, threadId: string) => listPins(threadId));
  registerServer('pins:add', (_e, threadId: string, input: ChatPinInput) => {
    addPin(threadId, input);
    return changed(threadId);
  });
  registerServer('pins:update', (_e, threadId: string, pinId: string, patch: ChatPinPatch) => {
    updatePin(threadId, pinId, patch);
    return changed(threadId);
  });
  registerServer('pins:remove', (_e, threadId: string, pinId: string) => {
    removePin(threadId, pinId);
    return changed(threadId);
  });
  registerServer('pins:reorder', (_e, threadId: string, pinIds: string[]) => {
    reorderPins(threadId, pinIds);
    return changed(threadId);
  });
}

/**
 * The turn anchors a fork ending at `turnId` keeps: every turn id (both the
 * persisted `turnId` and the runtime one) of the messages up to and including
 * that turn. Read from the ORIGINAL thread: a fork's own file is written lazily,
 * and the fork is by definition the original's prefix.
 */
export function forkAnchors(messages: ChatMessage[], turnId: string): Set<string> {
  const last = messages.map((m) => m.turnId === turnId || m.runtimeTurnId === turnId).lastIndexOf(true);
  const anchors = new Set<string>();
  if (last === -1) return anchors;
  for (const m of messages.slice(0, last + 1)) {
    if (m.turnId) anchors.add(m.turnId);
    if (m.runtimeTurnId) anchors.add(m.runtimeTurnId);
  }
  return anchors;
}
