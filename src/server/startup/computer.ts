import { closeComputerDeviceRouter, computerDeviceRouter } from '../computer-device/router';
import type { ChatBackend, ComputerBridge } from '../backend/types';

/**
 * Computer control: the assistant's `computer` tool, routed from the backend
 * to the computer-device router (one screen action out to the persona's
 * pinned Mac, one screenshot back). The bridge is thin on purpose: every
 * decision that matters — which Mac (the persona pin, read off the live turn
 * in pi/runtime.ts), whether that Mac lets Stem drive it at all (its own
 * switch), and when a run ends (the person's own input) — is made elsewhere.
 */
export function initComputerControl(deps: { runtime: ChatBackend }): ComputerBridge {
  const bridge: ComputerBridge = {
    handleComputerRequest: (req) => computerDeviceRouter().send(req.threadId, req.device, req.action),
    endThread: (threadId, reason) => computerDeviceRouter().endThread(threadId, reason),
    settleAll: () => closeComputerDeviceRouter()
  };
  deps.runtime.setComputerBridge(bridge);
  return bridge;
}
