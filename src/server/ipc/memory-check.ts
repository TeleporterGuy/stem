import { registerServer } from './guard';
import type { MailRouter } from '../mail/router';
import type { ChatBackend } from '../backend/types';
import type { LlmClient } from '../recall/llm';
import { memoryRunOf } from '../workspace/settings';
import {
  MEMORY_CHECK_OWNER,
  actOnMemoryCheckChange,
  memoryCheckJob,
  memoryCheckState,
  runMemoryCheck
} from '../recall/deep-check';
import type { MemoryCheckAction } from '../../shared/types';

/** The memory model, as the deep check and its replies use it. */
export function memoryCheckLlm(runtime: () => ChatBackend): LlmClient {
  return {
    complete: async (prompt) => runtime().complete(prompt, await memoryRunOf((s) => s.memory.model))
  };
}

/**
 * The Memory tab's deep check. Start returns at once (the check reads every
 * fact, minutes on a big store); the tab polls the job, and the findings
 * arrive as a mail. The FactChange cards in that mail read and act through
 * the state/act pair.
 */
export function registerMemoryCheckIpc(deps: { router(): MailRouter | null; runtime(): ChatBackend; emit(channel: string, payload: unknown): void }): void {
  registerServer('memory:checkStart', () => {
    const router = deps.router();
    if (!router) throw new Error('Mail is not ready yet — the backend is still starting.');
    if (!memoryCheckJob().running) {
      void runMemoryCheck(memoryCheckLlm(deps.runtime), (subject, body) =>
        router.deliverOwnedMail(MEMORY_CHECK_OWNER, subject, body)
      );
    }
    return memoryCheckJob();
  });
  registerServer('memory:checkJob', () => memoryCheckJob());
  registerServer('memory:checkState', (_e, checkId: string) => memoryCheckState(checkId));
  registerServer('memory:checkAct', (_e, checkId: string, changeId: string, action: MemoryCheckAction) => {
    const state = actOnMemoryCheckChange(checkId, changeId, action);
    deps.emit('memory:checkChanged', { checkId });
    return state;
  });
}
