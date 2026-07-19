import { handleIpc } from './guard';
import type { IpcDeps } from './deps';
import * as piMcp from '../pi/mcp';
import { updateCustomInstructions } from '../workspace/settings';
import type { McpServerInput } from '../../shared/types';

/** MCP server management + the assistant's held approval round-trips. */
export function registerMcpIpc(deps: IpcDeps): void {
  handleIpc('mcp:list', () => piMcp.listMcpServers());
  handleIpc('mcp:status', () => deps.runtime().getMcpStatus());
  handleIpc('mcp:add', (_e, input: McpServerInput) => piMcp.addMcpServer(input));
  handleIpc('mcp:remove', (_e, name: string) => piMcp.removeMcpServer(name));
  handleIpc('mcp:setEnabled', (_e, name: string, enabled: boolean) =>
    piMcp.setMcpServerEnabled(name, enabled)
  );
  handleIpc('mcp:login', (_e, name: string) => deps.runtime().mcpLogin(name));
  handleIpc('mcp:adminDecision', async (_e, id: number | string, accept: boolean) => {
    await deps.runtime().resolveAdminApproval(
      id,
      accept,
      accept
        ? async (proposal) => {
            if (proposal.action === 'add') {
              if (!proposal.input) throw new Error('The MCP add proposal is missing its server definition.');
              await piMcp.addMcpServer(proposal.input);
              return;
            }
            if (!proposal.name) throw new Error('The MCP remove proposal is missing its server name.');
            await piMcp.removeMcpServer(proposal.name);
          }
        : undefined
    );
  });
  handleIpc(
    'instructions:resolveApproval',
    async (_e, id: number | string, accept: boolean, surface: 'main' | 'quickChat', text: string) => {
      // Main is the sole writer of settings.json: apply the card's final text BEFORE
      // releasing the held tool call, so the assistant only proceeds once it's persisted.
      await deps.runtime().resolveInstructionsApproval(
        id,
        accept,
        accept
          ? async () => {
              await updateCustomInstructions({ [surface]: text });
            }
          : undefined
      );
    }
  );
}
