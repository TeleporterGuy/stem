// Drives a computer-control helper (any platform's) through a list of commands
// from a JSON file and records what it answered: one line per reply in
// <out>/log.txt, each picture as <out>/<n>-<cmd>.jpg. For checking a helper
// by hand on a real desktop, e.g. the Windows VM's (scripts/windows-vm.mjs desktop).
//
//   node scripts/drive-helper.mjs <helper> <commands.json> <out-dir>
//
// commands.json: [{"cmd": "list-windows"}, {"sleep": 500}, {"cmd": "click", "x": 10, "y": 20}, …]
// A string in place of a command runs that program first (to open a window to work on).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [helperPath, commandsPath, out] = process.argv.slice(2);
if (!helperPath || !commandsPath || !out) {
  console.error('usage: node scripts/drive-helper.mjs <helper> <commands.json> <out-dir>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const logFile = join(out, 'log.txt');
writeFileSync(logFile, '');
const log = (line) => {
  appendFileSync(logFile, `${line}\n`);
  console.log(line);
};

const helper = spawn(helperPath, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, STEM_COMPUTER_TRACE: '1', STEM_PARENT_PID: String(process.pid) }
});
helper.stderr.on('data', (d) => log(`stderr ${d.toString().trim()}`));
const lines = createInterface({ input: helper.stdout });
const waiting = new Map();
let nextId = 1;
lines.on('line', (line) => {
  const reply = JSON.parse(line);
  if (reply.event) return log(`event ${JSON.stringify(reply)}`);
  waiting.get(reply.id)?.(reply);
  waiting.delete(reply.id);
});

const call = (cmd, fields) =>
  new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => resolve({ ok: false, error: 'no answer in 60s' }), 60_000);
    waiting.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    helper.stdin.write(`${JSON.stringify({ ...fields, id, cmd })}\n`);
  });

let n = 0;
for (const step of JSON.parse(readFileSync(commandsPath, 'utf8'))) {
  if (typeof step === 'string') {
    log(`run ${step}`);
    spawn(step, [], { detached: true, stdio: 'ignore', shell: true }).unref();
    continue;
  }
  if (step.sleep) {
    await new Promise((r) => setTimeout(r, step.sleep));
    continue;
  }
  const { cmd, ...fields } = step;
  const started = Date.now();
  const reply = await call(cmd, fields);
  n++;
  const { screenshot, text, ...rest } = reply;
  log(`== ${n} ${cmd} ${JSON.stringify(fields)} (${Date.now() - started} ms) ${JSON.stringify(rest)}`);
  if (text) log(text.split('\n').slice(0, 80).join('\n'));
  if (screenshot) {
    const file = join(out, `${n}-${cmd}.jpg`);
    writeFileSync(file, Buffer.from(screenshot.jpegBase64, 'base64'));
    log(`   picture ${screenshot.width}x${screenshot.height} → ${file}`);
  }
}
await call('stop', {});
