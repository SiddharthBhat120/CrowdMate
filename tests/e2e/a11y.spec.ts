import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addQueue, createEvent, joinQueue } from './helpers';

async function expectNoViolations(page: Page, where: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} element(s))`);
  expect(summary, `Accessibility problems on ${where}`).toEqual([]);
}

test('main screens pass an automated WCAG 2.2 AA check (light and dark)', async ({ browser }) => {
  const org = await createEvent(browser, 'College Fest');
  await addQueue(org.page, 'Registration');
  await expectNoViolations(org.page, 'organizer dashboard');

  for (const colorScheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ colorScheme });
    const page = await ctx.newPage();
    await page.goto('/');
    await expectNoViolations(page, `home (${colorScheme})`);
    await page.goto(`/e/${org.eventId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'College Fest' })).toBeVisible();
    await expectNoViolations(page, `event page (${colorScheme})`);
    await joinQueue(page, org.eventId, 'Registration', colorScheme);
    await expectNoViolations(page, `ticket (${colorScheme})`);
    await ctx.close();
  }

  await org.page.getByRole('link', { name: 'Open counter screen' }).click();
  await expect(org.page.locator('.waiting-list li')).toHaveCount(2);
  await expectNoViolations(org.page, 'counter screen');
});

test('a keyboard-only user can run the whole visitor flow', async ({ browser }) => {
  const org = await createEvent(browser, 'Keyboard Fair');
  await addQueue(org.page, 'Help desk');
  const page = await (await browser.newContext()).newPage();
  await page.goto('/');

  // Skip link is the first thing Tab reaches.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();

  await page.getByLabel('Event code').focus();
  await page.keyboard.type(org.eventId.toLowerCase()); // lowercase is accepted
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Keyboard Fair' })).toBeFocused();

  await page.getByRole('link', { name: 'Get a token' }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Your name (optional)').focus();
  await page.keyboard.type('Asha');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Token number 1')).toBeVisible();

  // The "leave" dialog traps focus and Esc closes it.
  await page.getByRole('button', { name: 'Leave the line' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Leave the line?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Leave the line' })).toBeFocused();
});
