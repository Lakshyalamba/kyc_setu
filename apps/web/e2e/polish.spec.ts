/**
 * The finish: pages that are not the happy path look like the rest of the product, the colours follow the system theme, and a
 * form that is wrong says so next to the field, not as a block of JSON.
 */
import { expect, test } from '@playwright/test';
import { newEmail, signUp } from './helpers';

test('an unknown address gets the product’s own 404, with a way back', async ({ page }) => {
  const res = await page.goto('/this-page-does-not-exist');
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId('not-found')).toContainText('We can’t find that page');
  await page.getByRole('link', { name: 'Go to the start' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test.describe('dark mode', () => {
  test.use({ colorScheme: 'dark' });

  test('follows the system setting: a dark page with light text, on the customer and staff doors alike', async ({
    page,
  }) => {
    for (const url of ['/login', '/officer/login', '/this-page-does-not-exist']) {
      await page.goto(url);
      const { bg, fg } = await page.evaluate(() => {
        const cs = getComputedStyle(document.body);
        return { bg: cs.backgroundColor, fg: cs.color };
      });
      // Browsers report oklch() backgrounds as `oklch(...)` or `color(srgb ...)`; either way, read the lightness.
      const lightness = (c: string) => {
        const m = /oklch\(\s*([\d.]+)/.exec(c);
        if (m) return Number(m[1]);
        const rgb = c
          .match(/[\d.]+/g)
          ?.slice(0, 3)
          .map(Number) ?? [0, 0, 0];
        const scale = c.startsWith('color(') ? 1 : 255;
        return (0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!) / scale;
      };
      expect(lightness(bg), `${url} background ${bg}`).toBeLessThan(0.35);
      expect(lightness(fg), `${url} text ${fg}`).toBeGreaterThan(0.75);
    }
  });
});

test('a form that is not filled in says so next to each field, in words', async ({ page }) => {
  const email = newEmail();
  await signUp(page, email);
  await page.getByRole('button', { name: 'Start KYC' }).click();
  await expect(page).toHaveURL(/\/kyc\/contact$/);
  await page.getByLabel('Mobile number').fill('12345');
  await page.getByLabel('Email address').fill('not-an-email');
  await page.getByRole('button', { name: 'Send OTP' }).click();

  const main = page.locator('main');
  await expect(main.getByText(/valid.*mobile|10-digit/i).first()).toBeVisible();
  await expect(main.getByText(/valid.*email/i).first()).toBeVisible();
  // No raw JSON, and no zod boilerplate, anywhere on the page.
  const text = await main.innerText();
  expect(text).not.toMatch(/[{}[\]]|Invalid input|expected string/);
});
