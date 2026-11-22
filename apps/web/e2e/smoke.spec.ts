import { expect, test } from '@playwright/test';

// Smoke e2e: the home page renders and next-intl locale routing works. Title
// (`home.title`) is shared across locales; the API-health heading is the
// locale-distinct string used to prove `/en` vs `/uk` switch the catalog.
test('renders the home page in English at /en', async ({ page }) => {
  await page.goto('/en');

  await expect(page).toHaveURL(/\/en$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1, name: 'ex-mio-games' })).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'API health', exact: true }),
  ).toBeVisible();
});

test('switches the catalog when visiting /uk', async ({ page }) => {
  await page.goto('/uk');

  await expect(page.locator('html')).toHaveAttribute('lang', 'uk');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Стан API', exact: true }),
  ).toBeVisible();
});
