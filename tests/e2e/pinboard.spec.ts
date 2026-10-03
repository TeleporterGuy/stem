// Chat pinboard e2e (docs/chat-pinboard-plan.md): the strip under the chat
// header, its floating list and its docked ("Keep open") mode, driven in the
// real window against the scripted FakeBackend. Pins are made through the
// preload bridge here; the in-chat Pin action has its own spec once it lands.
import { test, expect } from './electron';
import type { Page } from '@playwright/test';

async function send(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
}

/** Pin the latest reply, a passage of it, and a note, through the bridge. */
async function seedPins(win: Page): Promise<void> {
  await win.evaluate(async () => {
    const stem = (window as any).stem;
    const { chats } = await stem.listChats();
    const threadId = chats[0].threadId as string;
    const { messages } = await stem.readChatHistory(threadId);
    const reply = [...messages].reverse().find((m: any) => m.role === 'assistant');
    const anchor = reply.runtimeTurnId ?? reply.turnId;
    await stem.addPin(threadId, { kind: 'message', text: reply.content, anchor, role: 'assistant' });
    await stem.addPin(threadId, {
      kind: 'passage',
      text: reply.content.split(' ').slice(0, 3).join(' '),
      anchor,
      role: 'assistant'
    });
    await stem.addPin(threadId, { kind: 'note', text: '2nd coat done Oct 3, wiped with a white pad' });
  });
}

test('the pinboard strip opens, floats, closes on an outside click, and docks', async ({ mainWindow: win }, testInfo) => {
  test.setTimeout(120_000);
  // No pins, no board.
  await send(win, 'Reply with exactly the word RUBIO and nothing else.');
  await expect(win.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText(/rubio/i, {
    timeout: 60_000
  });
  await expect(win.locator('.message-user').last().locator('.message-actions')).toBeAttached({ timeout: 20_000 });
  await expect(win.locator('.pinboard')).toHaveCount(0);

  await seedPins(win);

  // The push names this chat; the board appears collapsed with a count and summary.
  const strip = win.locator('.pinboard-strip');
  await expect(strip).toBeVisible();
  await expect(win.locator('.pinboard-count')).toHaveText('3');
  await expect(win.locator('.pinboard-summary')).toContainText('2nd coat done Oct');
  await expect(win.locator('.pinboard-drop')).toHaveCount(0);
  await win.screenshot({ path: testInfo.outputPath('1-collapsed.png') });

  // Open: the list floats over the transcript.
  await strip.click();
  await expect(win.locator('.pinboard-item')).toHaveCount(3);
  await win.screenshot({ path: testInfo.outputPath('2-open.png') });

  // A click in the transcript closes a floating board.
  await win.locator('.messages').click({ position: { x: 20, y: 300 } });
  await expect(win.locator('.pinboard-drop')).toHaveCount(0);

  // Jump: "Show in chat" scrolls to the source and flashes it, and closes the list.
  await strip.click();
  const messagePin = win.locator('.pinboard-item.kind-message');
  await messagePin.hover();
  await messagePin.getByLabel('Show in chat').click();
  await expect(win.locator('.message-assistant.pin-flash')).toHaveCount(1);
  await expect(win.locator('.pinboard-drop')).toHaveCount(0);

  // Docked: stays open through outside clicks, and survives a reload.
  await strip.click();
  await win.getByRole('button', { name: 'Keep open' }).click();
  await win.locator('.messages').click({ position: { x: 20, y: 300 } });
  await expect(win.locator('.pinboard.docked .pinboard-drop')).toBeVisible();
  await win.screenshot({ path: testInfo.outputPath('3-docked.png') });

  // A note: edit it, then remove it (a note takes a second click).
  const note = win.locator('.pinboard-item.kind-note');
  await note.hover();
  await note.getByLabel('Edit note').click();
  const editor = note.locator('textarea');
  await editor.fill('3rd coat skipped');
  await editor.press('Enter');
  await expect(note).toContainText('3rd coat skipped');
  await note.hover();
  await note.getByLabel('Remove note').click();
  await expect(win.locator('.pinboard-item')).toHaveCount(3);
  await note.getByLabel('Click again to remove').click();
  await expect(win.locator('.pinboard-item')).toHaveCount(2);

  // Add a note from the board.
  await win.getByRole('button', { name: 'Add note' }).click();
  await win.locator('.pinboard-editor textarea').fill('Buy more accelerator');
  await win.locator('.pinboard-editor textarea').press('Enter');
  await expect(win.locator('.pinboard-item.kind-note')).toContainText('Buy more accelerator');
  await expect(win.locator('.pinboard-count')).toHaveText('3');
});
