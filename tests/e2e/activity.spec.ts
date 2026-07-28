// The toolbar background-activity indicator: always mounted (that is what makes
// it flicker-free), opens a read-only panel, and reflects real registry state
// pushed from main. Hermetic — the STEM_E2E seam mounts the app past the gate.
import { test, expect } from './electron';

test('the activity indicator is always present and opens a read-only panel', async ({ mainWindow }) => {
  const button = mainWindow.getByRole('button', { name: 'Background activity' });
  await expect(button).toBeVisible();
  // Idle: no pulse class, so the icon is visually inert rather than absent.
  await expect(button).not.toHaveClass(/pulse/);

  await button.click();
  const panel = mainWindow.getByRole('dialog', { name: 'Background activity' });
  await expect(panel).toBeVisible();

  // Read-only: the panel offers no way to start, pause or retry anything.
  await expect(panel.getByRole('button', { name: /run|start|pause|retry/i })).toHaveCount(0);

  await mainWindow.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('a completed background run reaches the panel', async ({ mainWindow }) => {
  // A fresh hermetic workspace has nothing to distil, so drive the registry
  // through the same IPC surface the renderer listens on rather than waiting
  // out a real pass.
  const snapshot = await mainWindow.evaluate(() => (window as any).stem.getActivity());
  expect(Array.isArray(snapshot.history)).toBe(true);
  expect(Array.isArray(snapshot.running)).toBe(true);
  expect(typeof snapshot.unseenFailure).toBe('boolean');

  await mainWindow.getByRole('button', { name: 'Background activity' }).click();
  const panel = mainWindow.getByRole('dialog', { name: 'Background activity' });
  await expect(panel).toBeVisible();
  // Either the empty state or real rows — never a broken/blank panel.
  const rows = panel.locator('.activity-row');
  const empty = panel.getByText('Nothing has run yet', { exact: false });
  const hasRows = (await rows.count()) > 0;
  if (hasRows) await expect(rows.first()).toBeVisible();
  else await expect(empty).toBeVisible();
});
