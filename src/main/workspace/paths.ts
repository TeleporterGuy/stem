import { app } from 'electron';
import { join } from 'node:path';

// All app state lives under Electron's userData dir, fully isolated from the
// user's global pi config. The backend home and the working dir we launch the
// backend in are both app-owned so no external skills/config can leak in.

export function userDataRoot(): string {
  return app.getPath('userData');
}

/** A resolved alternate profile: an isolated userData dir + a human label for it. */
export interface ProfileOverride {
  userDataDir: string;
  label: string;
}

/**
 * Resolve a `--fresh` / `--profile=<name>` (or `STEM_FRESH=1` / `STEM_PROFILE=<name>`)
 * request into an alternate userData directory under a sibling `Stem Profiles/` container,
 * so you can walk the first-run onboarding as a brand-new user without touching the real
 * signed-in profile. Returns null when nothing is requested (the native `--user-data-dir`
 * switch, if any, still applies untouched).
 *
 * Precedence: fresh > named profile > none. Args are injectable so this is unit-testable
 * without Electron and with a deterministic clock.
 */
export function resolveProfileOverride(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  appDataDir: string = app.getPath('appData'),
  now: () => Date = () => new Date()
): ProfileOverride | null {
  const container = join(appDataDir, 'Stem Profiles');
  const hasFlag = (name: string) => argv.includes(`--${name}`);
  const flagValue = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

  if (hasFlag('fresh') || env.STEM_FRESH === '1') {
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const label = `fresh-${stamp}`;
    return { userDataDir: join(container, label), label };
  }

  const requested = flagValue('profile') ?? env.STEM_PROFILE;
  if (requested && requested.trim()) {
    // Reduce to a safe basename: no path separators or traversal can escape the container.
    const label = requested.trim().replace(/[^A-Za-z0-9._-]/g, '-');
    return { userDataDir: join(container, label), label };
  }

  return null;
}

/** The legacy codex backend home, removed on startup (see bootstrap cleanup). */
export function legacyCodexHome(): string {
  return join(userDataRoot(), 'codex-home');
}

/**
 * PI_CODING_AGENT_DIR for the isolated pi backend (auth.json, skills, settings).
 * Sessions live under {@link piSessionsDir}.
 */
export function piHome(): string {
  return join(userDataRoot(), 'pi-home');
}

/** PI_CODING_AGENT_SESSION_DIR — where the pi backend stores session JSONL trees. */
export function piSessionsDir(): string {
  return join(piHome(), 'sessions');
}

/** The pi-mcp-adapter config (mcp.json) under the pi home; the config.toml analog. */
export function piMcpConfigPath(): string {
  return join(piHome(), 'mcp.json');
}

/**
 * pi's custom-providers config (models.json) under the isolated pi home. Stem
 * writes local providers (Ollama, LM Studio) here; pi reads it at spawn.
 */
export function piModelsConfigPath(): string {
  return process.env.STEM_PI_MODELS_CONFIG ?? join(piHome(), 'models.json');
}

export function skillsRoot(): string {
  // STEM_SKILLS_DIR lets probe/verification scripts and unit tests point at a
  // throwaway folder (and avoids touching Electron's `app` when run outside the
  // app). In the running app this is unset in the main process, so it resolves to
  // the pi-home skills dir; the bridge subprocess is handed the resolved path.
  return process.env.STEM_SKILLS_DIR ?? join(piHome(), 'skills');
}

/** The controlled cwd we spawn the backend in — empty/app-owned. */
export function workspaceRoot(): string {
  return join(userDataRoot(), 'workspace');
}

export function agentsMdPath(): string {
  return join(workspaceRoot(), 'AGENTS.md');
}

/**
 * The persistent "Files" place: a user-facing folder inside the backend cwd where
 * the user drops files (optionally organized into subfolders) that the assistant
 * can read on demand. Inside workspaceRoot() so the agent's read tools reach it.
 */
export function filesRoot(): string {
  // STEM_FILES_DIR lets probe/verification scripts point at a throwaway folder
  // (and avoids touching Electron's `app` when run outside the app).
  return process.env.STEM_FILES_DIR ?? join(workspaceRoot(), 'files');
}

/**
 * Stem-owned chat-organization store: the user's folder tree and the
 * chat->folder assignments. Chats themselves are backend threads on disk; this
 * file only holds the organization layer the backend has no concept of.
 */
export function chatStorePath(): string {
  return join(userDataRoot(), 'folders.json');
}

/**
 * Stem-owned registry of external "connected folders" the assistant may read in
 * place (e.g. an Obsidian vault). Holds only absolute paths + per-folder mode and
 * memorize flags — the folders themselves stay where they live on disk.
 */
export function connectedFoldersStorePath(): string {
  return join(userDataRoot(), 'connected-folders.json');
}

/**
 * Gate file the bridge extension reads to enforce read-only connected folders:
 * the absolute paths of folders connected in 'read' mode. Lives next to mcp.json
 * under the pi home so the extension can read it (mtime-cached) like the other
 * per-turn gate files. Rewritten by the main process whenever the registry changes.
 */
export function protectedRootsPath(): string {
  return join(piHome(), 'protected-roots.json');
}

/**
 * Stem-owned registry of scheduled tasks: prompts re-run as autonomous agent turns
 * on a cron/once schedule, each bound to its originating chat. Holds the task
 * definitions plus last/next-run bookkeeping; the runs themselves land in the
 * backend thread like any other turn.
 */
export function tasksStorePath(): string {
  // STEM_TASKS_STORE lets unit tests point at a throwaway file (and avoids touching
  // Electron's `app` when run outside the app), like the other store path helpers.
  return process.env.STEM_TASKS_STORE ?? join(userDataRoot(), 'tasks.json');
}

/**
 * Cache dir for the bundled local embedding models (transformers.js `env.cacheDir`).
 * Weights download here once per model on first use; safe to delete — they just
 * re-download on next need.
 */
export function embedModelsDir(): string {
  // STEM_EMBED_MODELS_DIR lets probe/verification scripts point at a throwaway
  // cache (and avoids touching Electron's `app` when run outside the app).
  return process.env.STEM_EMBED_MODELS_DIR ?? join(userDataRoot(), 'embed-models');
}

/**
 * Stem-owned app settings (e.g. the global Quick Chat shortcut + its defaults).
 * Held in the main process because some of it — the global accelerator — can
 * only be registered from main, not the renderer.
 */
export function settingsStorePath(): string {
  return join(userDataRoot(), 'settings.json');
}

/**
 * Stem-owned recall database (the custom memory layer): every user+assistant
 * message (Level 2, FTS5-searchable) plus distilled durable facts (Level 1).
 * Stem owns this end-to-end so memory is decoupled from the chat backend.
 */
export function recallDbPath(): string {
  // STEM_RECALL_DB lets probe/verification scripts point at a throwaway database
  // (and avoids touching Electron's `app` when run outside the app).
  return process.env.STEM_RECALL_DB ?? join(userDataRoot(), 'recall.sqlite');
}

/**
 * Unix socket where main serves query embeddings to the stem-recall MCP server
 * (see recall/embed-endpoint.ts). Lives in userData — comfortably under the
 * 104-byte sun_path limit at the default location; the endpoint logs-and-skips
 * if an exotic profile path ever pushes past it.
 */
export function embedSocketPath(): string {
  return process.env.STEM_EMBED_SOCK ?? join(userDataRoot(), 'stem-embed.sock');
}

/**
 * Stem-owned chat-search index (FTS5 over every chat's title + messages). Kept in
 * its OWN database, physically separate from recall.sqlite, because "search my own
 * chats" deliberately does NOT obey the AI's memorize/taint rules — you must be able
 * to find a chat even if it was marked don't-remember. Backfilled from the JSONL
 * session files, so its coverage is complete and independent of when recall started.
 */
export function chatSearchDbPath(): string {
  // STEM_CHAT_SEARCH_DB lets probe/verification scripts point at a throwaway database
  // (and avoids touching Electron's `app` when run outside the app).
  return process.env.STEM_CHAT_SEARCH_DB ?? join(userDataRoot(), 'chat_search.sqlite');
}
