import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { AdminConsoleTemplate, type AdminConsoleTemplateProps } from './PlayerAdmin';
import { FUNNEL, TENANTS } from './fixtures';

const meta = {
  title: 'Templates/Admin/Console',
  component: AdminConsoleTemplate,
  parameters: { layout: 'fullscreen' },
  args: { tenants: TENANTS, funnel: FUNNEL, onAct: fn() },
} satisfies Meta<typeof AdminConsoleTemplate>;

export default meta;
type Story = StoryObj<typeof meta>;

const withArgs = (a: Partial<AdminConsoleTemplateProps>): Story => ({ args: a as never });

/** Platform admin: may start an acting session, with a reason. */
export const Admin: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const start = c.getByRole('button', { name: 'Start acting session' });
    await expect(start).toBeDisabled();
    await userEvent.type(c.getByLabelText('Reason'), 'ticket 4711');
    await expect(start).toBeEnabled();
    await userEvent.click(start);
    await expect(args.onAct).toHaveBeenCalledWith('t1', 'ticket 4711');
  },
};
/** The wording and extras the web app ships: four tiles, usage columns, a longer reason, the audit list. */
export const WithUsageAndAudit: Story = {
  args: {
    tenants: TENANTS.map((t) => ({ ...t, spins: 1200, depositors: 80 })),
    tiles: [
      { label: 'MRR', value: '3,497 EUR', delta: 8.2 },
      { label: 'Paying operators', value: '2 of 4' },
      { label: 'Spins this month', value: '4,800', delta: 14.9 },
      { label: 'Signup to paid', value: '12%', hint: 'last 30 days', delta: -1.3 },
    ],
    minReason: 8,
    audit: [{ id: 'a1', title: 'Opened Lucky Star Casino', subtitle: 'ticket 4711 (just now)' }],
    copy: { actSubmit: 'Open tenant', currencyInHeader: true, tenantsTitle: 'Operators' },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const open = c.getByRole('button', { name: 'Open tenant' });
    await userEvent.type(c.getByLabelText('Reason'), 'short');
    await expect(open).toBeDisabled();
    await userEvent.type(c.getByLabelText('Reason'), ' enough');
    await expect(open).toBeEnabled();
  },
};
// The operator roles are read-only here: no act-as form.
export const Staff: Story = withArgs({ readOnly: true });
export const Support: Story = withArgs({ readOnly: true });
export const Empty: Story = withArgs({ state: 'empty', tenants: [] });
export const Loading: Story = withArgs({ state: 'loading' });
export const ErrorState: Story = {
  name: 'Error',
  ...withArgs({ state: 'error', errorText: 'Could not load the tenants. Try again.' }),
};
