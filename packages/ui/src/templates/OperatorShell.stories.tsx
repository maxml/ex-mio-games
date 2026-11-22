import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { Card } from '../Card';
import { Text } from '../Typography';
import { OperatorShell, ReadOnlyNotice, StateBody, type OperatorShellProps } from './OperatorShell';
import { shellFor } from './fixtures';

const meta = {
  title: 'Templates/Operator/Shell',
  component: OperatorShell,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof OperatorShell>;

export default meta;
type Story = StoryObj<typeof meta>;

const base = (
  p: Partial<OperatorShellProps> & Pick<OperatorShellProps, 'role'>,
  state?: 'ready' | 'loading' | 'error' | 'empty',
): OperatorShellProps => ({
  ...shellFor(p.role, p.environment),
  current: 'insights',
  title: 'Usage and invoices',
  intro: 'The page content goes here.',
  ...p,
  children: (
    <StateBody state={state} empty={<Text tone="muted">Nothing to show yet.</Text>}>
      <Card title="Page content">
        <Text>A template fills this slot.</Text>
      </Card>
      {p.role !== 'admin' && <ReadOnlyNotice />}
    </StateBody>
  ),
});

export const Admin: Story = {
  args: base({ role: 'admin', current: 'setup', title: 'Set up your integration' }),
  play: async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole('navigation', { name: 'Operator pages' });
    await expect(within(nav).getAllByRole('link')).toHaveLength(7);
  },
};

export const Staff: Story = {
  args: base({ role: 'staff', current: 'redemptions', title: 'Redemptions' }),
  play: async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole('navigation', { name: 'Operator pages' });
    await expect(within(nav).getAllByRole('link')).toHaveLength(4);
  },
};

export const Support: Story = {
  args: base({ role: 'support' }),
  play: async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole('navigation', { name: 'Operator pages' });
    await expect(within(nav).getAllByRole('link')).toHaveLength(2);
  },
};

export const Empty: Story = { args: base({ role: 'admin' }, 'empty') };
export const Loading: Story = { args: base({ role: 'admin' }, 'loading') };
export const ErrorState: Story = {
  name: 'Error',
  args: base({ role: 'support' }, 'error'),
};

/** The environment badge says which keys the console works with. */
export const Sandbox: Story = { args: base({ role: 'admin', environment: 'sandbox' }) };
export const Live: Story = { args: base({ role: 'admin', environment: 'live' }) };
