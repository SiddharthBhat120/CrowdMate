import { expect, test } from '@playwright/test';
import { addQueue, createEvent, joinQueue } from './helpers';

test('a visitor joins from their phone and is called live by the counter', async ({ browser }) => {
  const org = await createEvent(browser, 'Spring Fair');
  await addQueue(org.page, 'Food stall');

  // Two visitors on their own phones.
  const anuCtx = await browser.newContext();
  const anu = await anuCtx.newPage();
  await joinQueue(anu, org.eventId, 'Food stall', 'Anu');
  await expect(anu.getByRole('article')).toContainText("You're next");

  const ravCtx = await browser.newContext();
  const ravi = await ravCtx.newPage();
  await joinQueue(ravi, org.eventId, 'Food stall', 'Ravi');
  await expect(ravi.getByRole('article')).toContainText("You're 2nd in line");

  // Staff open the counter screen and see both names in order.
  await org.page.getByRole('link', { name: 'Open counter screen' }).click();
  await expect(org.page.getByRole('heading', { level: 1, name: 'Food stall' })).toBeVisible();
  const waiting = org.page.locator('.waiting-list li');
  await expect(waiting).toHaveCount(2);
  await expect(waiting.nth(0)).toContainText('Anu');
  await expect(waiting.nth(1)).toContainText('Ravi');

  // Keyboard shortcut N calls the next person. Anu's phone flips to "your turn".
  await org.page.keyboard.press('n');
  await expect(org.page.locator('.counter-number')).toHaveText('1');
  await expect(anu.getByRole('article')).toContainText("It's your turn");
  await expect(anu).toHaveTitle(/Your turn/);
  await expect(ravi.getByRole('article')).toContainText("You're next");

  // No-show: Anu missed it, Ravi is called and Anu can rejoin at the end.
  await org.page.getByRole('button', { name: /No-show/ }).click();
  await expect(ravi.getByRole('article')).toContainText("It's your turn");
  await expect(anu.getByRole('article')).toContainText('You missed your turn.');
  await anu.getByRole('button', { name: 'Join the line again' }).click();
  await expect(anu.getByLabel('Token number 3')).toBeVisible();

  // Pause: visitors keep their place and are told the counter is on a break.
  await org.page.keyboard.press('p');
  await expect(anu.getByRole('article')).toContainText('short break');
  await expect(org.page.getByRole('button', { name: /Call next/ })).toBeDisabled();
});

test('a phone can only hold one place per queue, even after reloading', async ({ browser }) => {
  const org = await createEvent(browser, 'Clinic');
  await addQueue(org.page, 'Doctor');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await joinQueue(page, org.eventId, 'Doctor', 'Meera');
  const ticketUrl = page.url();

  await page.goto(`/e/${org.eventId}`);
  await expect(page.getByRole('link', { name: 'View token 1' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'View token 1' })).toBeVisible();
  await page.goto(ticketUrl);
  await expect(page.getByLabel('Token number 1')).toBeVisible();
});

test('HTTP caching headers are set as designed', async ({ request, page }) => {
  await page.goto('/');
  const scripts = await page.locator('script[type="module"]').evaluateAll((els) => els.map((e) => (e as HTMLScriptElement).src));
  const asset = await request.get(scripts[0]!);
  expect(asset.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  const shell = await request.get('/');
  expect(shell.headers()['cache-control']).toBe('no-cache');
  expect(shell.headers()['content-security-policy']).toContain("default-src 'self'");
});
