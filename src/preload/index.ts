import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ApprovalResolvedPayload,
  ApiKeyProviderId,
  AuthProviderId,
  AuthUiEvent,
  BackendEventEnvelope,
  ConnectedFolderPatch,
  CustomInstructionsSettings,
  EscapeAction,
  ExecApprovalRequest,
  ExecDecision,
  ExecSettings,
  InstructionsProposal,
  LocalEmbedStatus,
  LocalProviderId,
  LocalProviderSettings,
  LocalRerankStatus,
  McpAdminProposal,
  McpServerInput,
  McpServerStatus,
  MemoryModelSettings,
  MemoryRebuildStatus,
  NativeWebSearchSettings,
  PartialRetrievalSettings,
  RetrievalStage,
  QuickChatAdopt,
  QuickChatFocus,
  QuickChatHandoff,
  QuickChatHandoffRequest,
  QuickChatPrompt,
  QuickChatSettings,
  QuickChatSessionStarted,
  QuickChatStatus,
  ScheduledRunPayload,
  ScheduledTask,
  SkillsModelSettings,
  StartTurnInput,
  StemApi,
  TaskNotifyPayload,
  TaskSchedulePatch
} from '../shared/types';

const api: StemApi = {
  // Sandboxed preloads still see process.platform; exotic platforms never ship.
  platform: process.platform as StemApi['platform'],
  rendererReady: () => ipcRenderer.send('renderer:ready'),
  runtimeStatus: () => ipcRenderer.invoke('runtime:status'),
  login: () => ipcRenderer.invoke('runtime:login'),
  providerLogin: (provider: AuthProviderId) => ipcRenderer.invoke('auth:providerLogin', provider),
  providerLoginRespond: (requestId: string, value: string) =>
    ipcRenderer.invoke('auth:respond', requestId, value),
  providerLoginCancel: () => ipcRenderer.invoke('auth:cancel'),
  setApiKey: (provider: ApiKeyProviderId, key: string) => ipcRenderer.invoke('auth:setApiKey', provider, key),
  updateLocalProvider: (id: LocalProviderId, patch: Partial<LocalProviderSettings>) =>
    ipcRenderer.invoke('providers:updateLocal', id, patch),
  testLocalProvider: (id: LocalProviderId, baseUrl: string) =>
    ipcRenderer.invoke('providers:testLocal', id, baseUrl),
  disconnectProvider: (providerId: string) => ipcRenderer.invoke('providers:disconnect', providerId),
  checkAuth: (provider: string) => ipcRenderer.invoke('auth:check', provider),
  completeOnboarding: () => ipcRenderer.invoke('auth:completeOnboarding'),
  onAuthEvent: (listener: (event: AuthUiEvent) => void) => {
    const handler = (_e: unknown, event: AuthUiEvent) => listener(event);
    ipcRenderer.on('auth:event', handler);
    return () => ipcRenderer.removeListener('auth:event', handler);
  },
  startTurn: (input: StartTurnInput) => ipcRenderer.invoke('backend:startTurn', input),
  interruptTurn: (turnId: string) => ipcRenderer.invoke('backend:interruptTurn', turnId),
  newConversation: () => ipcRenderer.invoke('backend:newConversation'),
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  listModels: () => ipcRenderer.invoke('backend:listModels'),
  onBackendEvent: (listener: (event: BackendEventEnvelope) => void) => {
    const handler = (_e: unknown, event: BackendEventEnvelope) => listener(event);
    ipcRenderer.on('backend:event', handler);
    return () => ipcRenderer.removeListener('backend:event', handler);
  },

  listSkills: () => ipcRenderer.invoke('skills:list'),
  setSkillEnabled: (slug: string, enabled: boolean) => ipcRenderer.invoke('skills:setEnabled', slug, enabled),
  curateSkills: () => ipcRenderer.invoke('skills:curate'),
  distillSkillsNow: () => ipcRenderer.invoke('skills:distillNow'),
  onSkillsChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('skills:changed', handler);
    return () => ipcRenderer.removeListener('skills:changed', handler);
  },

  listFiles: () => ipcRenderer.invoke('files:list'),
  addFiles: (paths: string[], subdir?: string) => ipcRenderer.invoke('files:add', paths, subdir),
  removeFile: (rel: string) => ipcRenderer.invoke('files:remove', rel),
  revealFiles: () => ipcRenderer.invoke('files:reveal'),
  previewImage: (path: string) => ipcRenderer.invoke('files:preview', path),

  listConnectedFolders: () => ipcRenderer.invoke('cfolders:list'),
  addConnectedFolders: (paths: string[]) => ipcRenderer.invoke('cfolders:add', paths),
  updateConnectedFolder: (id: string, patch: ConnectedFolderPatch) =>
    ipcRenderer.invoke('cfolders:update', id, patch),
  removeConnectedFolder: (id: string) => ipcRenderer.invoke('cfolders:remove', id),
  forgetConnectedFolderFacts: (id: string) => ipcRenderer.invoke('cfolders:forgetFacts', id),
  folderIndexStatus: () => ipcRenderer.invoke('cfolders:indexStatus'),
  revealConnectedFolder: (id: string) => ipcRenderer.invoke('cfolders:reveal', id),
  openWorkspaceFolder: () => ipcRenderer.invoke('cfolders:revealWorkspace'),
  pickDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),

  listTasks: () => ipcRenderer.invoke('tasks:list'),
  setTaskEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('tasks:setEnabled', id, enabled),
  runTaskNow: (id: string) => ipcRenderer.invoke('tasks:runNow', id),
  deleteTask: (id: string) => ipcRenderer.invoke('tasks:delete', id),
  updateTaskSchedule: (id: string, patch: TaskSchedulePatch) =>
    ipcRenderer.invoke('tasks:updateSchedule', id, patch),
  onTasksChanged: (listener: (tasks: ScheduledTask[]) => void) => {
    const handler = (_e: unknown, tasks: ScheduledTask[]) => listener(tasks);
    ipcRenderer.on('tasks:changed', handler);
    return () => ipcRenderer.removeListener('tasks:changed', handler);
  },
  onScheduledRun: (listener: (run: ScheduledRunPayload) => void) => {
    const handler = (_e: unknown, run: ScheduledRunPayload) => listener(run);
    ipcRenderer.on('tasks:run', handler);
    return () => ipcRenderer.removeListener('tasks:run', handler);
  },
  onTaskNotify: (listener: (payload: TaskNotifyPayload) => void) => {
    const handler = (_e: unknown, payload: TaskNotifyPayload) => listener(payload);
    ipcRenderer.on('tasks:notify', handler);
    return () => ipcRenderer.removeListener('tasks:notify', handler);
  },

  listMcpServers: () => ipcRenderer.invoke('mcp:list'),
  getMcpStatus: () => ipcRenderer.invoke('mcp:status'),
  addMcpServer: (input: McpServerInput) => ipcRenderer.invoke('mcp:add', input),
  removeMcpServer: (name: string) => ipcRenderer.invoke('mcp:remove', name),
  setMcpServerEnabled: (name: string, enabled: boolean) =>
    ipcRenderer.invoke('mcp:setEnabled', name, enabled),
  loginMcpServer: (name: string) => ipcRenderer.invoke('mcp:login', name),
  restartRuntime: () => ipcRenderer.invoke('runtime:restart'),
  onMcpAdminApproval: (listener: (proposal: McpAdminProposal) => void) => {
    const handler = (_e: unknown, proposal: McpAdminProposal) => listener(proposal);
    ipcRenderer.on('mcp:adminApproval', handler);
    return () => ipcRenderer.removeListener('mcp:adminApproval', handler);
  },
  onMcpAdminApprovalResolved: (listener: (payload: ApprovalResolvedPayload) => void) => {
    const handler = (_e: unknown, payload: ApprovalResolvedPayload) => listener(payload);
    ipcRenderer.on('mcp:adminApprovalResolved', handler);
    return () => ipcRenderer.removeListener('mcp:adminApprovalResolved', handler);
  },
  respondMcpAdminApproval: (id: number | string, accept: boolean) =>
    ipcRenderer.invoke('mcp:adminDecision', id, accept),
  onInstructionsApproval: (listener: (proposal: InstructionsProposal) => void) => {
    const handler = (_e: unknown, proposal: InstructionsProposal) => listener(proposal);
    ipcRenderer.on('instructions:approvalRequest', handler);
    return () => ipcRenderer.removeListener('instructions:approvalRequest', handler);
  },
  onInstructionsApprovalResolved: (listener: (payload: ApprovalResolvedPayload) => void) => {
    const handler = (_e: unknown, payload: ApprovalResolvedPayload) => listener(payload);
    ipcRenderer.on('instructions:approvalResolved', handler);
    return () => ipcRenderer.removeListener('instructions:approvalResolved', handler);
  },
  respondInstructionsApproval: (id: number | string, accept: boolean, surface: 'main' | 'quickChat', text: string) =>
    ipcRenderer.invoke('instructions:resolveApproval', id, accept, surface, text),
  updateExecSettings: (patch: Partial<ExecSettings>) => ipcRenderer.invoke('settings:updateExec', patch),
  onExecApproval: (listener: (request: ExecApprovalRequest) => void) => {
    const handler = (_e: unknown, request: ExecApprovalRequest) => listener(request);
    ipcRenderer.on('exec:approvalRequest', handler);
    return () => ipcRenderer.removeListener('exec:approvalRequest', handler);
  },
  onExecApprovalResolved: (listener: (payload: ApprovalResolvedPayload) => void) => {
    const handler = (_e: unknown, payload: ApprovalResolvedPayload) => listener(payload);
    ipcRenderer.on('exec:approvalResolved', handler);
    return () => ipcRenderer.removeListener('exec:approvalResolved', handler);
  },
  respondExecApproval: (id: string, decision: ExecDecision) =>
    ipcRenderer.invoke('exec:resolveApproval', id, decision),
  onMcpChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('mcp:changed', handler);
    return () => ipcRenderer.removeListener('mcp:changed', handler);
  },
  onMcpStatus: (listener: (status: Record<string, McpServerStatus>) => void) => {
    const handler = (_e: unknown, status: Record<string, McpServerStatus>) => listener(status);
    ipcRenderer.on('mcp:status', handler);
    return () => ipcRenderer.removeListener('mcp:status', handler);
  },

  getMemorySettings: () => ipcRenderer.invoke('memory:get'),
  setMemoryEnabled: (enabled: boolean) => ipcRenderer.invoke('memory:setEnabled', enabled),
  readMemory: () => ipcRenderer.invoke('memory:read'),
  getActiveFacts: (threadId: string | null) => ipcRenderer.invoke('memory:activeFacts', threadId),
  previewFacts: (text: string) => ipcRenderer.invoke('memory:previewFacts', text),
  addMemoryNote: (text: string) => ipcRenderer.invoke('memory:addNote', text),
  forgetMemory: (id: number) => ipcRenderer.invoke('memory:forget', id),
  setFactPinned: (id: number, pinned: boolean) => ipcRenderer.invoke('memory:setPinned', id, pinned),
  confirmFact: (id: number) => ipcRenderer.invoke('memory:confirmFact', id),
  getFactDetails: (id: number) => ipcRenderer.invoke('memory:factDetails', id),
  getMemoryConflicts: () => ipcRenderer.invoke('memory:conflicts'),
  resolveMemoryConflict: (id: number, resolution) => ipcRenderer.invoke('memory:resolveConflict', id, resolution),
  restoreSupersededFact: (id: number) => ipcRenderer.invoke('memory:restoreFact', id),
  getMemoryRebuildStatus: () => ipcRenderer.invoke('memory:rebuildStatus'),
  startMemoryRebuild: () => ipcRenderer.invoke('memory:startRebuild'),
  pauseMemoryRebuild: () => ipcRenderer.invoke('memory:pauseRebuild'),
  resumeMemoryRebuild: () => ipcRenderer.invoke('memory:resumeRebuild'),
  onMemoryRebuildStatus: (listener: (status: MemoryRebuildStatus) => void) => {
    const handler = (_e: unknown, status: MemoryRebuildStatus): void => listener(status);
    ipcRenderer.on('memory:rebuildStatus', handler);
    return () => ipcRenderer.removeListener('memory:rebuildStatus', handler);
  },
  resetFactsMemory: () => ipcRenderer.invoke('memory:resetFacts'),
  resetEpisodicMemory: () => ipcRenderer.invoke('memory:resetEpisodic'),
  consolidateMemory: () => ipcRenderer.invoke('memory:consolidate'),
  getEpisodicStats: () => ipcRenderer.invoke('memory:episodicStats'),
  getThreadSummaries: () => ipcRenderer.invoke('memory:summaries'),
  deleteThreadSummary: (id: number) => ipcRenderer.invoke('memory:deleteSummary', id),
  setEpisodicLimit: (bytes: number) => ipcRenderer.invoke('memory:setEpisodicLimit', bytes),
  setTidyThreshold: (n: number) => ipcRenderer.invoke('memory:setTidyThreshold', n),
  setMaxRelevantFacts: (n: number) => ipcRenderer.invoke('memory:setMaxRelevantFacts', n),

  listChats: () => ipcRenderer.invoke('chats:list'),
  searchChatsFast: (query: string) => ipcRenderer.invoke('chats:searchFast', query),
  searchChats: (query: string) => ipcRenderer.invoke('chats:search', query),
  openChat: (threadId: string) => ipcRenderer.invoke('chats:open', threadId),
  rollbackToTurn: (threadId: string, turnId: string) =>
    ipcRenderer.invoke('chats:rollbackToTurn', threadId, turnId),
  forkThread: (threadId: string, turnId: string) => ipcRenderer.invoke('chats:forkThread', threadId, turnId),
  renameChat: (threadId: string, name: string) => ipcRenderer.invoke('chats:rename', threadId, name),
  deleteChat: (threadId: string) => ipcRenderer.invoke('chats:delete', threadId),
  createFolder: (name: string, parentId: string | null) => ipcRenderer.invoke('folders:create', name, parentId),
  renameFolder: (folderId: string, name: string) => ipcRenderer.invoke('folders:rename', folderId, name),
  deleteFolder: (folderId: string) => ipcRenderer.invoke('folders:delete', folderId),
  moveFolder: (folderId: string, parentId: string | null) => ipcRenderer.invoke('folders:move', folderId, parentId),
  setChatFolder: (threadId: string, folderId: string | null) =>
    ipcRenderer.invoke('chats:setFolder', threadId, folderId),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateQuickChat: (patch: Partial<QuickChatSettings>) => ipcRenderer.invoke('settings:updateQuickChat', patch),
  updateNativeWebSearch: (patch: Partial<NativeWebSearchSettings>) =>
    ipcRenderer.invoke('settings:updateNativeWebSearch', patch),
  updateEscapeAction: (action: EscapeAction) => ipcRenderer.invoke('settings:updateEscapeAction', action),
  updateMemorySettings: (patch: Partial<MemoryModelSettings>) =>
    ipcRenderer.invoke('settings:updateMemory', patch),
  updateCustomInstructions: (patch: Partial<CustomInstructionsSettings>) =>
    ipcRenderer.invoke('settings:updateCustomInstructions', patch),
  updateSkillsSettings: (patch: Partial<SkillsModelSettings>) =>
    ipcRenderer.invoke('settings:updateSkills', patch),
  updateRetrievalSettings: (patch: PartialRetrievalSettings) =>
    ipcRenderer.invoke('settings:updateRetrieval', patch),
  testRetrievalEndpoint: (stage: RetrievalStage) => ipcRenderer.invoke('settings:testRetrieval', stage),
  getEmbeddingStats: () => ipcRenderer.invoke('memory:embeddingStats'),
  getLocalEmbedStatus: () => ipcRenderer.invoke('embeddings:localStatus'),
  onLocalEmbedStatus: (listener: (status: LocalEmbedStatus) => void) => {
    const handler = (_e: unknown, status: LocalEmbedStatus) => listener(status);
    ipcRenderer.on('embeddings:localStatus', handler);
    return () => ipcRenderer.removeListener('embeddings:localStatus', handler);
  },
  getLocalRerankStatus: () => ipcRenderer.invoke('reranker:localStatus'),
  onLocalRerankStatus: (listener: (status: LocalRerankStatus) => void) => {
    const handler = (_e: unknown, status: LocalRerankStatus) => listener(status);
    ipcRenderer.on('reranker:localStatus', handler);
    return () => ipcRenderer.removeListener('reranker:localStatus', handler);
  },
  runQuickChat: (prompt: QuickChatPrompt) => ipcRenderer.invoke('quickchat:run', prompt),
  newQuickChatThread: () => ipcRenderer.invoke('quickchat:newThread'),
  handoffQuickChat: (payload: QuickChatHandoff) => ipcRenderer.invoke('quickchat:handoff', payload),
  onQuickChatHandoffRequest: (listener: (request: QuickChatHandoffRequest) => void) => {
    const handler = (_e: unknown, request: QuickChatHandoffRequest) => listener(request);
    ipcRenderer.on('quickchat:handoffRequest', handler);
    return () => ipcRenderer.removeListener('quickchat:handoffRequest', handler);
  },
  respondQuickChatHandoffRequest: (id: string, payload: QuickChatHandoff) =>
    ipcRenderer.send('quickchat:handoffSnapshot', id, payload),
  revealQuickChat: () => ipcRenderer.invoke('quickchat:reveal'),
  revealMain: () => ipcRenderer.invoke('main:reveal'),
  hideQuickChat: () => ipcRenderer.invoke('quickchat:hide'),
  onQuickChatFocus: (listener: (focus: QuickChatFocus) => void) => {
    const handler = (_e: unknown, focus: QuickChatFocus) => listener(focus);
    ipcRenderer.on('quickchat:focus', handler);
    return () => ipcRenderer.removeListener('quickchat:focus', handler);
  },
  onQuickChatStatus: (listener: (status: QuickChatStatus) => void) => {
    const handler = (_e: unknown, status: QuickChatStatus) => listener(status);
    ipcRenderer.on('quickchat:status', handler);
    return () => ipcRenderer.removeListener('quickchat:status', handler);
  },
  onQuickChatAdopt: (listener: (payload: QuickChatAdopt) => void) => {
    const handler = (_e: unknown, payload: QuickChatAdopt) => listener(payload);
    ipcRenderer.on('quickchat:adopt', handler);
    return () => ipcRenderer.removeListener('quickchat:adopt', handler);
  },
  onQuickChatSessionStarted: (listener: (payload: QuickChatSessionStarted) => void) => {
    const handler = (_e: unknown, payload: QuickChatSessionStarted) => listener(payload);
    ipcRenderer.on('quickchat:sessionStarted', handler);
    return () => ipcRenderer.removeListener('quickchat:sessionStarted', handler);
  },
  onHudPlayChime: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('hud:playChime', handler);
    return () => ipcRenderer.removeListener('hud:playChime', handler);
  }
};

contextBridge.exposeInMainWorld('stem', api);
