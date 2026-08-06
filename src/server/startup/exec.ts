import { ExecService } from '../exec/service';
import { readSettings, updateExecSettings } from '../workspace/settings';
import type { ChatBackend } from '../backend';
import type { ExecApprovalRequest } from '../../shared/types';

/**
 * Command execution: the assistant's run_command tool, routed from the backend
 * to the server's ExecService (tiered auto-approve policy + spawn) via the
 * ExecBridge wired here. Approval cards go straight to the windows through the
 * emit callbacks (the ExecService is server-owned end to end; nothing rides the
 * backend event stream).
 */
export function initExecService(deps: {
  runtime: ChatBackend;
  emitApprovalRequest: (request: ExecApprovalRequest) => void;
  emitApprovalResolved: (id: string) => void;
}): ExecService {
  const service = new ExecService({
    runtime: () => deps.runtime,
    readSettings,
    updateExecSettings,
    emitApprovalRequest: deps.emitApprovalRequest,
    emitApprovalResolved: deps.emitApprovalResolved
  });
  deps.runtime.setExecBridge(service);
  return service;
}
