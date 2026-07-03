// Captures the README screenshots (docs/screenshots/) from the BUILT app with a
// fully isolated profile — same isolation seams as the e2e harness. Real backend:
// the throwaway pi-home auto-seeds auth.json from ~/.pi/agent (ensurePiHome), so
// live turns run with existing credentials without touching the signed-in profile.
//
//   npx electron-vite build && npx tsx scripts/capture-readme-shots.mts
//
// Each shot is captured twice — light and dark — via CDP color-scheme emulation
// (the whole UI is styled on prefers-color-scheme, no manual theme toggle), so
// one set of live turns yields both README <picture> variants. Costs a handful
// of real model completions.
import { _electron as electron, type ElectronApplication, type Page, type Locator } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT_DIR = join(PROJECT_ROOT, 'docs', 'screenshots');
const TURN_TIMEOUT = 180_000;

type Scheme = 'light' | 'dark';
const SCHEMES: Scheme[] = ['dark', 'light'];

// Raw CDP capture with clip.scale=2: re-renders the clip at 2x, so shots are
// retina-crisp even on a 1x display (Playwright's screenshot copies compositor
// pixels and is capped at the physical display density).
const cdpCache = new Map<Page, any>();
async function cdpFor(page: Page): Promise<any> {
  let session = cdpCache.get(page);
  if (!session) {
    session = await page.context().newCDPSession(page);
    cdpCache.set(page, session);
  }
  return session;
}

/** Screenshot `target` (or the whole viewport) in both color schemes as
 *  <name>-{light,dark}.png, rendered at 2x. */
async function shoot(
  page: Page,
  name: string,
  target?: Locator,
  opts: { omitBackground?: boolean; maxHeight?: number } = {}
): Promise<void> {
  const cdp = await cdpFor(page);
  for (const colorScheme of SCHEMES) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(350); // let the palette + any SVG charts settle
    let box: { x: number; y: number; width: number; height: number };
    if (target) {
      const b = await target.boundingBox();
      if (!b) throw new Error(`no bounding box for ${name}`);
      box = b;
      if (opts.maxHeight) box.height = Math.min(box.height, opts.maxHeight);
    } else {
      box = await page.evaluate(() => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }));
    }
    if (opts.omitBackground) {
      await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    }
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...box, scale: 2 }
    });
    if (opts.omitBackground) await cdp.send('Emulation.setDefaultBackgroundColorOverride');
    writeFileSync(join(OUT_DIR, `${name}-${colorScheme}.png`), Buffer.from(data, 'base64'));
    console.log(`  ✓ ${name}-${colorScheme}.png`);
  }
  await page.emulateMedia({ colorScheme: null });
}

/** Seed distilled demo facts into a bare recall.sqlite. The app's store creates
 *  the remaining tables/FTS on open and backfills the fact indexes (the
 *  facts_index_built meta flag is absent), so a facts-only seed is safe. */
function seedRecallDb(path: string): void {
  const facts: Array<{ text: string; source: string; ageDays: number }> = [
    { text: 'Works as a product designer at a small studio in Vienna.', source: 'distilled', ageDays: 34 },
    { text: 'Is training for a half-marathon in October.', source: 'distilled', ageDays: 21 },
    { text: 'Partner Ana is vegetarian — family dinners should be meat-free.', source: 'explicit', ageDays: 12 },
    { text: 'Prefers metric units and 24-hour time.', source: 'distilled', ageDays: 8 },
    { text: 'Backs up photos to a Synology NAS at home.', source: 'distilled', ageDays: 3 },
    { text: 'Allergic to peanuts.', source: 'explicit', ageDays: 1 }
  ];
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS facts (
    id         INTEGER PRIMARY KEY,
    text       TEXT NOT NULL,
    norm       TEXT UNIQUE,
    source     TEXT,
    updated_at INTEGER NOT NULL
  );`);
  const insert = db.prepare('INSERT INTO facts (text, norm, source, updated_at) VALUES (?, ?, ?, ?)');
  const now = Math.floor(Date.now() / 1000);
  for (const f of facts) {
    const norm = f.text.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:\s]+$/u, '');
    insert.run(f.text, norm, f.source, now - f.ageDays * 86_400);
  }
  db.close();
}

/** Bind the Quick Chat shortcut so the HUD pill prompts a real summon key
 *  ("⌥Space open") instead of "click to open". Registered globally only for
 *  the few minutes the capture app runs. */
function seedSettings(path: string): void {
  writeFileSync(path, JSON.stringify({ quickChat: { shortcut: 'Alt+Space' } }, null, 2));
}

/** Demo scheduled tasks (far-future next runs so the scheduler never dispatches). */
function seedTasks(path: string): void {
  const mk = (id: string, title: string, prompt: string, expr: string, next: string) => ({
    id,
    threadId: `demo-${id}`,
    prompt,
    schedule: { kind: 'cron', expr },
    enabled: true,
    createdAt: new Date('2026-06-01T09:00:00').toISOString(),
    title,
    lastRunAt: new Date('2026-07-02T08:00:00').toISOString(),
    lastStatus: 'ok',
    nextRunAt: next
  });
  const tasks = [
    mk('briefing', 'Morning briefing', 'Summarize overnight tech news and anything relevant to my current projects.', '0 8 * * *', new Date('2030-01-06T08:00:00').toISOString()),
    mk('review', 'Friday week-in-review', 'Look back over this week’s chats and give me a short review with loose ends.', '0 17 * * 5', new Date('2030-01-10T17:00:00').toISOString())
  ];
  writeFileSync(path, JSON.stringify({ version: 1, tasks }, null, 2));
}

async function mainWindowOf(app: ElectronApplication): Promise<Page> {
  for (let i = 0; i < 50; i++) {
    for (const win of app.windows()) {
      const url = win.url();
      if (url && !url.includes('quickchat') && !url.includes('hud')) return win;
    }
    await app.waitForEvent('window').catch(() => {});
  }
  throw new Error('main window never appeared');
}

async function windowByFlag(app: ElectronApplication, flag: string): Promise<Page> {
  for (const win of app.windows()) if (win.url().includes(flag)) return win;
  throw new Error(`${flag} window not found`);
}

/** Send a prompt in the main composer and wait until the turn settles. The
 *  send button flips to Stop while a turn runs, so its lifecycle is the robust
 *  signal — reply-body locators can miss fallback render paths. */
async function runTurn(win: Page, prompt: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(prompt);
  await composer.press('Enter');
  const stop = win.locator('.icon-btn.stop');
  await stop.waitFor({ timeout: 30_000 }).catch(() => {}); // fast turns may already be done
  await stop.waitFor({ state: 'detached', timeout: TURN_TIMEOUT });
  await win.waitForTimeout(600);
  console.log(`  · turn done: ${prompt.slice(0, 60)}…`);
}

async function openTab(win: Page, name: string): Promise<void> {
  await win.getByRole('button', { name, exact: true }).click();
  await win.waitForTimeout(250);
}

async function createFolder(win: Page, name: string): Promise<void> {
  await win.locator('[title="New folder"]').click();
  await win.keyboard.type(name);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(200);
}

async function moveChatToFolder(win: Page, chatRow: Locator, folderName: string): Promise<void> {
  await chatRow.click({ button: 'right' });
  const menu = win.locator('.ctx-menu');
  await menu.waitFor();
  await menu.getByRole('button', { name: folderName, exact: true }).click();
  await win.waitForTimeout(200);
}

async function main(): Promise<void> {
  if (!existsSync(join(PROJECT_ROOT, 'dist', 'main', 'index.js'))) {
    console.log('dist/ missing — building…');
    execFileSync('npx', ['electron-vite', 'build'], { stdio: 'inherit', cwd: PROJECT_ROOT });
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const userDataDir = process.env.STEM_SHOTS_PROFILE ?? mkdtempSync(join(tmpdir(), 'stem-shots-'));
  mkdirSync(userDataDir, { recursive: true });
  const recallDb = join(userDataDir, 'recall.sqlite');
  const tasksStore = join(userDataDir, 'tasks.json');
  if (!existsSync(recallDb)) seedRecallDb(recallDb);
  if (!existsSync(tasksStore)) seedTasks(tasksStore);
  const settingsStore = join(userDataDir, 'settings.json');
  if (!existsSync(settingsStore)) seedSettings(settingsStore);
  console.log(`profile: ${userDataDir}`);

  const app = await electron.launch({
    args: [PROJECT_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      STEM_RECALL_DB: recallDb,
      STEM_FILES_DIR: join(userDataDir, 'files'),
      STEM_TASKS_STORE: tasksStore,
      STEM_CHAT_SEARCH_DB: join(userDataDir, 'chat_search.sqlite')
    } as Record<string, string>
  });

  try {
    const win = await mainWindowOf(app);
    await win.waitForLoadState('domcontentloaded');

    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((w) => {
        const url = w.webContents.getURL();
        return !url.includes('quickchat') && !url.includes('hud');
      });
      main?.setBounds({ x: 60, y: 60, width: 1360, height: 860 });
    });

    // Gate: with the auto-seeded auth the composer appears without interaction.
    await win.getByPlaceholder('Ask Stem…').waitFor({ timeout: 120_000 });
    console.log('app ready (authenticated)');

    // ---- Live turns (4 chats: hero, quiz, and two small ones for the sidebar) ----
    console.log('running live turns…');
    await runTurn(
      win,
      'Plan a 6-week training ramp for my half-marathon in October — chart how the weekly mileage builds up, give me the weekly schedule, and call out anything I should watch for with my knees.'
    );
    const newChat = win.locator('[title="New conversation"]');

    await newChat.click();
    // Capitals keep the quiz text free of nested quotation marks, which can
    // break MDX attribute parsing and drop the answer to a plain-text fallback.
    await runTurn(win, 'Give me a quick interactive quiz — five questions on European capitals.');
    await win.getByRole('button', { name: 'Check answers' }).waitFor({ timeout: 10_000 });

    await newChat.click();
    await runTurn(win, 'Give me three ideas for a rainy Saturday in Vienna. Keep it short.');

    await newChat.click();
    await runTurn(
      win,
      'Draft a short standup update from these notes: fixed the onboarding bug, reviewed Ana’s design PR, started the settings redesign. Keep it brief.'
    );

    // ---- Organize the sidebar: Spaces + assignments (Chats tab, ctx-menu moves) ----
    console.log('organizing chats into Spaces…');
    await openTab(win, 'Chats');
    await createFolder(win, 'Training');
    await createFolder(win, 'Work');
    await createFolder(win, 'Home');

    // Rows list newest-first; the hero chat is the oldest of the four.
    const chatRows = win.locator('.chat-row');
    await moveChatToFolder(win, chatRows.nth(3), 'Training'); // hero → Training
    await moveChatToFolder(win, chatRows.first(), 'Work'); // standup → Work
    // After the two moves the remaining root rows are: rainy-Saturday, quiz.
    await moveChatToFolder(win, chatRows.first(), 'Home'); // rainy Saturday → Home

    // Expand the Spaces so their chats are visible in the shot.
    for (const name of ['Training', 'Work', 'Home']) {
      await win.locator('.folder-row', { hasText: name }).click();
      await win.waitForTimeout(150);
    }

    // ---- Shot: sidebar with Spaces (full window, rainy-Saturday chat open) ----
    await win.locator('.chat-row', { hasText: /rainy|Saturday/i }).first().click();
    await win.waitForTimeout(500);
    await shoot(win, 'sidebar-spaces');

    // ---- Shot: memory facts ----
    await openTab(win, 'Memory');
    await win.getByRole('button', { name: 'Facts', exact: true }).click();
    const storedMemory = win.getByRole('button', { name: /Stored memory/ });
    if (await storedMemory.isVisible().catch(() => false)) {
      await storedMemory.click();
      await storedMemory.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    }
    await win.waitForTimeout(300);
    await shoot(win, 'memory-facts', win.locator('.inspector'));

    // ---- Shot: scheduled tasks (clipped — the list is short) ----
    await openTab(win, 'Tasks');
    await shoot(win, 'tasks', win.locator('.inspector'), { maxHeight: 300 });

    // ---- Shot: settings with providers ----
    await openTab(win, 'Settings');
    await win.waitForTimeout(300);
    await shoot(win, 'settings-providers', win.locator('.inspector'));

    // ---- Shots: hero MDX answer + MDX showcase (inspector hidden, chat wide) ----
    // The Chats tab remounts collapsed — expand Training again to reach its chat.
    await openTab(win, 'Chats');
    await win.locator('.folder-row', { hasText: 'Training' }).click();
    await win.waitForTimeout(200);
    await win.locator('.chat-row', { hasText: /half-marathon|training ramp/i }).first().click();
    await win.waitForTimeout(500);
    await win.locator('[title="Toggle inspector"]').click();
    await win.waitForTimeout(400);
    // Show the answer from its start: intro line, chart title, and the chart
    // itself fill the viewport (the chart sits right after the intro).
    await win
      .locator('.message-assistant:not(.activity-row)')
      .last()
      .evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await win.waitForTimeout(300);
    await shoot(win, 'hero-mdx');

    await win.locator('[title="Toggle inspector"]').click();
    await openTab(win, 'Chats');
    await win.locator('.chat-row', { hasText: /quiz|spanish/i }).first().click();
    await win.waitForTimeout(500);
    await win.locator('[title="Toggle inspector"]').click();
    await win.waitForTimeout(400);
    await win
      .locator('.message-assistant:not(.activity-row)')
      .last()
      .evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await win.waitForTimeout(300);
    await shoot(win, 'mdx-showcase');

    // ---- Shots: Quick Chat cycle (ask → overlay hides → HUD pill → re-summon) ----
    // Submitting in the overlay immediately hides it and raises the HUD — the
    // "ask and keep working" cycle. Capture the pill while the turn settles,
    // then re-summon the overlay to photograph the answer.
    console.log('quick chat…');
    await app.evaluate(({ BrowserWindow }) => {
      const qc = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('quickchat'));
      if (!qc) throw new Error('overlay window missing');
      qc.show();
      qc.focus();
      qc.webContents.send('quickchat:focus', { reset: true });
    });
    const overlay = await windowByFlag(app, 'quickchat');
    const qcInput = overlay.locator('.qc-input');
    await qcInput.waitFor({ timeout: 10_000 });
    await qcInput.fill('How much caffeine is in a flat white vs a cappuccino? One line.');
    await qcInput.press('Enter');

    // ---- Shot: status HUD pill ("Answer ready") ----
    const hud = await windowByFlag(app, 'hud');
    await hud.locator('.hud-pill.finished').waitFor({ timeout: TURN_TIMEOUT });
    // The pill is a translucent blur over the desktop, which a page capture
    // can't see — substitute a solid surface so the PNG reads on any background.
    await hud.addStyleTag({
      content:
        '.hud-pill { background: var(--surface) !important; -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }'
    });
    await shoot(hud, 'status-hud', hud.locator('.hud-pill'), { omitBackground: true });

    // ---- Shot: Quick Chat overlay re-summoned with the answer ----
    // Click the pill — the real re-summon path, so the main process restores
    // the expanded panel bounds (a manual show() would keep the compact 108px
    // window and crop the conversation).
    await hud.locator('.hud-pill').click();
    await overlay.locator('.qc-panel .message-assistant .message-body').last().waitFor({ timeout: 30_000 });
    await overlay.waitForTimeout(800);
    await overlay.addStyleTag({ content: '.qc-card { background: var(--surface) !important; }' });
    await shoot(overlay, 'quick-chat', overlay.locator('.qc-card'), { omitBackground: true });

    console.log('all shots captured →', OUT_DIR);
  } catch (err) {
    // Dump every window so a failed run is diagnosable from PNGs alone.
    for (const [i, page] of app.windows().entries()) {
      await page
        .screenshot({ path: join(userDataDir, `debug-window-${i}.png`) })
        .catch(() => {});
    }
    console.error(`debug screenshots → ${userDataDir}`);
    throw err;
  } finally {
    await app.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
