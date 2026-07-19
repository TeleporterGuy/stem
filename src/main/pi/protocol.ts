import type { PiEvent } from './rpc';

// The Stem ⇄ pi side-protocol, in one place.
//
// pi's RPC stream is only half the coupling. The other half is a set of
// conventions shared with the bridge extension (stem-mcp-extension.mjs, which
// runs INSIDE the pi process and cannot import this module):
//
//  - sentinel titles on `extension_ui_request` dialogs the bridge raises so
//    PiRuntime can route them to Stem UI instead of showing a pi dialog;
//  - a JSON payload key on `notify` messages carrying the web-search tee;
//  - mtime-polled JSON gate files under the pi home that main rewrites and the
//    bridge re-reads per turn;
//  - env vars telling the bridge where Stem's config lives.
//
// Every constant here has a hand-written twin in the extension. The drift guard
// in tests/unit/pi-protocol.test.ts parses the extension source and fails if
// either side changes alone — update both together.

/**
 * The exact pi version this protocol was last verified against. package.json
 * pins the dependency to this version, PiRuntime warns at spawn when the
 * resolved pi differs (a system/override pi), and the drift-guard test fails if
 * the pin and this constant fall out of sync. pi's own version check is
 * disabled in the child (PI_SKIP_VERSION_CHECK=1), so this is the only guard:
 * raw-event shapes, hook timing, and extension APIs are all unversioned and
 * have broken on pi minor bumps before.
 */
export const TESTED_PI_VERSION = '0.80.6';

// ---- extension_ui_request sentinel titles ----

/** MCP add/remove approval (`confirm`); the message is a JSON McpAdminProposal. */
export const ADMIN_APPROVAL_TITLE = 'stem-admin-approval';

/**
 * Custom-instructions change approval (`confirm`); the message is a JSON
 * { action, incomingText, surface? } payload.
 */
export const INSTRUCTIONS_APPROVAL_TITLE = 'stem-instructions-approval';

/**
 * Scheduled-task tool round-trip (`input`): schedule_task / notify_user /
 * list_tasks / cancel_task. The op payload rides in `placeholder`; PiRuntime
 * answers with a JSON result string.
 */
export const TASK_BRIDGE_TITLE = 'stem-task-bridge';

// ---- web-search tee (`notify` messages) ----

/** JSON key wrapping a tee payload inside a bridge `notify` message. */
export const WEB_SEARCH_TEE_KEY = 'stemWebSearch';

/**
 * A native web-search event recovered by the bridge's provider-stream tee
 * (native search runs server-side, so pi itself emits nothing for it).
 * `phase: 'started' | 'completed'` frames one search; `phase: 'source'` carries
 * one cited URL.
 */
export interface WebSearchTeePayload {
  phase?: string;
  id?: string;
  query?: string;
  status?: string;
  url?: string;
  title?: string;
}

/** Extract the tee payload from a bridge `notify` message, or null if it isn't one. */
export function parseWebSearchTee(message: string): WebSearchTeePayload | null {
  try {
    const payload = (JSON.parse(message) as Record<string, unknown>)[WEB_SEARCH_TEE_KEY];
    return payload && typeof payload === 'object' ? (payload as WebSearchTeePayload) : null;
  } catch {
    return null;
  }
}

// ---- gate files (basenames under the pi home, mtime-polled by the bridge) ----

/** `{ enabled: boolean }` — inject the model's native web_search tool this turn? */
export const NATIVE_SEARCH_GATE_FILE = 'native-search.json';
/** `{ tier: string | null }` — OpenAI service_tier for the next request. */
export const SERVICE_TIER_GATE_FILE = 'service-tier.json';
/** `{ roots: string[] }` — absolute roots of read-only connected folders. */
export const PROTECTED_ROOTS_FILE = 'protected-roots.json';
/** OAuth tokens for remote MCP servers, keyed by server name. */
export const MCP_OAUTH_FILE = 'mcp-oauth.json';
/** Touched by the bridge on any skill write so main reloads at turn end. */
export const SKILLS_REV_FILE = '.skills-rev';

// ---- env vars the bridge reads at load ----

export const ENV_MCP_CONFIG = 'STEM_MCP_CONFIG';
export const ENV_MCP_OAUTH = 'STEM_PI_MCP_OAUTH';
export const ENV_SKILLS_DIR = 'STEM_SKILLS_DIR';

// ---- raw-event probing ----

/**
 * The argument object of a raw `tool_execution_start` event. pi's event shape
 * is not formally typed (PiEvent is open) and the args key has moved across
 * versions, so probe the known aliases in order. Single implementation — both
 * the normalizer's activity labels and the memory-taint path check use this.
 */
export function toolArgsOf(ev: PiEvent): Record<string, unknown> | undefined {
  return (ev.toolInput ?? ev.args ?? ev.input ?? ev.arguments ?? ev.params) as
    | Record<string, unknown>
    | undefined;
}
