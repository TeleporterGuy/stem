// Share links e2e (docs/public-share-design.md): the dialog opens from an
// answer's hover actions, offers the three scopes, previews exactly what would
// be published, and without a verified address explains why instead of
// publishing. The upload itself is covered by tests/unit/share.test.ts and the
// relay's share_test.go.
import { test, expect } from './electron';
import type { Page } from '@playwright/test';

async function send(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
}

test('previews an answer and asks for a verified address before sharing', async ({ mainWindow }) => {
  test.setTimeout(120_000);
  await send(mainWindow, 'Reply with exactly the single word SHAREME and nothing else.');
  const reply = mainWindow.locator('.message-assistant:not(.activity-row)').last();
  await expect(reply.locator('.message-body')).toContainText(/shareme/i, { timeout: 60_000 });

  await reply.hover();
  await reply.getByLabel('Share this answer as a link').click();
  const dialog = mainWindow.getByRole('dialog', { name: 'Share as a link' });
  await expect(dialog).toBeVisible();
  const preview = dialog.locator('.share-preview');
  // Question and answer is the default.
  await expect(dialog.getByRole('radio', { name: 'Question and answer' })).toHaveAttribute('aria-checked', 'true');
  await expect(preview).toContainText(/shareme/i);
  await expect(preview.locator('.message-user')).toHaveCount(1);
  await dialog.getByRole('radio', { name: 'Answer only' }).click();
  await expect(preview.locator('.message-user')).toHaveCount(0);
  await expect(preview.locator('.message-assistant')).toHaveCount(1);
  await dialog.getByRole('radio', { name: 'Whole chat' }).click();
  await expect(preview.locator('.message-user')).toHaveCount(1);
  await expect(dialog.getByLabel('Expiry')).toHaveValue('30');
  // The link preview is on, filled from the chat, and editable.
  await expect(dialog.getByLabel('Preview title')).toHaveValue(/Reply with exactly/);
  await expect(dialog.getByLabel('Preview description')).toHaveValue(/SHAREME/);
  await dialog.getByLabel('Preview title').fill('Môj nadpis');
  await expect(dialog.getByLabel('Preview title')).toHaveValue('Môj nadpis');
  await expect(dialog).toContainText('Sharing needs a verified email address');
  await expect(dialog.getByRole('button', { name: 'Verify an address in Settings' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create link' })).toBeDisabled();
  await dialog.getByRole('radio', { name: 'Question and answer' }).click();
  await mainWindow.screenshot({ path: test.info().outputPath('share-dialog.png') });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});
