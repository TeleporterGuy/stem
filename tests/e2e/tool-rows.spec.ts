// Tool rows of a running turn live in that turn's one Stem row. A model that
// calls a tool before writing settles an empty text block first, which creates
// the turn's bubble early; the rows must move into it rather than show there as
// a settled "Used 1 tool" while a second Stem row below repeats them live.
import { test, expect } from './electron';

test('a running tool shows once, live, in the turn’s single Stem row', async ({ mainWindow }, testInfo) => {
  const composer = mainWindow.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill('[e2e:tools] [e2e:slow] run the loop');
  await composer.press('Enter');

  const live = mainWindow.locator('.activity-row-item.live');
  await expect(live).toContainText('for i in $(seq 1 10)');
  await expect(mainWindow.locator('.message-assistant .activity-row-item')).toHaveCount(1);
  await expect(mainWindow.locator('.activity-rows-summary')).toHaveCount(0);
  await mainWindow.screenshot({ path: testInfo.outputPath('live.png') });

  // The second call joins the same card, the first now settled above it.
  await expect(live).toContainText('notes.md');
  await expect(mainWindow.locator('.activity-card .activity-row-item')).toHaveCount(2);
  await expect(mainWindow.locator('.message-assistant')).toHaveCount(1);
  await mainWindow.screenshot({ path: testInfo.outputPath('second.png') });

  const reply = mainWindow.locator('.message-assistant:not(.activity-row) .message-body').last();
  await expect(reply).toContainText('Echo:');
  await expect(mainWindow.locator('.message-assistant.activity-row')).toHaveCount(0);
  const summary = mainWindow.locator('.activity-rows-summary');
  await expect(summary).toHaveText(/Used 2 tools/);
  await summary.click();
  await expect(mainWindow.locator('.activity-card .activity-row-item')).toHaveCount(2);
  await mainWindow.screenshot({ path: testInfo.outputPath('settled.png') });
});
