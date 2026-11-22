import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { NAV_GROUPS, RoleNav } from './RoleNav';
import { PAGES } from './templates/fixtures';

const meta = { title: 'Composites/RoleNav', component: RoleNav } satisfies Meta<typeof RoleNav>;

export default meta;
type Story = StoryObj<typeof meta>;

// The literal sets of the IA spec (A-NAV-1). They are written out here on purpose, not derived from
// the page registry, so a registry change cannot make the test agree with itself.
const SETS: Record<'admin' | 'staff' | 'support', string[]> = {
  admin: ['Setup', 'Rules', 'Wheel', 'Store', 'Redemptions', 'Insights', 'Team'],
  staff: ['Store', 'Redemptions', 'Insights', 'Team'],
  support: ['Insights', 'Team'],
};
const ALL = SETS.admin;

async function assertLinks(canvasElement: HTMLElement, role: keyof typeof SETS) {
  const nav = within(canvasElement).getByRole('navigation', { name: 'Operator pages' });
  const links = within(nav)
    .getAllByRole('link')
    .map((a) => a.textContent);
  await expect(links).toEqual(SETS[role]);
  for (const hidden of ALL.filter((l) => !SETS[role].includes(l)))
    await expect(within(nav).queryByRole('link', { name: hidden })).not.toBeInTheDocument();
}

export const Admin: Story = {
  args: { pages: PAGES, role: 'admin', current: 'setup' },
  play: ({ canvasElement }) => assertLinks(canvasElement, 'admin'),
};

export const Staff: Story = {
  args: { pages: PAGES, role: 'staff', current: 'redemptions' },
  play: async ({ canvasElement }) => {
    await assertLinks(canvasElement, 'staff');
    // Read pages carry a "Read-only" badge; the group with no page left is gone.
    const c = within(canvasElement);
    await expect(c.getAllByText('Read-only')).toHaveLength(4);
    await expect(c.queryByText('Get started')).not.toBeInTheDocument();
  },
};

export const Support: Story = {
  args: { pages: PAGES, role: 'support', current: 'insights' },
  play: ({ canvasElement }) => assertLinks(canvasElement, 'support'),
};

/** The group names the nav can show, in order, for the role that sees them all. */
export const Groups: Story = {
  args: { pages: PAGES, role: 'admin' },
  play: async ({ canvasElement }) => {
    for (const g of NAV_GROUPS)
      await expect(within(canvasElement).getByText(g, { selector: 'p' })).toBeVisible();
  },
};
