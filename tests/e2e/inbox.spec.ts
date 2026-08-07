// The Inbox tab of the chat list, driven through real DOM and real IPC against
// the scripted FakeBackend. Threads are created the only honest way — by sending
// a turn — so each row has a real backend session whose mtime is what the
// archive/snooze timestamps are compared against, and whose first message is what
// the subject writer is handed.
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

/** A fresh thread whose first user message is `text`. */
async function newThread(win: Page, text: string): Promise<void> {
  await win.getByTitle('New thread').click();
  await send(win, text);
}

// The fake backend's canned subject is "About <first three words>", so a row
// still matches on the text it was started with.
const row = (win: Page, title: string) => win.locator('.chat-row').filter({ hasText: title });
/** The Inbox/Chats tabs. Scoped: the rail's Chats tab shares its name. */
const tab = (win: Page, name: string) =>
  win.locator('.chats-modes').getByRole('button', { name, exact: true });
const group = (win: Page, name: RegExp) => win.getByRole('button', { name });

test('the chat list opens on the Inbox with every thread waiting', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  await expect(tab(mainWindow, 'Inbox')).toHaveClass(/active/);
  await expect(mainWindow.locator('.chat-row')).toHaveCount(2);
});

test('the tab you were last on is the one that comes back', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await tab(mainWindow, 'Chats').click();
  await expect(tab(mainWindow, 'Chats')).toHaveClass(/active/);

  await mainWindow.reload();
  await mainWindow.waitForLoadState('domcontentloaded');
  await expect(tab(mainWindow, 'Chats')).toHaveClass(/active/);
});

test('a new thread gets a written subject, and the row renames itself', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  // Everywhere is the default: the subject becomes the thread's actual name, so
  // it shows in the Chats tree too, not only in the Inbox.
  await expect(row(mainWindow, 'About alpha')).toBeVisible();
  await tab(mainWindow, 'Chats').click();
  await expect(row(mainWindow, 'About alpha')).toBeVisible();
});

test('an Inbox row previews the newest message, until you turn previews off', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  // The preview follows the thread, so it is the assistant's reply that shows.
  await expect(mainWindow.locator('.chat-preview')).toHaveText(/Echo: alpha/);

  // Set it the way Settings does — persist, then tell the list to re-read.
  await mainWindow.evaluate(async () => {
    const w = window as any;
    await w.stem.updateChatsSettings({ previewLines: 0 });
    window.dispatchEvent(new CustomEvent('stem:chat-settings'));
  });
  await expect(mainWindow.locator('.chat-preview')).toHaveCount(0);
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

  // It's in the Archived group at the foot of the Inbox...
  await group(mainWindow, /Archived \(1\)/).click();
  await expect(row(mainWindow, 'alpha')).toBeVisible();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(2);

  // ...and archiving is Inbox-only: the Chats tree still lists both.
  await tab(mainWindow, 'Chats').click();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(2);
});

test('triaging the thread you are reading advances to the next one', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  // Rows are newest-first, so beta is both the open thread and the top row.
  const beta = row(mainWindow, 'beta');
  await beta.hover();
  await beta.getByRole('button', { name: 'Archive' }).click();

  await expect(row(mainWindow, 'alpha')).toHaveClass(/selected/);
  await expect(mainWindow.locator('.message-user').last()).toContainText('alpha');

  // Snoozing the one you land on advances the same way — and there is nothing
  // left to advance to, so you end up in a new chat, ready to write.
  const alpha = row(mainWindow, 'alpha');
  await alpha.hover();
  await alpha.getByRole('button', { name: 'Snooze' }).click();
  await mainWindow.getByRole('button', { name: /Next week/ }).click();

  await expect(mainWindow.locator('.message-user')).toHaveCount(0);
  await expect(mainWindow.locator('.chat-row.selected')).toHaveCount(0);
});

test('triaging a row you are not reading leaves the open thread alone', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  const alpha = row(mainWindow, 'alpha');
  await alpha.hover();
  await alpha.getByRole('button', { name: 'Archive' }).click();

  await expect(row(mainWindow, 'beta')).toHaveClass(/selected/);
  await expect(mainWindow.locator('.message-user').last()).toContainText('beta');
});

test('an archived thread can be moved back to the Inbox', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');

  const inboxRow = row(mainWindow, 'alpha');
  await inboxRow.hover();
  await inboxRow.getByRole('button', { name: 'Archive' }).click();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(0);

  await group(mainWindow, /Archived \(1\)/).click();
  const archivedRow = row(mainWindow, 'alpha');
  await archivedRow.hover();
  await archivedRow.getByRole('button', { name: 'Move to Inbox' }).click();

  await expect(mainWindow.getByRole('button', { name: /Archived/ })).toHaveCount(0);
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
  const toggle = group(mainWindow, /Snoozed \(1\)/);
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
  await group(mainWindow, /Archived \(1\)/).click();
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
