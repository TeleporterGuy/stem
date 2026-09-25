// Drives a built stem-computer helper through window mode, by hand, on a Mac
// whose terminal has Screen Recording and Accessibility: list the windows,
// select TextEdit (open it first, ideally on another Space), snapshot its
// controls, put text in the document, and save the window picture next to
// this script's output — while the app in front stays in front.
//
//   node scripts/build-mac-helper.mjs --host-arch --output /tmp/stem-computer
//   open -a TextEdit && node scripts/smoke-computer-helper.mjs /tmp/stem-computer [app] [text]
//
// Nothing here runs in CI: it needs the grants and a screen.
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [helperPath, appName = 'TextEdit', text = 'Hello from Stem window mode'] = process.argv.slice(2);
if (!helperPath) {
  console.error('usage: node scripts/smoke-computer-helper.mjs <path-to-stem-computer> [app] [text]');
  process.exit(1);
}

const frontmost = () =>
  execFileSync('osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'])
    .toString()
    .trim();

const helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, STEM_COMPUTER_TRACE: '1' } });
const lines = createInterface({ input: helper.stdout });
const waiting = new Map();
let nextId = 1;
lines.on('line', (line) => {
  const reply = JSON.parse(line);
  if (reply.event) return console.log('event', reply);
  waiting.get(reply.id)?.(reply);
  waiting.delete(reply.id);
});

function call(cmd, fields = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    helper.stdin.write(JSON.stringify({ ...fields, id, cmd }) + '\n');
  });
}

function show(label, reply) {
  const { screenshot, text: t, ...rest } = reply;
  console.log(`\n== ${label}`, JSON.stringify(rest));
  if (t) console.log(t.split('\n').slice(0, 40).join('\n'));
  if (screenshot) {
    const file = `smoke-${label.replace(/\W+/g, '-')}.jpg`;
    writeFileSync(file, Buffer.from(screenshot.jpegBase64, 'base64'));
    console.log(`  picture ${screenshot.width}x${screenshot.height} → ${file}`);
  }
  if (!reply.ok) console.log('  FAILED:', reply.error);
  return reply;
}

const before = frontmost();
console.log('frontmost before:', before);
show('status', await call('status'));
show('list-windows', await call('list-windows'));
const selected = show('select-window', await call('select-window', { app: appName }));
if (selected.ok) {
  const snap = show('snapshot', await call('snapshot'));
  // The first settable text area/field is where the text goes.
  const match = snap.text?.match(/^\s*(\d+)\s+(textarea|textfield)\b.*\[.*setvalue/m);
  if (match) {
    const id = Number(match[1]);
    show('focus', await call('focus', { element: id }));
    show('set-value', await call('set-value', { element: id, text }));
    show('type', await call('type', { text: ' — and typed.' }));
  } else {
    console.log('\nno settable text field in the snapshot; skipping the text step');
  }
  show('screenshot', await call('screenshot'));
  show('clear', await call('select-window'));
}
await call('stop');
const after = frontmost();
console.log(`\nfrontmost after: ${after} ${after === before ? '(unchanged ✓)' : '(CHANGED ✗)'}`);
