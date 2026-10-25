import { expect, type Browser, type Page } from '@playwright/test';

/** Create an event through the real home screen and return the organizer page. */
export async function createEvent(browser: Browser, name: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Event name').fill(name);
  await page.getByRole('button', { name: 'Create event' }).click();
  await expect(page).toHaveURL(/\/organize\/[A-Z2-9]{6}$/); // the key was removed from the address bar
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const eventId = page.url().split('/').pop()!;
  return { context, page, eventId };
}

export async function addQueue(organizer: Page, name: string, minutes = '2') {
  await organizer.getByLabel('Queue name').fill(name);
  await organizer.getByLabel('Minutes per person').fill(minutes);
  await organizer.getByRole('button', { name: 'Add queue' }).click();
  await expect(organizer.getByRole('heading', { level: 3, name })).toBeVisible();
}

/** A visitor phone that opens the event and takes a token. */
export async function joinQueue(page: Page, eventId: string, queueName: string, personName: string) {
  await page.goto(`/e/${eventId}`);
  const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: queueName }) });
  await card.getByRole('link', { name: 'Get a token' }).click();
  await expect(page.getByRole('heading', { level: 1, name: queueName })).toBeVisible();
  await page.getByLabel('Your name (optional)').fill(personName);
  await page.getByRole('button', { name: 'Get my token' }).click();
  await expect(page).toHaveURL(new RegExp(`/ticket/${eventId}/`));
  await expect(page.getByRole('article')).toBeVisible();
}

/** Wait until the page is controlled by the service worker (production build only). */
export async function waitForServiceWorker(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    }
  });
}
