import { registerServer } from './guard';
import type { IpcDeps } from './deps';
import { searchChats, searchChatsLexical } from '../chatsearch/search';
import { reindexChatThread, dropChatThread } from '../chatsearch/index-sync';
import {
  createFolder,
  deleteFolder,
  getAssignments,
  listFolders,
  moveFolder,
  removeChat,
  renameFolder,
  setChatFolder
} from '../workspace/chats';
import { readSettings } from '../workspace/settings';
import type { LlmClient } from '../recall/llm';
import type { ChatListResult } from '../../shared/types';

/**
 * Chats + chat folders. Chats come from the backend's thread store;
 * folders/assignments from the Stem store. Merged here so the runtime stays
 * backend-only and the store stays backend-unaware. (`chats:open` stays in
 * index.ts — it has to let the client complete a Quick Chat hand-off before the
 * read, which is a composition-root concern.)
 */
/**
 * Ceiling on the query-expansion completion behind chats:search. The user is
 * waiting on a search box, so a slow (or wedged) memory model must degrade to
 * the same-language results chats:searchFast already painted rather than hold
 * the cross-language superset back indefinitely.
 */
const CHAT_SEARCH_COMPLETION_TIMEOUT_MS = 4_000;

export function registerChatsIpc(deps: IpcDeps): void {
  const chatList = async (): Promise<ChatListResult> => {
    const [chats, folders, assignments] = await Promise.all([
      deps.runtime().listThreads(),
      listFolders(),
      getAssignments()
    ]);
    const valid = new Set(folders.map((f) => f.id));
    for (const chat of chats) {
      const folderId = assignments[chat.threadId];
      chat.folderId = folderId && valid.has(folderId) ? folderId : null;
    }
    return { chats, folders };
  };

  registerServer('chats:list', () => chatList());
  // Cross-language chat search: expand the query across Slovak+English (via the same
  // hidden LlmClient seam as recall), then match the dedicated FTS5 chat index. The
  // LLM is used regardless of the memory toggle — this is a foreground, user-initiated
  // search, not background capture — and degrades to same-language search if it fails.
  // Instant same-language results (no LLM) — the renderer shows these first, then swaps
  // in the cross-language superset from chats:search when expansion resolves.
  registerServer('chats:searchFast', (_e, query: string) =>
    searchChatsLexical(query, { llm: null, listChats: () => deps.runtime().listThreads() })
  );
  registerServer('chats:search', (_e, query: string) => {
    // Reuse the hidden one-shot seam (on the memory model) for query expansion.
    const llm: LlmClient = {
      complete: async (prompt) =>
        deps.runtime().complete(prompt, {
          model: (await readSettings()).memory.model,
          timeoutMs: CHAT_SEARCH_COMPLETION_TIMEOUT_MS
        })
    };
    return searchChats(query, { llm, listChats: () => deps.runtime().listThreads() });
  });
  registerServer('chats:rollbackToTurn', (_e, threadId: string, turnId: string) =>
    deps.runtime().rollbackToTurn(threadId, turnId)
  );
  registerServer('chats:forkThread', (_e, threadId: string, turnId: string) =>
    deps.runtime().forkThread(threadId, turnId)
  );
  registerServer('chats:rename', async (_e, threadId: string, name: string) => {
    await deps.runtime().renameThread(threadId, name);
    // The title is indexed for search too — reflect the new name right away.
    void reindexChatThread(deps.runtime(), threadId);
  });
  registerServer('chats:delete', async (_e, threadId: string) => {
    // Independent stores (pi session file vs. folder-assignment JSON) — run concurrently.
    // Also drop any scheduled tasks bound to this chat (they'd otherwise run into a
    // missing thread; the scheduler guards against that too, but cleaning up is tidier).
    await Promise.all([
      deps.runtime().deleteThread(threadId),
      removeChat(threadId),
      deps.scheduler()?.removeForThread(threadId) ?? Promise.resolve()
    ]);
    dropChatThread(threadId); // forget it from the search index
  });
  registerServer('chats:setFolder', async (_e, threadId: string, folderId: string | null) => {
    await setChatFolder(threadId, folderId);
    return chatList();
  });

  registerServer('folders:create', async (_e, name: string, parentId: string | null) => {
    await createFolder(name, parentId);
    return chatList();
  });
  registerServer('folders:rename', async (_e, folderId: string, name: string) => {
    await renameFolder(folderId, name);
    return chatList();
  });
  registerServer('folders:delete', async (_e, folderId: string) => {
    await deleteFolder(folderId);
    return chatList();
  });
  registerServer('folders:move', async (_e, folderId: string, parentId: string | null) => {
    await moveFolder(folderId, parentId);
    return chatList();
  });
}
