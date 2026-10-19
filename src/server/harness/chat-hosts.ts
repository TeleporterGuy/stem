import { createAgentRegistry } from 'acpx/runtime';
import { harnessDeviceRouter } from './device-host';
import { browserDeviceRouter } from '../browser-device/router';
import { computerDeviceRouter } from '../computer-device/router';
import { connectedDeviceIds } from '../startup/transport';
import { readDevices } from '../transport/auth';
import { readSettings } from '../workspace/settings';

// What a model-chooses chat (Settings → Features → "Let the model choose") is
// told it can pick from: the coding agents Stem knows, and the paired computers
// whose owner switched the feature on, each marked when it is not connected.
// Asked fresh each turn — only this moment knows which machines are awake —
// and again inside a refusal, so a wrong pick comes back with the real options.

/** acpx's registry plus the user's custom entries. Names only: an agent may still be missing on a machine. */
export async function codingAgentNames(): Promise<string[]> {
  const overrides = Object.fromEntries(
    Object.entries((await readSettings()).harness.agents).flatMap(([name, a]) => (a.command ? [[name, a.command]] : []))
  );
  return createAgentRegistry({ overrides }).list().sort();
}

const SYSTEMS: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

/**
 * Each enabled computer as the model reads it: its name, its system, and
 * which one the user is typing on. A name alone misleads — a Linux box called
 * "win" read as the Windows machine, and the model refused to use it.
 */
function listed(origin?: string) {
  return async (hosts: Record<string, { deviceId: string; enabled: boolean; platform?: string }>): Promise<string[]> => {
    // quiet: loadDevices() already rebuilds an unreadable registry empty and
    // degrades under transport.devices; an empty list here just names no computer.
    const devices = await readDevices().catch(() => []);
    const labels = new Map(devices.map((d) => [d.id, d.label]));
    const connected = connectedDeviceIds();
    return Object.values(hosts)
      .filter((h) => h.enabled && labels.has(h.deviceId))
      .map((h) => {
        const notes = [
          h.platform && SYSTEMS[h.platform],
          h.deviceId === origin ? 'the computer the user is writing from' : null,
          connected.has(h.deviceId) ? null : 'NOT connected right now'
        ].filter(Boolean);
        return `“${labels.get(h.deviceId)}”${notes.length ? ` (${notes.join(', ')})` : ''}`;
      });
  };
}

/** The per-turn block for a chat whose coding agent the model names. */
export async function codingChoicesText(origin?: string): Promise<string> {
  // quiet: a list that cannot be read is left out; the model asks the user instead, and a wrong pick is refused with the reason.
  const agents = await codingAgentNames().catch(() => [] as string[]);
  // quiet: same — no computers named means the model asks rather than guesses.
  const computers = await harnessDeviceRouter().hosts().then(listed(origin)).catch(() => [] as string[]);
  return (
    'coding_agent in this chat: you name the agent and the computer. ' +
    (agents.length ? `Agents: ${agents.join(', ')} (one may not be installed on every computer). ` : '') +
    `Computers: Stem's server (leave \`device\` out)${computers.length ? `, ${computers.join(', ')}` : ''}. ` +
    'Use what the user asked for; when they named neither, ask rather than guess. A computer marked NOT ' +
    'connected cannot run anything until it is awake with Stem running — say so instead of trying it.'
  );
}

/** The per-turn block for a chat whose computer-control Mac the model names. */
export async function computerChoicesText(origin?: string): Promise<string> {
  // quiet: an unreadable host store reads as "no Mac lets Stem control it", which is what the model then says.
  const macs = await computerDeviceRouter().hosts().then(listed(origin)).catch(() => [] as string[]);
  return macs.length
    ? `The computer tool in this chat: name the computer in \`device\`. Computers that let Stem control them: ${macs.join(', ')}. ` +
        'A computer marked NOT connected cannot be driven until it is awake with Stem running — say so instead of trying it.'
    : 'The computer tool in this chat: no computer lets Stem control it right now (each one switches it on under ' +
        'Settings → Features → Computer control, on that computer). Tell the user that instead of trying.';
}

/** The per-turn block for a chat whose browser Mac the model names. */
export async function browserChoicesText(origin?: string): Promise<string> {
  // quiet: same as computerChoicesText — an unreadable store names no Mac, and the model says so.
  const macs = await browserDeviceRouter().hosts().then(listed(origin)).catch(() => [] as string[]);
  return macs.length
    ? `The browser tool in this chat: name the computer in \`device\`. Computers that let Stem drive their browser: ${macs.join(', ')}. ` +
        'A computer marked NOT connected cannot be driven until it is awake with Stem running — say so instead of trying it.'
    : 'The browser tool in this chat: no computer lets Stem drive its browser right now (each one switches it on under ' +
        'Settings → Features → Browser control, on that computer). Tell the user that instead of trying.';
}
