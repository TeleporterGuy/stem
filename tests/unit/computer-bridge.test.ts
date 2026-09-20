// The `computer` tool, both halves and the seam between them:
//
//  - the extension side: the tool registers, refuses without the gate, maps
//    Anthropic-shaped calls to helper actions, raises exactly one sentinel
//    elicitation, and renders the answer as text + an image block;
//  - the runtime side (PiRuntime.handleComputerBridgeRequest): the Mac comes
//    from the persona's computer pin on the live turn, never from the payload,
//    and an unpinned turn is refused before the bridge.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPUTER_BRIDGE_TITLE } from '../../src/server/pi/protocol';
import { PiRuntime } from '../../src/server/pi/runtime';
import { newTurnContext } from '../../src/server/pi/normalize';
import type { ComputerBridge, ComputerRequest } from '../../src/server/backend/types';

const configDir = mkdtempSync(join(tmpdir(), 'stem-computer-bridge-'));
writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ servers: {} }));
process.env.STEM_MCP_CONFIG = join(configDir, 'mcp.json');

const { default: stemMcpBridge, computerActionFrom } =
  await import('../../src/server/pi/stem-mcp-extension.mjs');

interface RegisteredTool {
  name: string;
  description: string;
  parameters: { properties: { action: { enum: string[] } } };
  execute?: (
    id: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown
  ) => Promise<{
    content: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    isError?: boolean;
  }>;
}

async function registeredComputer(): Promise<RegisteredTool> {
  const registered: RegisteredTool[] = [];
  const fakePi = {
    registerTool: (tool: RegisteredTool) => registered.push(tool),
    on: () => {},
    getActiveTools: () => [] as string[],
    setActiveTools: () => {}
  };
  await stemMcpBridge(fakePi);
  const tool = registered.find((t) => t.name === 'computer');
  expect(tool).toBeTruthy();
  return tool!;
}

function scriptedCtx(answer: (title: string, payload: string) => unknown) {
  const asks: Array<{ title: string; payload: string }> = [];
  return {
    asks,
    ctx: {
      ui: {
        input: async (title: string, payload: string) => {
          asks.push({ title, payload });
          return answer(title, payload);
        }
      }
    }
  };
}

const gatePath = join(configDir, 'turn-context.json');
function gate(computer: boolean): void {
  writeFileSync(gatePath, JSON.stringify({ mail: false, scheduled: false, computer }));
}

describe('computerActionFrom', () => {
  it('maps the Anthropic shape to helper actions', () => {
    expect(computerActionFrom({ action: 'screenshot' })).toEqual({
      ok: true,
      action: { kind: 'screenshot' }
    });
    expect(computerActionFrom({ action: 'left_click', coordinate: [10.4, 20] })).toEqual({
      ok: true,
      action: { kind: 'click', x: 10, y: 20, button: 'left', count: 1 }
    });
    expect(computerActionFrom({ action: 'double_click' })).toEqual({
      ok: true,
      action: { kind: 'click', button: 'left', count: 2 }
    });
    expect(computerActionFrom({ action: 'right_click', coordinate: [1, 1] })).toMatchObject({
      action: { button: 'right' }
    });
    expect(
      computerActionFrom({
        action: 'left_click_drag',
        start_coordinate: [1, 2],
        coordinate: [3, 4]
      })
    ).toEqual({
      ok: true,
      action: { kind: 'drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }
    });
    expect(
      computerActionFrom({
        action: 'scroll',
        coordinate: [5, 5],
        scroll_direction: 'up',
        scroll_amount: 99
      })
    ).toEqual({
      ok: true,
      action: { kind: 'scroll', x: 5, y: 5, dir: 'up', amount: 50 }
    });
    expect(computerActionFrom({ action: 'key', text: ' cmd+shift+t ' })).toEqual({
      ok: true,
      action: { kind: 'key', combo: 'cmd+shift+t' }
    });
    expect(computerActionFrom({ action: 'hold_key', text: 'shift', duration: 99 })).toEqual({
      ok: true,
      action: { kind: 'hold', combo: 'shift', ms: 5000 }
    });
    expect(computerActionFrom({ action: 'wait', duration: 2 })).toEqual({
      ok: true,
      action: { kind: 'wait', ms: 2000 }
    });
    expect(computerActionFrom({ action: 'zoom', region: [1, 2, 30, 40] })).toEqual({
      ok: true,
      action: { kind: 'zoom', x: 1, y: 2, w: 30, h: 40 }
    });
  });

  it('maps the window-mode actions, and refuses them without their ids', () => {
    expect(computerActionFrom({ action: 'list_windows' })).toEqual({ ok: true, action: { kind: 'list_windows' } });
    expect(computerActionFrom({ action: 'select_window', window_id: 42 })).toEqual({
      ok: true,
      action: { kind: 'select_window', windowId: 42 }
    });
    expect(computerActionFrom({ action: 'select_window', app: ' Discord ', title: '#test' })).toEqual({
      ok: true,
      action: { kind: 'select_window', app: 'Discord', title: '#test' }
    });
    // No arguments = back to the whole screen.
    expect(computerActionFrom({ action: 'select_window' })).toEqual({ ok: true, action: { kind: 'select_window' } });
    expect(computerActionFrom({ action: 'snapshot', depth: 99 })).toEqual({
      ok: true,
      action: { kind: 'snapshot', depth: 30 }
    });
    expect(computerActionFrom({ action: 'press', element_id: 7 })).toEqual({ ok: true, action: { kind: 'press', id: 7 } });
    expect(computerActionFrom({ action: 'focus', element_id: 0 })).toEqual({ ok: true, action: { kind: 'focus', id: 0 } });
    expect(computerActionFrom({ action: 'menu', element_id: 3 })).toEqual({ ok: true, action: { kind: 'menu', id: 3 } });
    expect(computerActionFrom({ action: 'set_value', element_id: 3, text: '' })).toEqual({
      ok: true,
      action: { kind: 'set_value', id: 3, text: '' }
    });
    expect(computerActionFrom({ action: 'press' }).ok).toBe(false);
    expect(computerActionFrom({ action: 'press', element_id: 1.5 }).ok).toBe(false);
    expect(computerActionFrom({ action: 'set_value', element_id: 1 }).ok).toBe(false);
  });

  it('refuses what the helper could not do', () => {
    expect(computerActionFrom({ action: 'teleport' }).ok).toBe(false);
    expect(computerActionFrom({ action: 'mouse_move' }).ok).toBe(false);
    expect(computerActionFrom({ action: 'left_click', coordinate: [-1, 5] }).ok).toBe(false);
    expect(computerActionFrom({ action: 'left_click', coordinate: [1] }).ok).toBe(false);
    expect(computerActionFrom({ action: 'type' }).ok).toBe(false);
    expect(computerActionFrom({ action: 'scroll', scroll_direction: 'sideways' }).ok).toBe(false);
    expect(computerActionFrom({ action: 'zoom', region: [1, 2] }).ok).toBe(false);
  });
});

describe('extension side', () => {
  it('lists every action, raises one sentinel elicitation, and returns text + the image block', async () => {
    gate(true);
    try {
      const tool = await registeredComputer();
      expect(tool.parameters.properties.action.enum).toContain('left_click_drag');
      expect(tool.description).toContain('PIXELS OF THE LAST SCREENSHOT');
      const { asks, ctx } = scriptedCtx(() =>
        JSON.stringify({
          ok: true,
          screenshot: { jpegBase64: 'QUJD', width: 640, height: 400 },
          cursor: { x: 7, y: 8 }
        })
      );
      const result = await tool.execute!(
        'c1',
        { action: 'left_click', coordinate: [7, 8] },
        undefined,
        undefined,
        ctx
      );
      expect(asks).toHaveLength(1);
      expect(asks[0]!.title).toBe(COMPUTER_BRIDGE_TITLE);
      expect(JSON.parse(asks[0]!.payload)).toEqual({
        action: { kind: 'click', x: 7, y: 8, button: 'left', count: 1 }
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Screen 640×400 px. Cursor at (7, 8).'
      });
      expect(result.content[1]).toEqual({
        type: 'image',
        data: 'QUJD',
        mimeType: 'image/jpeg'
      });
    } finally {
      rmSync(gatePath, { force: true });
    }
  });

  it('a zoom answer is labelled as not clickable, and a refusal is an error', async () => {
    gate(true);
    try {
      const tool = await registeredComputer();
      const zoom = scriptedCtx(() =>
        JSON.stringify({
          ok: true,
          screenshot: {
            jpegBase64: 'QUJD',
            width: 1568,
            height: 800,
            zoomed: true
          },
          cursor: {}
        })
      );
      const z = await tool.execute!(
        'c',
        { action: 'zoom', region: [0, 0, 10, 10] },
        undefined,
        undefined,
        zoom.ctx
      );
      expect(z.content[0]!.text).toContain('not clickable');
      const refused = scriptedCtx(() =>
        JSON.stringify({
          ok: false,
          error: 'The user took over the computer.'
        })
      );
      const r = await tool.execute!('c', { action: 'screenshot' }, undefined, undefined, refused.ctx);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain('took over');
    } finally {
      rmSync(gatePath, { force: true });
    }
  });

  it('renders a windows list without an image, and a window frame with its target line', async () => {
    gate(true);
    try {
      const tool = await registeredComputer();
      const list = scriptedCtx(() => JSON.stringify({ ok: true, text: '12  Discord  "#test"  otherSpace' }));
      const l = await tool.execute!('c', { action: 'list_windows' }, undefined, undefined, list.ctx);
      expect(l.isError).toBeFalsy();
      expect(l.content).toHaveLength(1);
      expect(l.content[0]!.text).toContain('Discord');
      const win = scriptedCtx(() =>
        JSON.stringify({
          ok: true,
          screenshot: { jpegBase64: 'QUJD', width: 800, height: 600 },
          text: '1  textarea "Message #test" focused',
          target: { app: 'Discord', title: '#test', windowId: 12 }
        })
      );
      const w = await tool.execute!('c', { action: 'snapshot' }, undefined, undefined, win.ctx);
      expect(w.content[0]!.text).toContain('Window "#test" (Discord), 800×600 px');
      expect(w.content[0]!.text).toContain('textarea "Message #test"');
      expect(w.content[1]).toMatchObject({ type: 'image', data: 'QUJD' });
      const back = scriptedCtx(() =>
        JSON.stringify({ ok: true, screenshot: { jpegBase64: 'QUJD', width: 8, height: 6 }, cursor: { x: 1, y: 1 }, target: null })
      );
      const b = await tool.execute!('c', { action: 'select_window' }, undefined, undefined, back.ctx);
      expect(b.content[0]!.text).toContain('Screen 8×6 px');
    } finally {
      rmSync(gatePath, { force: true });
    }
  });

  it('refuses up front when the gate says no computer pin — and when the gate is absent', async () => {
    gate(false);
    try {
      const tool = await registeredComputer();
      const { asks, ctx } = scriptedCtx(() => JSON.stringify({ ok: true }));
      const result = await tool.execute!('c', { action: 'screenshot' }, undefined, undefined, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('pinned to a computer');
      expect(asks).toHaveLength(0);
      // An older main that never wrote the field: the tool stays shut (unlike coding).
      writeFileSync(gatePath, JSON.stringify({ mail: true }));
      const absent = await tool.execute!('c', { action: 'screenshot' }, undefined, undefined, ctx);
      expect(absent.isError).toBe(true);
      expect(asks).toHaveLength(0);
    } finally {
      rmSync(gatePath, { force: true });
    }
  });
});

describe('runtime side', () => {
  function runtimeWithBridge(bridge: ComputerBridge | null) {
    const runtime = new PiRuntime({
      piHome: '/tmp/unused',
      sessionsDir: '/tmp/unused',
      workspaceRoot: '/tmp/unused',
      seedGlobalAuth: false
    });
    const sent: Array<{ id: string; value: string }> = [];
    const worker = (runtime as unknown as { primaryWorker(): unknown }).primaryWorker() as {
      proc: { send: (m: { id: string; value: string }) => void } | null;
      currentTurn: ReturnType<typeof newTurnContext> | null;
    };
    const internal = runtime as unknown as {
      handleComputerBridgeRequest: (worker: unknown, id: string, payload: string | undefined) => void;
    };
    worker.proc = { send: (m) => sent.push(m) };
    runtime.setComputerBridge(bridge);
    return { internal, worker, sent };
  }

  async function settleSends(sent: unknown[]): Promise<void> {
    for (let i = 0; i < 20 && sent.length === 0; i++) await Promise.resolve();
  }

  it('takes the Mac from the persona pin and the thread from the live turn, never from the payload', async () => {
    const seen: ComputerRequest[] = [];
    const { internal, worker, sent } = runtimeWithBridge({
      handleComputerRequest: async (req) => {
        seen.push(req);
        return {
          ok: true,
          screenshot: { jpegBase64: 'QUJD', width: 1, height: 1 },
          cursor: { x: 0, y: 0 }
        };
      },
      endThread: () => {},
      settleAll: () => {}
    });
    worker.currentTurn = newTurnContext('the-real-thread', 'turn-1');
    worker.currentTurn.isScheduled = true;
    worker.currentTurn.personaComputer = { device: 'mac-1' };
    internal.handleComputerBridgeRequest(
      worker,
      'elicit-1',
      JSON.stringify({
        action: { kind: 'screenshot' },
        device: 'mac-forged',
        threadId: 'forged'
      })
    );
    await settleSends(sent);
    expect(seen[0]).toEqual({
      device: 'mac-1',
      threadId: 'the-real-thread',
      action: { kind: 'screenshot' }
    });
    expect(JSON.parse(sent[0]!.value)).toMatchObject({ ok: true });
    expect(sent[0]!.id).toBe('elicit-1');
  });

  it('refuses a turn with no computer pin before the bridge, in any turn kind', async () => {
    const seen: ComputerRequest[] = [];
    const { internal, worker, sent } = runtimeWithBridge({
      handleComputerRequest: async (req) => {
        seen.push(req);
        return { ok: false, error: 'never' };
      },
      endThread: () => {},
      settleAll: () => {}
    });
    worker.currentTurn = newTurnContext('t', 'turn-1');
    worker.currentTurn.personaHarness = {
      agent: 'claude',
      cwd: '/repo',
      device: 'mac-1'
    }; // a code pin is not a computer pin
    internal.handleComputerBridgeRequest(
      worker,
      'elicit-1',
      JSON.stringify({ action: { kind: 'screenshot' } })
    );
    await settleSends(sent);
    expect(seen).toHaveLength(0);
    expect(JSON.parse(sent[0]!.value)).toMatchObject({
      ok: false,
      error: expect.stringContaining('pinned to a computer')
    });
    sent.length = 0;
    worker.currentTurn.isMail = true;
    worker.currentTurn.personaComputer = { device: '  ' };
    internal.handleComputerBridgeRequest(
      worker,
      'elicit-2',
      JSON.stringify({ action: { kind: 'screenshot' } })
    );
    await settleSends(sent);
    expect(seen).toHaveLength(0);
    expect(JSON.parse(sent[0]!.value)).toMatchObject({ ok: false });
  });
});
