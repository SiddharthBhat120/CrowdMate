import { expect, test } from '@playwright/test';
import { addQueue, createEvent, joinQueue, waitForServiceWorker } from './helpers';

test('a ticket keeps working through a network drop and catches up', async ({ browser }) => {
  const org = await createEvent(browser, 'Book Fair');
  await addQueue(org.page, 'Billing');

  const ctx = await browser.newContext();
  const phone = await ctx.newPage();
  await joinQueue(phone, org.eventId, 'Billing', 'Kiran');
  const other = await (await browser.newContext()).newPage();
  await joinQueue(other, org.eventId, 'Billing', 'Lata');

  await ctx.setOffline(true);
  await expect(phone.getByRole('status').filter({ hasText: "You're offline" })).toBeVisible();
  await expect(phone.getByText(/Offline\. Last update/)).toBeVisible();

  // While Kiran's phone is offline, the counter calls Kiran.
  await org.page.goto(`/organize/${org.eventId}`);
  await org.page.getByRole('link', { name: 'Open counter screen' }).click();
  await org.page.getByRole('button', { name: /Call next/ }).click();
  await expect(org.page.locator('.counter-number')).toHaveText('1');

  // Back online: the phone reconnects by itself and shows the turn.
  await ctx.setOffline(false);
  await expect(phone.getByRole('article')).toContainText("It's your turn", { timeout: 15_000 });
  await expect(phone.getByText('Updating live')).toBeVisible();
});

test('joining while offline is saved and completes after reconnecting', async ({ browser }) => {
  const org = await createEvent(browser, 'Exam Hall');
  await addQueue(org.page, 'ID check');

  const ctx = await browser.newContext();
  const phone = await ctx.newPage();
  await phone.goto(`/e/${org.eventId}`);
  await phone.getByRole('link', { name: 'Get a token' }).click();
  await expect(phone.getByRole('heading', { level: 1, name: 'ID check' })).toBeVisible();

  await ctx.setOffline(true);
  await phone.getByRole('button', { name: 'Get my token' }).click();
  await expect(phone.getByText(/request is saved on this phone/)).toBeVisible();

  await ctx.setOffline(false);
  await expect(phone).toHaveURL(new RegExp(`/ticket/${org.eventId}/`), { timeout: 15_000 });
  await expect(phone.getByLabel('Token number 1')).toBeVisible();
});

test('the app opens with no network at all after the first visit (service worker)', async ({ browser }) => {
  const org = await createEvent(browser, 'Night Market');
  await addQueue(org.page, 'Juice bar');

  const ctx = await browser.newContext();
  const phone = await ctx.newPage();
  await joinQueue(phone, org.eventId, 'Juice bar', 'Sam');
  await waitForServiceWorker(phone);
  const ticketUrl = phone.url();

  await ctx.setOffline(true);
  await phone.reload();
  // Shell from the service worker, data from IndexedDB.
  await expect(phone.getByRole('article')).toContainText("You're next");
  await expect(phone.getByRole('status').filter({ hasText: "You're offline" })).toBeVisible();

  // Home screen also lists the token without network.
  await phone.goto('/');
  await expect(phone.getByRole('link', { name: /Token 1, Juice bar/ })).toBeVisible();
  await phone.goto(ticketUrl);
  await expect(phone.getByLabel('Token number 1')).toBeVisible();
});
