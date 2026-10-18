// Builds native/windows/stem-computer (the C# helper behind computer control
// and "Ask about this window" on Windows) into build/native/stem-computer.exe.
//
// The compiler is the one every Windows ships with .NET Framework 4.8
// (Framework64\v4.0.30319\csc.exe, C# 5), so neither a dev machine nor CI needs
// an SDK. Two entry points like build-mac-helper.mjs: electron-builder's
// beforePack (scripts/build-native-helpers.mjs, Windows targets only) and a
// plain `node scripts/build-windows-helper.mjs [--output <path>]`, which the
// desktop app runs on demand in development (src/desktop/computer-host/helper.ts).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SOURCE_DIR = resolve(here, '..', 'native', 'windows', 'stem-computer');
export const OUTPUT = resolve(here, '..', 'build', 'native', 'stem-computer.exe');

export function sourceFiles() {
  return readdirSync(SOURCE_DIR)
    .filter((f) => f.endsWith('.cs'))
    .sort()
    .map((f) => join(SOURCE_DIR, f));
}

/** A hash of the sources, so a dev build can tell whether its binary is current. */
export function sourceHash() {
  const h = createHash('sha256');
  for (const file of sourceFiles()) h.update(readFileSync(file));
  return h.digest('hex').slice(0, 16);
}

function framework() {
  const root = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  if (!existsSync(join(root, 'csc.exe'))) throw new Error(`No C# compiler at ${root} (.NET Framework 4.8 is part of Windows 10 and 11).`);
  return root;
}

export function buildHelper({ output = OUTPUT, log = console.log } = {}) {
  const fw = framework();
  const refs = [
    'System.dll',
    'System.Core.dll',
    'System.Drawing.dll',
    'System.Web.Extensions.dll',
    join(fw, 'WPF', 'UIAutomationClient.dll'),
    join(fw, 'WPF', 'UIAutomationTypes.dll'),
    join(fw, 'WPF', 'WindowsBase.dll')
  ];
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  log(`[stem-computer] csc → ${output}`);
  execFileSync(
    join(fw, 'csc.exe'),
    ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${output}`, ...refs.map((r) => `/reference:${r}`), ...sourceFiles()],
    { stdio: 'inherit', windowsHide: true }
  );
  log(`[stem-computer] built ${output} (${statSync(output).size} bytes)`);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--output');
  buildHelper(at >= 0 && args[at + 1] ? { output: resolve(args[at + 1]) } : {});
}
