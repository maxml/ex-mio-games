import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { InsightsTemplate, type InsightsTemplateProps } from './InsightsTeam';
import { DAILY_SPINS, FUNNEL, INVOICES, USAGE, shellFor } from './fixtures';

const meta = {
  title: 'Templates/Operator/Insights',
  component: InsightsTemplate,
  parameters: { layout: 'fullscreen' },
  args: {
    shell: shellFor('admin'),
    usage: USAGE,
    daily: DAILY_SPINS,
    invoices: INVOICES,
    funnel: FUNNEL,
    onPay: fn(),
  },
} satisfies Meta<typeof InsightsTemplate>;

export default meta;
type Story = StoryObj<typeof meta>;

const withArgs = (a: Partial<InsightsTemplateProps>): Story => ({ args: a as never });

export const Admin: Story = {};
export const Staff: Story = withArgs({ shell: shellFor('staff'), readOnly: true });
export const Support: Story = withArgs({ shell: shellFor('support'), readOnly: true });
export const Empty: Story = withArgs({ state: 'empty' });
export const Loading: Story = withArgs({ state: 'loading' });
export const ErrorState: Story = {
  name: 'Error',
  ...withArgs({
    shell: shellFor('support'),
    state: 'error',
    errorText: "Support access cannot read this tenant's engagement data.",
  }),
};
