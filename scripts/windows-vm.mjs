#!/usr/bin/env node
// Run Stem on a Windows machine over SSH, the way scripts/linux-pc.mjs does on
// Linux: the working tree (uncommitted work included) is copied over and the
// command runs there. The machine needs OpenSSH with PowerShell as its shell,
// Node 24 on the user PATH, and Git for Windows.
//
//   STEM_WINDOWS_HOST   user@host[:port], e.g. stem@127.0.0.1:2222
//   STEM_WINDOWS_JUMP   optional jump host, e.g. join3r@192.168.1.164 (a VM
//                       whose ports are bound to that machine's loopback)
//
//   node scripts/windows-vm.mjs test [vitest args]      unit tests
//   node scripts/windows-vm.mjs e2e [playwright args]   the E2E suite
//   node scripts/windows-vm.mjs shell                   PowerShell in the copy
//   node scripts/windows-vm.mjs ps '<command>'          one PowerShell command there
//   node scripts/windows-vm.mjs desktop '<command>'     the same, inside the logged-in desktop
//                                                       session (real input, capture, UI Automation)
//   node scripts/windows-vm.mjs sync                    only copy and install
//
// Commands run in the SSH session, which has no interactive desktop: windows
// open and render, but nothing shows on the VM's screen, and input, screen
// capture and UI Automation of other apps do not work there. `desktop` runs
// its command in the console session instead, through an interactive
// scheduled task, and prints what it wrote; the user must be logged in.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.STEM_WINDOWS_HOST;
if (!target) {
  console.error('windows-vm: set STEM_WINDOWS_HOST (user@host[:port]), and STEM_WINDOWS_JUMP if it sits behind one');
  process.exit(2);
}
const [userHost, port = '22'] = target.split(/:(?=\d+$)/);
const jump = process.env.STEM_WINDOWS_JUMP;
const opts = [
  '-o', 'BatchMode=yes', '-o', 'VisualHostKey=no', '-o', 'StrictHostKeyChecking=accept-new',
  ...(jump ? ['-o', `ProxyCommand=ssh -o BatchMode=yes -o VisualHostKey=no -W %h:%p ${jump}`] : [])
];
const [mode = 'test', ...rest] = process.argv.slice(2);

function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...o });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// The tracked and untracked-but-not-ignored files, as one tarball; Windows'
// own tar.exe unpacks it.
const tmp = mkdtempSync(join(tmpdir(), 'stem-win-'));
const tarball = join(tmp, 'stem.tgz');
const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: repo });
if (files.status !== 0) process.exit(1);
run('tar', ['--null', '-T', '-', '-czf', tarball], { cwd: repo, input: files.stdout, stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
run('scp', ['-q', ...opts, '-P', port, tarball, `${userHost}:stem.tgz`]);
rmSync(tmp, { recursive: true, force: true });

// Runs on Windows. node_modules (the Windows builds of the native modules),
// dist and release (the last installer build) survive; everything else is
// replaced by the copy.
const prelude = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')
$dst = "$env:USERPROFILE\\stem"
New-Item -ItemType Directory -Force $dst | Out-Null
Get-ChildItem -Force $dst | Where-Object { $_.Name -notin 'node_modules','dist','release' } | Remove-Item -Recurse -Force
tar -xzf "$env:USERPROFILE\\stem.tgz" -C $dst
Remove-Item "$env:USERPROFILE\\stem.tgz"
Set-Location $dst
$want = (Get-FileHash package-lock.json -Algorithm SHA256).Hash
$have = if (Test-Path node_modules\\.stem-lock) { Get-Content node_modules\\.stem-lock } else { '' }
if ($have -ne $want) {
  Write-Output 'windows-vm: npm ci (lockfile changed)'
  cmd /c 'npm ci --no-audit --no-fund 2>&1'
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Set-Content node_modules\\.stem-lock $want
}
$ErrorActionPreference = 'Continue'
`;
const args = rest.map(psQuote).join(' ');
const body = {
  sync: '',
  test: `& npx.cmd vitest run ${args}; exit $LASTEXITCODE`,
  e2e: `& npx.cmd playwright test ${args}; exit $LASTEXITCODE`,
  shell: '',
  ps: `${rest.join(' ')}\nexit $LASTEXITCODE`,
  desktop: `
$log = "$env:TEMP\\stem-desktop.log"
Remove-Item "$log", "$log.done" -ErrorAction SilentlyContinue
$script = "$env:TEMP\\stem-desktop.ps1"
Set-Content $script ("Set-Location '$dst'" + [Environment]::NewLine + "$env:Path = '$env:Path'" + [Environment]::NewLine + "& { " + [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(rest.join(' ')).toString('base64')}')) + " } *> '$log'" + [Environment]::NewLine + "Set-Content '$log.done' $LASTEXITCODE")
$action = New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$script\`""
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName StemDesktop -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName StemDesktop
$deadline = (Get-Date).AddMinutes(20)
while (-not (Test-Path "$log.done") -and (Get-Date) -lt $deadline) { Start-Sleep 1 }
Get-Content $log -ErrorAction SilentlyContinue
$code = Get-Content "$log.done" -ErrorAction SilentlyContinue
exit [int]("0" + $code)`
}[mode];
if (body === undefined) {
  console.error('usage: windows-vm.mjs test|e2e|shell|sync|ps|desktop [args]');
  process.exit(2);
}

const ssh = ['-p', port, ...opts, userHost];
// -EncodedCommand, not a script on stdin: `powershell -Command -` stops at the
// first block that spans lines.
const encoded = (script) => `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
if (mode === 'shell') {
  run('ssh', [...ssh, encoded(prelude)]);
  run('ssh', ['-t', ...ssh, 'cd $env:USERPROFILE\\stem; powershell -NoProfile']);
} else {
  run('ssh', [...ssh, encoded(prelude + body)]);
}
