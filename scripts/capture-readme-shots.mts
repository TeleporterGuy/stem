// Captures the README screenshots (docs/screenshots/) from the BUILT app, running
// as an isolated instance on a throwaway profile seeded with the docs' "Maya"
// demo data. Never touches the signed-in profile or a running Stem.app: the
// instance gets its own --user-data-dir, and only the process this script
// started is ever stopped.
//
//   npx electron-vite build
//   node scripts/capture-readme-shots.mts seed    # once: builds the Maya profile
//   node scripts/capture-readme-shots.mts shoot   # recaptures every shot from it
//   node scripts/capture-readme-shots.mts shoot hero mail   # just these
//
// `seed` spends real model quota: about eight chat turns, three persona mails
// (one of them fans out to agents), a memory deep check and the summary of you.
// `shoot` spends one Quick Chat turn (the pill only shows for a live answer).
// Auth comes from ~/.pi/agent, which the fresh pi home seeds itself from.
//
// Env: STEM_SHOTS_PROFILE (default: <appData>/Stem Profiles/readme-maya),
//      STEM_SHOTS_PORT (CDP port, default 9341). If something already answers on
//      the port, the script drives it instead of launching (and leaves it running).
//
// Demo folders live in /Users/Shared/Maya (Personal Obsidian, Work Obsidian,
// Argo CD — Kubernetes Code, My App Source, Invoices); the seed refuses to run
// without them.
//
// Traps this recipe works around:
// - Never type through the clipboard (a paste once attached a private photo):
//   text goes in through the native value setter + an input event.
// - Theme switches via data-theme on <html>, not emulated media; Mermaid only
//   redraws on the attribute.
// - Retina: the CDP clip scale is 2/devicePixelRatio.
// - The window can't be resized over CDP; shots are the default 1200x820.
// - Folder rows keep the same chevron when open, so "open" is read from the
//   indentation of the row after it.

import { spawn, type ChildProcess } from 'node:child_process';
import { constants, existsSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import electronPath from 'electron';
import { GTE_MODEL_VERSION } from '../src/server/recall/gte-model-artifact';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'docs', 'screenshots');
const APP_DATA =
  process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const PROFILE = process.env.STEM_SHOTS_PROFILE || join(APP_DATA, 'Stem Profiles', 'readme-maya');
const PORT = Number(process.env.STEM_SHOTS_PORT) || 9341;
const MAYA = '/Users/Shared/Maya';
const THEMES = ['light', 'dark'] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- launching

let child: ChildProcess | null = null;

async function cdpUp(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return true;
  } catch {
    return false;
  }
}

async function launch(): Promise<void> {
  if (await cdpUp()) {
    console.log(`using the instance already on :${PORT}`);
    return;
  }
  if (!existsSync(join(ROOT, 'dist', 'main', 'index.js'))) throw new Error('dist/ missing: run npx electron-vite build');
  mkdirSync(PROFILE, { recursive: true });
  const env = { ...process.env } as Record<string, string>;
  delete env.STEM_PROFILE;
  delete env.STEM_FRESH;
  Object.assign(env, {
    STEM_RECALL_DB: join(PROFILE, 'recall.sqlite'),
    STEM_FILES_DIR: join(PROFILE, 'files'),
    STEM_TASKS_STORE: join(PROFILE, 'tasks.json'),
    STEM_CHAT_SEARCH_DB: join(PROFILE, 'chat_search.sqlite')
  });
  child = spawn(electronPath as unknown as string, ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env,
    stdio: 'ignore'
  });
  for (let i = 0; i < 120 && !(await cdpUp()); i++) await sleep(500);
  // The renderer needs a moment past the CDP port to mount and pass the auth gate.
  for (let i = 0; i < 120; i++) {
    try {
      const ready = await (await page('main')).eval(`return !!document.querySelector('textarea[placeholder="Ask Stem…"]')`);
      if (ready) break;
    } catch {
      /* page not there yet */
    }
    await sleep(500);
  }
  console.log(`launched isolated instance (pid ${child.pid}) on ${PROFILE}`);
}

async function stop(): Promise<void> {
  if (!child) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 40 && (await cdpUp()); i++) await sleep(250);
  child = null;
}

// ---------------------------------------------------------------- CDP

// Helpers injected ahead of every evaluated snippet.
const PRELUDE = String.raw`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const label = (b) => b.title || b.getAttribute('aria-label') || '';
const btn = (l) => [...document.querySelectorAll('button')].find((b) => label(b).startsWith(l) || b.textContent.trim() === l);
const byText = (t) => [...document.querySelectorAll('button, [role=tab], a')].filter((b) => b.textContent.trim().startsWith(t));
const clickText = async (t, i = 0) => { const b = byText(t)[i]; if (!b) throw new Error('no button ' + t); b.click(); await sleep(600); };
const setText = (el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const send = async (text) => { setText(document.querySelector('textarea[placeholder="Ask Stem…"]'), text); await sleep(200); btn('Send').click(); };
const waitIdle = async (maxMs = 400000) => {
  const t0 = Date.now(); await sleep(1500);
  while (Date.now() - t0 < maxMs) { if (!btn('Stop')) { await sleep(1500); if (!btn('Stop')) return true; } await sleep(1000); }
  throw new Error('turn did not finish');
};
const tab = async (l) => { const b = btn(l); if (!b) throw new Error('no tab ' + l); b.click(); await sleep(700); };
const rows = () => [...document.querySelectorAll('.inspector .group-row')];
const isOpen = (r) => { const all = rows(); const n = all[all.indexOf(r) + 1]; const pad = (e) => parseFloat(getComputedStyle(e).paddingLeft); return !!n && pad(n) > pad(r); };
const showChats = async () => { await tab('Chats'); const subs = byText('Chats'); subs[subs.length - 1].click(); await sleep(700); };
const showInbox = async () => { await tab('Chats'); await clickText('Inbox'); };
const expandAll = async () => { for (let i = 0; i < 20; i++) { const r = [...document.querySelectorAll('.inspector .folder-row')].find((x) => !isOpen(x)); if (!r) return; r.click(); await sleep(350); } };
const gotoChat = async (name) => {
  await showChats(); await expandAll();
  const r = [...document.querySelectorAll('.inspector .chat-row')].find((e) => e.textContent.trim().startsWith(name));
  if (!r) throw new Error('no chat ' + name); r.click(); await sleep(1800);
};
const gotoMail = async (from) => {
  await showInbox();
  const r = [...document.querySelectorAll('.mail-row')].find((e) => e.textContent.trim().startsWith(from));
  if (!r) throw new Error('no mail from ' + from); r.click(); await sleep(1800);
  btn('Dismiss')?.click();
};
const openLd = async (name) => { const r = [...document.querySelectorAll('.inspector .ld-row')].find((e) => e.textContent.trim().startsWith(name)); if (!r) throw new Error('no row ' + name); r.click(); await sleep(900); };
const assistants = () => [...document.querySelectorAll('.message-assistant:not(.activity-row)')];
const scrollChatTo = async (el, offset = 0) => { const sc = document.querySelector('.messages'); sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - offset; await sleep(500); };
const scrollInspector = async (el, offset = 0) => { const sc = document.querySelector('.inspector-scroll'); sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - offset; await sleep(400); };
`;

interface Page {
  /** Runs a snippet in the page over CDP (Runtime.evaluate): our own fixed code, never input from outside. */
  eval(js: string): Promise<any>;
  send(method: string, params?: object): Promise<any>;
  close(): void;
}

async function page(which: 'main' | 'hud' | 'quickchat'): Promise<Page> {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
  const target = list.find(
    (t) => t.type === 'page' && (which === 'main' ? t.url.includes('index.html') && !/[?](hud|quickchat)/.test(t.url) : t.url.includes('?' + which))
  );
  if (!target) throw new Error(`no ${which} window`);
  const ws = new WebSocket(target.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
  let id = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    const p = msg.id ? pending.get(msg.id) : undefined;
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  });
  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', j);
  });
  const send = (method: string, params: object = {}) =>
    new Promise<any>((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  return {
    send,
    close: () => ws.close(),
    async eval(js: string) {
      const res = await send('Runtime.evaluate', {
        expression: `(async () => { ${PRELUDE}\n${js} })()`,
        awaitPromise: true,
        returnByValue: true
      });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || JSON.stringify(res.exceptionDetails));
      return res.result.value;
    }
  };
}

type Clip = { x: number; y: number; width: number; height: number };

/** Capture `<name>-{light,dark}.png`. `clipJs` returns the clip in CSS px (or null = whole window). */
async function shoot(p: Page, name: string, clipJs: string | null, opts: { transparent?: boolean } = {}): Promise<void> {
  for (const theme of THEMES) {
    await p.eval(`document.documentElement.setAttribute('data-theme', '${theme}'); await sleep(900);`);
    const { clip, dpr } = (await p.eval(
      `const dpr = window.devicePixelRatio; ${clipJs ? `return { clip: (() => { ${clipJs} })(), dpr };` : 'return { clip: { x: 0, y: 0, width: innerWidth, height: innerHeight }, dpr };'}`
    )) as { clip: Clip; dpr: number };
    if (opts.transparent) await p.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const { data } = await p.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 2 / dpr } });
    if (opts.transparent) await p.send('Emulation.setDefaultBackgroundColorOverride');
    writeFileSync(join(OUT, `${name}-${theme}.png`), Buffer.from(data, 'base64'));
    console.log(`  ✓ ${name}-${theme}.png`);
  }
}

const INSPECTOR = `const r = document.querySelector('.inspector').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };`;
// An answer crop: the chat column left of the inspector, from the answer's avatar down.
const answerClip = (top: string) =>
  `const t = ${top}; const y = Math.max(52, t - 8); const end = document.querySelector('.messages').getBoundingClientRect().bottom;
   return { x: 0, y, width: 864, height: Math.min(610, end - y) };`;

// ---------------------------------------------------------------- the shots

const SHOTS: Record<string, (main: Page) => Promise<void>> = {
  async hero(main) {
    await main.eval(`await gotoChat('2026 billing by client'); await scrollChatTo(assistants()[0], 0);`);
    await shoot(main, 'hero', null);
  },
  async 'answer-diagram'(main) {
    await main.eval(`await gotoChat('Northwind cutover'); await scrollChatTo(assistants().pop(), 8);`);
    await shoot(main, 'answer-diagram', answerClip(`assistants().pop().getBoundingClientRect().top`));
  },
  async 'answer-compare'(main) {
    await main.eval(`await gotoChat('Halden Bikes: Checkout'); await scrollChatTo(assistants().pop(), 8);`);
    await shoot(main, 'answer-compare', answerClip(`assistants().pop().getBoundingClientRect().top`));
  },
  async 'answer-picture'(main) {
    await main.eval(`await gotoChat('Donaukanal long-run poster'); await sleep(1500); await scrollChatTo(assistants().pop(), 8);`);
    await shoot(main, 'answer-picture', answerClip(`assistants().pop().getBoundingClientRect().top`));
  },
  async memory(main) {
    // The dinner answer beside the facts this chat's last message used.
    await main.eval(`await gotoChat('Dinner for two'); await tab('Memory'); await clickText('Facts');
      // "All" lists the facts this chat's last message used first, marked Injected.
      const f = [...document.querySelectorAll('.inspector button')].find((b) => b.textContent.trim() === 'All'); f.click(); await sleep(800);
      await scrollInspector(document.querySelector('.inspector input[placeholder^="Search"]'), 80);`);
    await shoot(main, 'memory', null);
  },
  async 'memory-check'(main) {
    // The deep check's mail, with the summary of you in the Memory tab beside it.
    await main.eval(`await gotoMail('Memory check'); await tab('Memory'); await clickText('Facts');
      document.querySelector('.inspector-scroll').scrollTop = 0; await sleep(300);
      const h = [...document.querySelectorAll('.inspector *')].find((e) => e.children.length === 0 && e.textContent.trim() === 'What Stem knows about you');
      if (h) await scrollInspector(h, 58);`);
    await shoot(main, 'memory-check', null);
  },
  async folders(main) {
    await main.eval(`await gotoChat('Northwind cutover'); await tab('Sources'); await clickText('Connected folders'); await scrollChatTo(assistants()[0], 0);`);
    await shoot(main, 'folders', null);
  },
  async mail(main) {
    await main.eval(`await gotoMail('Bookkeeper');`);
    await shoot(main, 'mail', null);
  },
  async 'mail-agents'(main) {
    // The lead's answer with its agents' mails unfolded under it.
    await main.eval(`await gotoMail('Secretary'); await clickText('Consulted'); await sleep(800);
      // Start the view at the lead's last heading above the "Consulted …" line.
      const sc = document.querySelector('.mail-items'); const pill = byText('Consulted')[0];
      const mail = pill.closest('.mail-item, article, section') || sc;
      const heads = [...mail.querySelectorAll('h1, h2, h3, h4')].filter((h) => h.getBoundingClientRect().top < pill.getBoundingClientRect().top - 250);
      const anchor = heads.pop();
      sc.scrollTop += anchor ? anchor.getBoundingClientRect().top - 120 : pill.getBoundingClientRect().top - 470; await sleep(500);`);
    await shoot(main, 'mail-agents', null);
  },
  async 'panel-models'(main) {
    await main.eval(`await tab('Settings'); await clickText('Models');`);
    await shoot(main, 'panel-models', INSPECTOR);
  },
  async 'panel-features'(main) {
    await main.eval(`await tab('Settings'); await clickText('Features');`);
    await shoot(main, 'panel-features', INSPECTOR);
  },
  async 'panel-personas'(main) {
    await main.eval(`await tab('Personas'); await openLd('Bookkeeper'); await clickText('Access');`);
    await shoot(main, 'panel-personas', INSPECTOR);
  },
  async 'panel-tasks'(main) {
    await main.eval(`await tab('Scheduled tasks'); const back = byText('Scheduled tasks').find((b) => b.closest('.inspector-scroll')); back?.click(); await sleep(500);`);
    await shoot(main, 'panel-tasks', INSPECTOR);
  },
  async 'panel-task-runs'(main) {
    await main.eval(`await tab('Scheduled tasks'); await openLd('Overdue invoices'); await clickText('Runs');`);
    await shoot(main, 'panel-task-runs', INSPECTOR);
  },
  async 'panel-mcp'(main) {
    await main.eval(`await tab('Tools'); await clickText('MCP servers');`);
    await shoot(main, 'panel-mcp', INSPECTOR);
  },
  async 'panel-skills'(main) {
    await main.eval(`await tab('Tools'); await clickText('Skills');`);
    await shoot(main, 'panel-skills', INSPECTOR);
  },
  async 'panel-folders'(main) {
    await main.eval(`await tab('Sources'); await clickText('Connected folders');
      const back = byText('Connected folders').find((b) => b.closest('.inspector-scroll')); back?.click(); await sleep(500);`);
    await shoot(main, 'panel-folders', INSPECTOR);
  },
  async 'panel-folder-editor'(main) {
    await main.eval(`await tab('Sources'); await clickText('Connected folders'); await openLd('Work Obsidian'); await clickText('Search & learning');`);
    await shoot(main, 'panel-folder-editor', INSPECTOR);
  },
  async 'quick-chat'(main) {
    // Ask → the overlay hides and the pill says the answer is ready → re-summon.
    await main.eval(`await window.stem.revealQuickChat(); await sleep(1200);`);
    const qc = await page('quickchat');
    await qc.eval(`const i = document.querySelector('.qc-input');
      setText(i, 'My race pace is 5:26 per km. Give me min/mile and km/h, plus 10k and half marathon finish times, as a small table.');
      await sleep(200); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));`);
    const hud = await page('hud');
    await hud.eval(`for (let i = 0; i < 200 && !document.querySelector('.hud-pill.finished'); i++) await sleep(1000);
      // The pill is a blur over the desktop, which a page capture can't see.
      const st = document.createElement('style');
      st.textContent = '.hud-pill { background: var(--surface) !important; -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }';
      document.head.appendChild(st);`);
    await shoot(hud, 'status-hud', `const r = document.querySelector('.hud-pill').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };`, { transparent: true });
    await hud.eval(`document.querySelector('.hud-pill').click();`);
    await qc.eval(`await sleep(1500); const st = document.createElement('style'); st.textContent = '.qc-card { background: var(--surface) !important; }'; document.head.appendChild(st);`);
    await shoot(qc, 'quick-chat', `const r = document.querySelector('.qc-card').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };`, { transparent: true });
    await main.eval(`await window.stem.hideQuickChat();`);
    qc.close();
    hud.close();
  }
};

async function runShoot(names: string[]): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await launch();
  const main = await page('main');
  try {
    // Start from a clean renderer so earlier UI state doesn't leak into a shot.
    await main.eval(`location.reload();`).catch(() => {});
    await sleep(4000);
    const main2 = await page('main');
    for (const name of names.length ? names : Object.keys(SHOTS)) {
      const fn = SHOTS[name];
      if (!fn) throw new Error(`unknown shot ${name}; known: ${Object.keys(SHOTS).join(', ')}`);
      console.log(name);
      await fn(main2);
    }
    await main2.eval(`document.documentElement.removeAttribute('data-theme');`);
    main2.close();
  } finally {
    main.close();
    await stop();
  }
}

// ---------------------------------------------------------------- seeding

const FOLDERS = [
  { name: 'Personal Obsidian', patch: { kind: 'notes', index: true, memorize: true, learnMode: 'use', note: 'Personal vault: running, recipes, travel, home' } },
  { name: 'Work Obsidian', patch: { kind: 'notes', index: true, memorize: true, learnMode: 'new', note: 'Client notes and admin for consulting work' } },
  { name: 'Argo CD — Kubernetes Code', patch: { kind: 'code', index: true, memorize: false, note: 'Argo CD apps for client clusters' } },
  { name: 'My App Source', patch: { kind: 'code', mode: 'readwrite', index: true, memorize: false, note: 'Billing report tool (TypeScript)' } },
  { name: 'Invoices', patch: { kind: 'private', index: true, memorize: false, note: '2026 invoices, one Markdown file each' } }
];

const PERSONAS = [
  {
    name: 'Bookkeeper',
    prompt:
      "You keep Maya's freelance books. Read the Invoices folder and the rates note in Work Obsidian. Track what is invoiced, paid and overdue, and draft friendly payment reminders. Never send anything yourself; drafts only."
  },
  {
    name: 'Researcher',
    prompt:
      "You research technical questions for Maya's consulting work. Search the web, prefer primary sources, and answer with a recommendation first, then the evidence with links."
  },
  {
    name: 'Ops',
    prompt:
      'You look after the client Kubernetes clusters Maya runs with Argo CD. Read the Argo CD repo, compare it with what clients were promised in the Work Obsidian notes, and flag drift.'
  }
];

// [text, source ('explicit' | 'distilled' | a folder name), category, age in days, pinned, sensitive, times injected, times used]
const FACTS: Array<[string, string, string, number, boolean, boolean, number, number]> = [
  ['Independent developer and consultant based in Vienna.', 'distilled', 'identity', 60, false, false, 22, 9],
  ['Prefers TypeScript and Postgres; avoids ORMs.', 'explicit', 'preference', 40, true, false, 13, 6],
  ['Partner Ana is vegetarian.', 'explicit', 'relationship', 30, false, false, 16, 7],
  ['Allergic to peanuts.', 'explicit', 'health', 25, true, true, 31, 15],
  ['Prefers metric units and 24-hour time.', 'distilled', 'preference', 20, false, false, 9, 3],
  ['Running the Vienna half marathon on 19 Oct 2026, goal under 1:55.', 'distilled', 'schedule', 10, false, false, 5, 2],
  ['Left knee gets sore after long runs; ices it and skips downhill repeats.', 'Personal Obsidian', 'health', 6, false, true, 3, 1],
  ['Trip to Lisbon with Ana, 24 to 28 Oct 2026.', 'Personal Obsidian', 'schedule', 6, false, false, 2, 0],
  ['Northwind pays €95/hour, invoiced monthly, net 30.', 'Work Obsidian', 'finance', 12, false, false, 6, 4],
  ['Halden Bikes shop rebuild: demo 15 Oct, launch 15 Nov 2026.', 'Work Obsidian', 'project', 8, false, false, 2, 0],
  ['Kestrel Labs retainer: 8 hours a month for €760.', 'Work Obsidian', 'work', 15, false, false, 4, 2],
  ['Backs up photos to a Synology NAS at home.', 'Personal Obsidian', 'other', 30, false, false, 1, 0],
  ['Likes answers short, with the recommendation first.', 'distilled', 'preference', 18, false, false, 20, 11],
  ['Long runs on Saturday mornings along the Donaukanal.', 'distilled', 'schedule', 9, false, false, 4, 2]
];

const SKILLS: Array<[string, string, string, string]> = [
  ['northwind-invoice-draft', 'Draft the monthly Northwind invoice from logged hours and the 2026 rates note.', 'learn',
    "1. Read `Admin/Rates 2026.md` in Work Obsidian for the hourly rate.\n2. Sum the hours from the month's Northwind notes.\n3. Number the invoice after the newest file in Invoices/2026.\n4. Write the draft as Markdown; net 30, EUR, no VAT line (reverse charge)."],
  ['argo-cd-image-drift', 'Find images in the Argo CD repo that differ between staging and production values.', 'assistant',
    '1. List `apps/*/values.yaml`.\n2. Compare `image.tag` per app across environments.\n3. Report only the apps that differ, newest tag first.'],
  ['meeting-notes-to-actions', 'Turn a client meeting note into owners, dates and open questions.', 'user-requested',
    'Read the note. List actions as `owner: action (date)`. Put anything without an owner under Open questions. Keep it to one screen.'],
  ['long-run-kit', 'Decide what to wear and bring for a Saturday long run from the forecast.', 'recorded',
    'Look up the hourly forecast for the run window. Below 8 °C: long sleeves and gloves. Rain over 40%: cap. Over 16 km: two gels and water.']
];

// [chat name, prompt, follow-up in the same chat?, chat folder path]
const TURNS: Array<[string, string, boolean, string | null]> = [
  ['2026 billing by client', 'Chart my 2026 billing per client by month from the Invoices folder, then compare the three clients side by side: rate, hours billed, and how fast they pay.', false, 'Admin'],
  ['Northwind cutover: what is left', 'What did I promise Northwind, and what is left before the staging cutover?', false, 'Clients/Northwind'],
  ['', 'Diagram how dispatch-api gets deployed, from the Argo CD repo to the staging namespace.', true, null],
  ['Halden Bikes: Checkout vs Payment Element', 'For the Halden Bikes shop rebuild, compare Stripe Checkout with the Payment Element and recommend one.', false, 'Clients/Halden Bikes'],
  ['Dinner for two, no peanuts', 'Dinner for Ana and me tonight, 30 minutes, from a normal Vienna supermarket.', false, null],
  ['Donaukanal long-run poster', "Make me a risograph-style poster for Saturday's long run along the Donaukanal: 18 km, 7:30 start.", false, null],
  ['Half marathon splits', 'Pace and splits for my half marathon goal, per 5 km.', false, 'Personal']
];

/** The last few firings of a weekly/daily cron, newest first, strictly in the past. */
function pastRuns(hour: number, minute: number, days: number[], count: number): Array<{ at: string; status: 'ok' }> {
  const out: Array<{ at: string; status: 'ok' }> = [];
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  for (let i = 0; i < 60 && out.length < count; i++) {
    if (d.getTime() < Date.now() && days.includes(d.getDay())) out.push({ at: d.toISOString(), status: 'ok' });
    d.setDate(d.getDate() - 1);
  }
  return out;
}

function writeStatic(folderIds: Record<string, string>, personaIds: Record<string, string>): void {
  const db = new DatabaseSync(join(PROFILE, 'recall.sqlite'));
  const ins = db.prepare(`INSERT OR IGNORE INTO facts (text, norm, source, category, sensitivity, confidence, status, pinned, created_at, updated_at, times_injected, times_used)
    VALUES (?, ?, ?, ?, ?, 0.9, 'active', ?, ?, ?, ?, ?)`);
  const now = Math.floor(Date.now() / 1000);
  for (const [text, src, cat, age, pinned, sensitive, injected, used] of FACTS) {
    const source = folderIds[src] ? `folder:${folderIds[src]}` : src;
    const norm = text.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:\s]+$/g, '').trim();
    const t = now - age * 86400;
    ins.run(text, norm, source, cat, sensitive ? 'sensitive' : 'standard', pinned ? 1 : 0, t, t, injected, used);
  }
  db.close();

  const task = (title: string, prompt: string, expr: string, runsAs: object, runs: Array<{ at: string; status: 'ok' }>) => ({
    id: randomUUID(),
    threadId: `demo-${randomUUID()}`,
    prompt,
    schedule: { kind: 'cron', expr },
    enabled: true,
    createdAt: '2026-09-14T09:00:00.000Z',
    lastRunAt: runs[0]?.at,
    lastStatus: 'ok',
    title,
    runsAs,
    recentRuns: runs
  });
  const tasks = [
    task('Overdue invoices', 'Check the Invoices folder for anything unpaid past its due date. Mail me only if something is overdue, with a short reminder draft for each.',
      '0 9 * * 1', { kind: 'persona', personaId: personaIds.Bookkeeper }, pastRuns(9, 0, [1], 3)),
    task('Argo CD drift', 'Compare the Argo CD repo with what Northwind and Halden Bikes were promised in Work Obsidian. Mail me only when something drifted.',
      '30 8 * * 1-5', { kind: 'persona', personaId: personaIds.Ops }, pastRuns(8, 30, [1, 2, 3, 4, 5], 3)),
    task('Long-run weather', 'Every Friday evening, check the Vienna forecast for Saturday 7:00 to 10:00 along the Donaukanal and tell me what to wear.',
      '0 18 * * 5', { kind: 'default' }, pastRuns(18, 0, [5], 2)),
    task('Friday week in review', "Look back over this week's chats and mail. Give me a short review: what got done, loose ends, and what I promised someone.",
      '0 17 * * 5', { kind: 'default' }, pastRuns(17, 0, [5], 2))
  ];
  writeFileSync(join(PROFILE, 'tasks.json'), JSON.stringify({ version: 2, tasks }, null, 2));

  for (const [slug, description, origin, body] of SKILLS) {
    const dir = join(PROFILE, 'pi-home', 'skills', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      [
        '---', `name: ${JSON.stringify(slug)}`, `description: ${JSON.stringify(description)}`, 'metadata:', '  stem:',
        `    source: ${origin === 'user-requested' ? 'user' : 'agent'}`, `    origin: ${JSON.stringify(origin)}`, '    version: 1',
        `    created: "2026-09-20T10:00:00.000Z"`, `    updated: "2026-10-08T10:00:00.000Z"`, '---', '', body, ''
      ].join('\n')
    );
  }
}

async function runSeed(): Promise<void> {
  for (const f of FOLDERS) if (!existsSync(join(MAYA, f.name))) throw new Error(`missing demo folder ${join(MAYA, f.name)}`);
  if (existsSync(join(PROFILE, 'recall.sqlite'))) throw new Error(`${PROFILE} is already seeded; move it away to reseed`);
  if (await cdpUp()) throw new Error(`something already listens on :${PORT}; seed needs its own instance`);

  // Reuse the signed-in profile's recall models (APFS clone, read-only source) so
  // the instance doesn't download them. Missing ones download on first use.
  const realModels = join(APP_DATA, 'stem', 'embed-models');
  for (const m of ['onnx-community', GTE_MODEL_VERSION]) {
    if (existsSync(join(realModels, m)) && !existsSync(join(PROFILE, 'embed-models', m))) {
      mkdirSync(join(PROFILE, 'embed-models'), { recursive: true });
      cpSync(join(realModels, m), join(PROFILE, 'embed-models', m), { recursive: true, mode: constants.COPYFILE_FICLONE });
    }
  }

  // 1. Config through the app: folders, personas, MCP servers.
  await launch();
  let main = await page('main');
  const ids = (await main.eval(`
    const s = window.stem;
    const folders = ${JSON.stringify(FOLDERS)};
    const added = await s.addConnectedFolders(folders.map((f) => ${JSON.stringify(MAYA)} + '/' + f.name));
    const folderIds = {};
    for (const f of folders) { const row = added.find((a) => a.label === f.name); folderIds[f.name] = row.id; await s.updateConnectedFolder(row.id, f.patch); }
    const personaIds = {};
    for (const p of ${JSON.stringify(PERSONAS)}) { const id = crypto.randomUUID(); await s.savePersona({ id, ...p }); personaIds[p.name] = id; }
    await s.addMcpServer({ name: 'git', transport: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', ${JSON.stringify(MAYA + '/My App Source')}] });
    await s.addMcpServer({ name: 'context7', transport: 'http', url: 'https://mcp.context7.com/mcp' });
    return { folderIds, personaIds };`)) as { folderIds: Record<string, string>; personaIds: Record<string, string> };
  main.close();
  await stop();

  // 2. Facts, tasks and skills straight into the stores, with the app stopped.
  writeStatic(ids.folderIds, ids.personaIds);

  // 3. Live content: chats, mail, the deep check, the summary.
  await launch();
  main = await page('main');
  for (const [name, prompt, followUp] of TURNS) {
    console.log(`turn: ${prompt.slice(0, 60)}…`);
    await main.eval(`
      ${followUp ? '' : "btn('New conversation').click(); await sleep(1200);"}
      await send(${JSON.stringify(prompt)}); await waitIdle();
      ${name ? `const c = (await window.stem.listChats()).chats.sort((a, b) => b.createdAt - a.createdAt)[0]; await window.stem.renameChat(c.threadId, ${JSON.stringify(name)});` : ''}`);
  }
  console.log('chat folders…');
  await main.eval(`
    const s = window.stem;
    const want = ${JSON.stringify(TURNS.filter((t) => t[3]).map((t) => [t[0], t[3]]))};
    const folderId = async (path) => {
      let parent = null;
      for (const name of path.split('/')) {
        let f = (await s.listChats()).folders.find((x) => x.name === name && x.parentId === parent);
        if (!f) { await s.createFolder(name, parent); f = (await s.listChats()).folders.find((x) => x.name === name && x.parentId === parent); }
        parent = f.id;
      }
      return parent;
    };
    const chats = (await s.listChats()).chats;
    for (const [name, path] of want) await s.setChatFolder(chats.find((c) => c.title === name).threadId, await folderId(path));`);

  console.log('mail…');
  await main.eval(`
    const s = window.stem; const ps = await s.listPersonas(); const id = (n) => ps.find((p) => p.name === n).id;
    await s.composeMail({ to: [id('Researcher')], subject: 'k3s vs Talos on Hetzner', body: 'Northwind wants a second cluster on Hetzner next year. Should I stay on k3s or move to Talos? Short answer first.' });
    await s.composeMail({ to: [id('Bookkeeper')], body: 'Which invoices are overdue? Draft a short, friendly reminder for each one.' });
    await s.composeMail({ to: [id('Secretary')], subject: 'Halden Bikes demo on 15 Oct', body: 'Get me ready for the Halden Bikes demo on Thursday. I need to know whether the shop app in the Argo CD repo matches what we promised, what is still unbilled for Halden, and a short status note I can send them. Split it up however you like.' });
    await s.startMemoryCheck();
    for (let i = 0; i < 900; i++) {
      await sleep(2000);
      const convs = (await s.listMail()).conversations;
      const job = await s.memoryCheckJob();
      if (convs.length >= 4 && convs.every((c) => c.status === 'idle') && !job?.running) break;
    }
    const prof = await s.getUserProfile();
    if (!prof?.text) await s.rewriteUserProfile();`);
  main.close();
  await stop();
  console.log(`seeded ${PROFILE}`);
}

// ---------------------------------------------------------------- main

const [cmd = 'shoot', ...rest] = process.argv.slice(2);
process.on('SIGINT', () => {
  child?.kill('SIGTERM');
  process.exit(130);
});
try {
  if (cmd === 'seed') await runSeed();
  else if (cmd === 'shoot') await runShoot(rest);
  else throw new Error(`usage: capture-readme-shots.mts [seed | shoot [shot…]]`);
} catch (err) {
  await stop();
  console.error(err);
  process.exit(1);
}
