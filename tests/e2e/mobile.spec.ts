import { expect, test } from '@playwright/test';
import { addQueue, createEvent, joinQueue } from './helpers';

test('phone layout has no sideways scrolling and loads fast', async ({ page, browser }) => {
  const org = await createEvent(browser, 'Phone Fair');
  await addQueue(org.page, 'Snacks');

  const start = Date.now();
  await page.goto(`/e/${org.eventId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Phone Fair' })).toBeVisible();
  const firstPaint = await page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1);
  expect(firstPaint).toBeGreaterThan(0);
  expect(Date.now() - start).toBeLessThan(5000);

  for (const path of ['/', `/e/${org.eventId}`]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
  }

  await joinQueue(page, org.eventId, 'Snacks', 'Dev');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'test-results/phone-ticket.png', fullPage: true });
});
