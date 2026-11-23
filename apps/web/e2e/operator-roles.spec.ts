import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// A-SHOT-1 (docs: operator-ia-spec.md section 5): the operator console per role, in mock mode, with
// screenshots in docs/screens/operator-ia-*.png. Mock mode is a build-time switch, so run it as
//   NEXT_PUBLIC_MIO_API=mock pnpm --filter @ex-mio/web e2e operator-roles
// The role is client state in mock mode (the shell's Role picker). A link in the nav is a full page
// load, which resets the role to Admin, so a role is switched on the page and the guard's own redirect
// is what lands it.
//
// The expected nav entries are a literal table here, not read from the page registry.
const NAV: Record<'admin' | 'staff' | 'support', string[]> = {
  admin: ['Setup', 'Rules', 'Wheel', 'Store', 'Redemptions', 'Insights', 'Team'],
  staff: ['Store', 'Redemptions', 'Insights', 'Team'],
  support: ['Insights', 'Team'],
};

const SHOTS = path.resolve(__dirname, '../../../docs/screens');
const shot = (name: string) => path.join(SHOTS, `operator-ia-${name}.png`);

test.skip(
  process.env.NEXT_PUBLIC_MIO_API !== 'mock',
  'needs the mock build: NEXT_PUBLIC_MIO_API=mock',
);
test.use({ viewport: { width: 1280, height: 900 } });

const nav = (page: Page) => page.getByRole('navigation', { name: 'Operator pages' });

async function navEntries(page: Page) {
  return (await nav(page).getByRole('link').allInnerTexts()).map((t) => t.trim());
}

/** Switch the role on the page; the guard redirects a role that has no access to this page. */
async function switchRole(page: Page, role: string) {
  await page.getByLabel('Role').selectOption(role);
}

test('admin: lands on Setup, sees all seven pages, resolves a review on Redemptions', async ({
  page,
}) => {
  await page.goto('/en/operator');
  await expect(page).toHaveURL(/\/en\/operator\/setup/);
  await expect(nav(page).getByRole('link', { name: 'Setup' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(await navEntries(page)).toEqual(NAV.admin);
  await nav(page).screenshot({ path: shot('admin-nav') });
  await page.screenshot({ path: shot('admin-landing') });
  await page.screenshot({ path: shot('admin-setup'), fullPage: true });

  await page.goto('/en/operator/engagement/rules');
  await expect(page.getByRole('heading', { name: /rules/i }).first()).toBeVisible();
  await page.screenshot({ path: shot('admin-rules'), fullPage: true });

  await page.goto('/en/operator/operations/redemptions');
  await expect(page.getByRole('table', { name: 'Redemptions' })).toBeVisible();
  // The review row from the state has a Resolve action (UIR-1); the panel opens.
  await page
    .getByRole('button', { name: /^Resolve / })
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();
  await page.screenshot({ path: shot('admin-redemptions'), fullPage: true });

  await page.goto('/en/operator/insights');
  await expect(page.getByRole('heading', { name: 'Invoices', exact: true })).toBeVisible();
  await page.screenshot({ path: shot('admin-insights'), fullPage: true });
});

test('staff: a page they cannot open sends them to Redemptions, no Resolve button', async ({
  page,
}) => {
  await page.goto('/en/operator/engagement/rules');
  await expect(page.getByRole('heading', { name: /rules/i }).first()).toBeVisible();
  await switchRole(page, 'staff');
  await expect(page).toHaveURL(/\/operator\/operations\/redemptions\?denied=rules/);
  await expect(page.getByRole('table', { name: 'Redemptions' })).toBeVisible();
  expect(await navEntries(page)).toEqual(NAV.staff);
  await expect(page.getByRole('button', { name: /resolve/i })).toHaveCount(0);
  await nav(page).screenshot({ path: shot('staff-nav') });
  await page.screenshot({ path: shot('staff-landing') });
});

test('support: lands on Insights with Insights and Team only', async ({ page }) => {
  await page.goto('/en/operator/operations/redemptions');
  await expect(page.getByRole('table', { name: 'Redemptions' })).toBeVisible();
  await switchRole(page, 'support');
  await expect(page).toHaveURL(/\/operator\/insights\?denied=redemptions/);
  await expect(page.getByRole('heading', { name: 'Invoices', exact: true })).toBeVisible();
  expect(await navEntries(page)).toEqual(NAV.support);
  await expect(page.getByRole('button', { name: /^pay/i })).toHaveCount(0);
  await nav(page).screenshot({ path: shot('support-nav') });
  await page.screenshot({ path: shot('support-landing') });
});
