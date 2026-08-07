export {
  a,
  argsProblem,
  dispatchLocal,
  hasLocalHandler,
  ipcArgSpecs,
  registerServer,
  serverChannels,
  type ArgSpec,
  type NoCallerEvent
} from './guard';
export type { IpcDeps } from './deps';
export { registerAuthIpc } from './auth';
export { registerChatsIpc } from './chats';
export { registerDevicesIpc } from './devices';
export { registerMcpIpc } from './mcp';
export { registerMemoryIpc } from './memory';
export { registerWorkspaceIpc } from './workspace';
