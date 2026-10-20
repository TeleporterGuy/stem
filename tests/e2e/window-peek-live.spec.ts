// "Ask about this window" end to end, on a real desktop: the real shortcut is
// pressed over another app's window (sent as real input by the platform's
// computer helper), and Quick Chat must come up beside that window with it as
// a chip. Runs only when STEM_E2E_WINDOW_PEEK is set — on the Windows VM
// through `scripts/windows-vm.mjs desktop` (it opens Notepad itself).
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { closeApp, expect, launchApp, mainWindowOf, test } from './electron';

/** One command to a freshly built helper: the key press arrives as real input. */
function pressWithHelper(helper: string, combo: string): Promise<void> {
  const proc = spawn(helper, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: proc.stdout! });
  return new Promise((resolve, reject) => {
    lines.once('line', (line) => {
      const reply = JSON.parse(line) as { ok: boolean; error?: string };
      proc.stdin!.end('{"id":2,"cmd":"stop"}\n');
      if (reply.ok) resolve();
      else reject(new Error(reply.error));
    });
    proc.stdin!.write(`${JSON.stringify({ id: 1, cmd: 'key', combo, shot: false })}\n`);
  });
}

test('the window shortcut docks Quick Chat beside the window the user is in', async () => {
  test.skip(!process.env.STEM_E2E_WINDOW_PEEK || process.platform !== 'win32', 'set STEM_E2E_WINDOW_PEEK on a Windows desktop');
  test.setTimeout(120_000);
  const helper = join(mkdtempSync(join(tmpdir(), 'stem-helper-')), 'stem-computer.exe');
  execFileSync(process.execPath, ['scripts/build-windows-helper.mjs', '--output', helper], { stdio: 'ignore' });

  const launched = await launchApp({
    seedSettings: {
      onboarding: { completed: true },
      releaseNotes: { showOnUpdate: false, lastSeenVersion: null },
      quickChat: { windowShortcut: 'Control+Alt+W' }
    }
  });
  try {
    const win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');
    // Opened after Stem, so it is the window in front.
    spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref();
    await new Promise((r) => setTimeout(r, 3000));
    await pressWithHelper(helper, 'ctrl+alt+w');

    const overlayState = () =>
      launched.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('quickchat'));
        return { visible: w?.isVisible() ?? false, bounds: w?.getBounds() ?? null };
      });
    await expect.poll(async () => (await overlayState()).visible, { timeout: 20_000 }).toBe(true);
    const overlay = launched.app.windows().find((w) => w.url().includes('quickchat'))!;
    await expect(overlay.locator('.qc-input')).toHaveAttribute('placeholder', /Ask about this Notepad/i, { timeout: 20_000 });
  } finally {
    execFileSync('taskkill', ['/im', 'notepad.exe', '/f'], { stdio: 'ignore' });
    await closeApp(launched);
  }
});
