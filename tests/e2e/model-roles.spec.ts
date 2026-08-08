// Settings → Models, driven for real: the model you chat with has to reach the
// server, and the shared background model has to be storable.
//
// This is the regression that started the whole roles list. `defaults.model` was
// written ONCE at sign-in and never again, while the model you actually chat
// with lived only in the renderer's localStorage — so every background job (chat
// subjects, memory, skills curation, the safety check) ran forever on whatever
// the wizard picked, and Quick Chat's "Same as main" confidently named it. None
// of that is visible from a unit test: the write-through lives in an App effect,
// and what it writes is only interesting once it has crossed the IPC boundary.
import { test, expect, openSettings } from './electron';

type Defaults = { model: string | null; backgroundModel: string | null; backgroundEffort: string | null };

const readDefaults = (win: Parameters<typeof openSettings>[0]): Promise<Defaults> =>
  win.evaluate(() =>
    (
      window as unknown as { stem: { getSettings(): Promise<{ defaults: Defaults }> } }
    ).stem.getSettings().then((s) => s.defaults)
  );

test('the model you chat with reaches the server, where background jobs can see it', async ({
  mainWindow
}) => {
  await openSettings(mainWindow, 'Models');

  // The picker shows it; the store has to agree, or "same as main" is a guess.
  await expect(mainWindow.getByLabel('Model', { exact: true })).toContainText('Stem E2E model');
  await expect.poll(async () => (await readDefaults(mainWindow)).model).toBe('e2e/stem-e2e-model');
});

test('the background model is its own setting, and starts unset', async ({ mainWindow }) => {
  await openSettings(mainWindow, 'Models');

  // Unset = the four background roles follow the model you chat with, which is
  // what their pickers say. Nothing is guessed on your behalf.
  const picker = mainWindow.getByLabel('Background work model', { exact: true });
  await expect(picker).toContainText('Same as main');
  expect((await readDefaults(mainWindow)).backgroundModel).toBeNull();

  await picker.click();
  await mainWindow.getByRole('option', { name: 'Stem E2E model' }).click();

  await expect.poll(async () => (await readDefaults(mainWindow)).backgroundModel).toBe('e2e/stem-e2e-model');
  // …and setting it must not clobber the model you chat with, which is patched
  // from a different place on every model change.
  expect((await readDefaults(mainWindow)).model).toBe('e2e/stem-e2e-model');
});

test('each role falls back to its own group, and memory is not in the cheap one', async ({
  mainWindow
}) => {
  await openSettings(mainWindow, 'Models');

  for (const role of ['Subject model', 'Safety-check model', 'Skills curator model']) {
    await expect(mainWindow.getByLabel(role, { exact: true })).toContainText('Background work');
  }
  // Two exceptions, for opposite reasons. You read Quick Chat's output, so it
  // follows the model you chat with. Memory follows it because it CANNOT be
  // made cheap safely — it reads whole transcripts, and a model too small to
  // hold one stops learning without erroring. Routing it through Background
  // work would let "make the background cheap" silently break memory, which is
  // exactly what this list is meant to make visible.
  await expect(mainWindow.getByLabel('Quick Chat default model', { exact: true })).toContainText('Same as main');
  await expect(mainWindow.getByLabel('Memory model', { exact: true })).toContainText('Same as main');
});

test('effort is a setting on the two roles that chose a model, and it persists', async ({
  mainWindow
}) => {
  await openSettings(mainWindow, 'Models');

  // Unset everywhere = what every background job did before this existed: the
  // model's own default, chosen by pi rather than by anyone.
  expect((await readDefaults(mainWindow)).backgroundEffort).toBeNull();
  const background = mainWindow.getByLabel('Background work effort', { exact: true });
  await expect(background).toHaveValue('');

  await background.selectOption('low');
  await expect.poll(async () => (await readDefaults(mainWindow)).backgroundEffort).toBe('low');
  // Same patch as the background MODEL — one must not blank the other.
  expect((await readDefaults(mainWindow)).backgroundModel).toBeNull();

  // Memory keeps its own, because it is not on the background chain at all.
  await mainWindow.getByLabel('Memory effort', { exact: true }).selectOption('high');
  await expect
    .poll(() =>
      mainWindow.evaluate(() =>
        (window as unknown as { stem: { getSettings(): Promise<{ memory: { effort: string | null } }> } })
          .stem.getSettings()
          .then((s) => s.memory.effort)
      )
    )
    .toBe('high');
  expect((await readDefaults(mainWindow)).backgroundEffort).toBe('low');
});
