// A generate_image turn end to end against the scripted FakeBackend: the
// "Creating image…" card while the call runs, then the picture itself —
// fetched by ref over chats:image, never carried in the event — which opens
// full size and saves straight into Downloads.
import { test, expect } from './electron';
import type { Page } from '@playwright/test';

async function send(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
}

test('an image turn shows the placeholder, then the picture', async ({ mainWindow }, testInfo) => {
  await send(mainWindow, '[e2e:image] [e2e:slow] draw a test pattern');

  const pending = mainWindow.locator('.gen-image-pending');
  await expect(pending).toBeVisible();
  await expect(pending).toContainText('Creating image…');
  await mainWindow.screenshot({ path: testInfo.outputPath('pending.png') });

  const img = mainWindow.locator('.gen-image img');
  await expect(img).toBeVisible();
  await expect(pending).toHaveCount(0);
  expect(await img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  await expect(mainWindow.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText('Echo:');
  await mainWindow.screenshot({ path: testInfo.outputPath('done.png') });

  // Full size, and Escape closes it.
  await mainWindow.locator('.gen-image').click();
  const lightbox = mainWindow.getByRole('dialog');
  await expect(lightbox.locator('img')).toBeVisible();
  await mainWindow.screenshot({ path: testInfo.outputPath('lightbox.png') });
  await mainWindow.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);

  // Save to Downloads writes the file straight into Downloads, no dialog.
  await mainWindow.locator('.gen-image-wrap').hover();
  await mainWindow.getByRole('button', { name: 'Save image to Downloads' }).click();
  await expect(mainWindow.locator('.gen-image-flash')).toContainText('Saved to Downloads');
});

test('a reopened chat shows the picture again from history', async ({ mainWindow }) => {
  await send(mainWindow, '[e2e:image] draw a test pattern');
  await expect(mainWindow.locator('.gen-image img')).toBeVisible();
  await expect(mainWindow.getByTitle('Stop')).toHaveCount(0); // the reply is saved
  const history = await mainWindow.evaluate(async () => {
    const stem = (window as unknown as { stem: { listChats(): Promise<{ chats: Array<{ threadId: string }> }>; readChatHistory(id: string): Promise<{ messages: Array<{ images?: Array<{ id: string }> }> }> } }).stem;
    const [chat] = (await stem.listChats()).chats;
    const h = await stem.readChatHistory(chat.threadId);
    return h.messages.flatMap((m) => m.images ?? []).map((i) => i.id);
  });
  expect(history).toEqual(['img_e2e0000001']);
});

test('the picture shows with plain Markdown replies too', async ({ mainWindow }) => {
  const mdx = mainWindow.getByRole('group', { name: 'Output format' }).getByRole('button', { name: 'MDX' });
  await mdx.click(); // pressed = MDX, so one click switches to plain Markdown
  await expect(mdx).not.toHaveClass(/active/);
  await send(mainWindow, '[e2e:image] draw a test pattern');
  await expect(mainWindow.locator('.gen-image img')).toBeVisible();
  await expect(mainWindow.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText('Echo:');
});
