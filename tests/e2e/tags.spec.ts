import { expect, test } from '@playwright/test';
import { createEvent } from './helpers';

test('a stranger scans a lost child’s tag and the family is connected instantly', async ({ browser }) => {
  const org = await createEvent(browser, 'Temple Festival');

  // Family creates a tag on their phone.
  const familyCtx = await browser.newContext();
  const family = await familyCtx.newPage();
  await family.goto(`/e/${org.eventId}`);
  await family.getByRole('button', { name: 'Create a safety tag' }).click();
  await family.getByLabel('Who is this tag for?').fill('Aarav, 6, red T-shirt');
  await family.getByLabel('Anything a helper should know (optional)').fill('Speaks Kannada. Allergic to peanuts.');
  await family.getByRole('button', { name: 'Create safety tag' }).click();
  await expect(family.getByRole('heading', { level: 1, name: 'Aarav, 6, red T-shirt' })).toBeVisible();
  await expect(family.getByRole('img', { name: /QR code for Aarav/ })).toBeVisible();
  const tagUrl = family.url();
  const tagId = tagUrl.split('/').pop()!;

  // Family reports the child missing; staff see it on the lost and found board.
  await family.getByRole('button', { name: 'Report missing' }).click();
  await expect(family.getByRole('heading', { name: 'Marked as missing' })).toBeVisible();
  await org.page.getByRole('tab', { name: /Lost and found \(1\)/ }).click();
  await expect(org.page.getByRole('tabpanel')).toContainText('Aarav, 6, red T-shirt');
  await expect(org.page.getByRole('tabpanel')).toContainText('Missing');

  // A stranger finds Aarav and scans the tag (what the QR code opens).
  const finderCtx = await browser.newContext();
  const finder = await finderCtx.newPage();
  await finder.goto(`/f/${org.eventId}/${tagId}`);
  await expect(finder.getByRole('heading', { level: 1, name: 'You found someone who needs help' })).toBeVisible();
  await expect(finder.getByText('Aarav, 6, red T-shirt')).toBeVisible();
  // The private note is not shown before they commit to helping.
  await expect(finder.getByText('Allergic to peanuts')).toHaveCount(0);
  await finder.getByRole('button', { name: 'Alert their family' }).click();
  await expect(finder.getByRole('heading', { level: 1, name: 'Their family has been alerted' })).toBeVisible();
  await expect(finder.getByText('Allergic to peanuts')).toBeVisible();

  // The family's screen switches to "found" by itself.
  await expect(family.getByRole('heading', { name: 'Someone found Aarav' })).toBeVisible();

  // Chat both ways.
  await finder.getByLabel('Message to the family').fill('He is with me at the shoe stand near gate 2');
  await finder.getByRole('button', { name: 'Send' }).click();
  await expect(family.getByRole('log')).toContainText('He is with me at the shoe stand near gate 2');
  await family.getByLabel('Message to the helper').fill('Thank you! Coming now');
  await family.getByRole('button', { name: 'Send' }).click();
  await expect(finder.getByRole('log')).toContainText('Thank you! Coming now');

  // Staff can join the conversation from the board.
  await expect(org.page.getByRole('tabpanel')).toContainText('Found by a helper');
  await org.page.getByLabel('Message about Aarav, 6, red T-shirt').fill('Security is on the way to gate 2');
  await org.page.getByRole('button', { name: 'Send' }).click();
  await expect(family.getByRole('log')).toContainText('Event staff');

  // A second stranger who scans the same tag is told someone is already helping.
  const secondCtx = await browser.newContext();
  const second = await secondCtx.newPage();
  await second.goto(`/f/${org.eventId}/${tagId}`);
  await expect(second.getByRole('heading', { level: 1, name: 'Someone is already helping' })).toBeVisible();

  // Reunited: the conversation is deleted for privacy.
  await family.getByRole('button', { name: "We're together again" }).click();
  await family.getByRole('dialog').getByRole('button', { name: "Yes, we're together" }).click();
  await expect(family.getByRole('heading', { name: 'Print or show this tag' })).toBeVisible();
  await expect(org.page.getByRole('tabpanel')).toContainText('Nobody is missing');
  await expect(finder.getByRole('heading', { level: 1, name: "They're back with their family" })).toBeVisible();
});
