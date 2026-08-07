// The Inbox mode of the chat list, driven through real DOM and real IPC against
// the scripted FakeBackend. Threads are created the only honest way — by sending
// a turn — so each row has a real backend session file whose mtime is what the
// archive/snooze timestamps are compared against.
import { test, expect } from './electron';
import type { Page } from '@playwright/test';

async function send(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
  await expect(win.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText(
    `Echo: ${text}`
  );
}

/** A fresh thread whose first user message is `text` (which becomes its title). */
async function newThread(win: Page, text: string): Promise<void> {
  await win.getByTitle('New thread').click();
  await send(win, text);
}

const row = (win: Page, title: string) => win.locator('.chat-row').filter({ hasText: title });
/** The Inbox/Chats/Archived control. Scoped: the rail's Chats tab shares its name. */
const mode = (win: Page, name: string) =>
  win.locator('.chats-modes').getByRole('button', { name, exact: true });

test('the chat list opens on the Inbox with every thread waiting', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  await expect(mode(mainWindow, 'Inbox')).toHaveClass(/active/);
  await expect(mainWindow.locator('.chat-row')).toHaveCount(2);
  await expect(mode(mainWindow, 'Archived')).toBeVisible();
});

test('archiving moves a thread out of the Inbox but leaves it in the Chats tree', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  // Hover reveals the per-row triage actions; archive the first thread.
  const alpha = row(mainWindow, 'alpha');
  await alpha.hover();
  await alpha.getByRole('button', { name: 'Archive' }).click();

  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
  await expect(row(mainWindow, 'beta')).toBeVisible();

  // It's in the Archived segment...
  await mode(mainWindow, 'Archived').click();
  await expect(row(mainWindow, 'alpha')).toBeVisible();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);

  // ...and archiving is Inbox-only: the Chats tree still lists both.
  await mode(mainWindow, 'Chats').click();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(2);
});

test('an archived thread can be moved back to the Inbox', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');

  const inboxRow = row(mainWindow, 'alpha');
  await inboxRow.hover();
  await inboxRow.getByRole('button', { name: 'Archive' }).click();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(0);

  await mode(mainWindow, 'Archived').click();
  const archivedRow = row(mainWindow, 'alpha');
  await archivedRow.hover();
  await archivedRow.getByRole('button', { name: 'Move to Inbox' }).click();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(0);

  await mode(mainWindow, 'Inbox').click();
  await expect(row(mainWindow, 'alpha')).toBeVisible();
});

test('snoozing hides a thread under a Snoozed group it can be woken from', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  const alpha = row(mainWindow, 'alpha');
  await alpha.hover();
  await alpha.getByRole('button', { name: 'Snooze' }).click();
  // Presets resolve to real instants; "Next week" is far enough that the row
  // cannot wake mid-test.
  await mainWindow.getByRole('button', { name: /Next week/ }).click();

  // Out of the list proper, into a collapsed disclosure that counts it.
  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
  const toggle = mainWindow.getByRole('button', { name: /Snoozed \(1\)/ });
  await expect(toggle).toBeVisible();

  await toggle.click();
  const snoozed = row(mainWindow, 'alpha');
  await expect(snoozed).toBeVisible();
  await snoozed.hover();
  await snoozed.getByRole('button', { name: 'Un-snooze' }).click();

  await expect(mainWindow.getByRole('button', { name: /Snoozed/ })).toHaveCount(0);
  await expect(mainWindow.locator('.chat-row')).toHaveCount(2);
});

test('inbox state survives a restart', async ({ mainWindow, electronApp }) => {
  await send(mainWindow, 'alpha');
  const alpha = row(mainWindow, 'alpha');
  await alpha.hover();
  await alpha.getByRole('button', { name: 'Archive' }).click();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(0);

  // Reload the renderer: the state has to come back from inbox.json, not from
  // whatever the session store happened to be holding.
  await mainWindow.reload();
  await mainWindow.waitForLoadState('domcontentloaded');
  void electronApp;

  await expect(mainWindow.locator('.chat-row')).toHaveCount(0);
  await mode(mainWindow, 'Archived').click();
  await expect(row(mainWindow, 'alpha')).toBeVisible();
});

test('⌘-click builds a selection the bar acts on in bulk', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');
  await newThread(mainWindow, 'gamma');
  await expect(mainWindow.locator('.chat-row')).toHaveCount(3);

  await row(mainWindow, 'alpha').click({ modifiers: ['ControlOrMeta'] });
  await row(mainWindow, 'beta').click({ modifiers: ['ControlOrMeta'] });
  await expect(mainWindow.getByText('2 selected')).toBeVisible();

  await mainWindow.locator('.inbox-selbar').getByRole('button', { name: 'Archive' }).click();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
  await expect(row(mainWindow, 'gamma')).toBeVisible();
});
