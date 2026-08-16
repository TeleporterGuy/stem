import { createHash } from 'node:crypto';
import type { DeviceMcpSpec } from './types';

// What a device-hosted MCP server's spec IS, reduced to one string, so that
// "the user approved this" can be a fact about the spec rather than about its
// name (docs/mcp-device-pinning.md, ④).
//
// One file, imported by both ends, for the reason every protocol rule in
// src/shared/ is: the server computes the fingerprint it sends down, the client
// computes the fingerprint it compares against its approval store, and the two
// have to agree exactly. A second implementation that normalized even slightly
// differently would either re-ask for approval of a server that never changed —
// on every launch, forever — or, far worse, fail to ask for one that did.
//
// It uses node:crypto, which the two computers of a fingerprint both have: the
// server process and the Electron main process. The renderer and the React
// Native bundle are HANDED fingerprints and never compute one, so neither
// imports this file; the types it works on live in ./types.ts, which they do
// import. Keep it that way — a `node:crypto` import reaching a browser bundle
// fails at build time, which is the good outcome but a confusing one.

/**
 * The spec as a canonical string: every field that decides what actually runs,
 * in a fixed order, with map keys sorted so that two specs differing only in the
 * order somebody typed their environment variables hash the same.
 *
 * Values are included, not just keys. That is the whole point — an `env` entry
 * changed from a read-only token to an admin one is a different program running
 * on your machine with different powers, and a fingerprint that covered only the
 * variable's NAME would call that the same spec and let it through on an
 * approval given for something else.
 *
 * Absent, empty and blank are one state: `{}` and `undefined` for `env` mean the
 * same thing to the process that gets spawned, so they must not mean different
 * things here — otherwise a round-trip through a form that materializes an empty
 * object would look like an edit.
 *
 * Emitted with a key for each field rather than positionally, and with empty
 * fields left out, so that a field added to DeviceMcpSpec later only changes the
 * fingerprint of specs that actually use it — a positional array would move
 * every existing approval the day the shape grew.
 */
export function canonicalMcpSpec(spec: DeviceMcpSpec): string {
  const canonical: Record<string, unknown> = {};
  // Alphabetical, and written out one by one rather than looped, so the set of
  // things a fingerprint covers is legible here instead of being whatever the
  // type happens to hold.
  const args = (spec.args ?? []).map((arg) => String(arg));
  if (args.length > 0) canonical.args = args;
  if (spec.command?.trim()) canonical.command = spec.command;
  const env = sortedEntries(spec.env);
  if (env.length > 0) canonical.env = env;
  const headers = sortedEntries(spec.headers);
  if (headers.length > 0) canonical.headers = headers;
  if (spec.url?.trim()) canonical.url = spec.url;
  return JSON.stringify(canonical);
}

/**
 * The fingerprint a spec is approved (or not approved) under. SHA-256 rather
 * than the canonical string itself for two reasons that both matter: the client
 * writes this into an approval file on its own disk, and the canonical string
 * contains the API keys.
 */
export function mcpSpecFingerprint(spec: DeviceMcpSpec): string {
  return createHash('sha256').update(canonicalMcpSpec(spec)).digest('hex');
}

/** A map as sorted [key, value] pairs — stable regardless of insertion order. */
function sortedEntries(map: Record<string, string> | undefined): [string, string][] {
  if (!map) return [];
  return Object.entries(map)
    .map(([key, value]): [string, string] => [key, String(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
