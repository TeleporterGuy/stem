// Point the Stem-owned stores at throwaway paths BEFORE any module under test is
// imported (setup files run first), and wipe them so every run starts clean. The
// store modules read these env vars instead of Electron's userData dir — the same
// seam the old scripts/*-verify.mjs probes used.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const recallDb = join(tmpdir(), `stem-recall-${process.pid}.sqlite`);
const filesDir = join(tmpdir(), `stem-files-${process.pid}`, 'files');
const chatSearchDb = join(tmpdir(), `stem-chat-search-${process.pid}.sqlite`);
const mcpConfig = join(tmpdir(), `stem-mcp-config-${process.pid}.json`);
const mcpOAuth = join(tmpdir(), `stem-mcp-oauth-${process.pid}.json`);

process.env.STEM_RECALL_DB = recallDb;
process.env.STEM_FILES_DIR = filesDir;
process.env.STEM_CHAT_SEARCH_DB = chatSearchDb;
process.env.STEM_PI_MCP_CONFIG = mcpConfig;
process.env.STEM_PI_MCP_OAUTH = mcpOAuth;

for (const p of [recallDb, `${recallDb}-wal`, `${recallDb}-shm`]) {
  rmSync(p, { force: true });
}
for (const p of [chatSearchDb, `${chatSearchDb}-wal`, `${chatSearchDb}-shm`]) {
  rmSync(p, { force: true });
}
for (const p of [mcpConfig, mcpOAuth]) rmSync(p, { force: true });
rmSync(join(tmpdir(), `stem-files-${process.pid}`), { recursive: true, force: true });
