import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { TeamTemplate, type TeamTemplateProps } from './InsightsTeam';
import { AUDIT, STAFF, shellFor } from './fixtures';

const meta = {
  title: 'Templates/Operator/Team',
  component: TeamTemplate,
  parameters: { layout: 'fullscreen' },
  args: { shell: shellFor('admin'), staff: STAFF, audit: AUDIT, onInvite: fn() },
} satisfies Meta<typeof TeamTemplate>;

export default meta;
type Story = StoryObj<typeof meta>;

const withArgs = (a: Partial<TeamTemplateProps>): Story => ({ args: a as never });

export const Admin: Story = {};
export const Staff: Story = withArgs({ shell: shellFor('staff'), readOnly: true });
export const Support: Story = withArgs({ shell: shellFor('support'), readOnly: true });
export const Empty: Story = withArgs({ state: 'empty' });
export const Loading: Story = withArgs({ state: 'loading' });
export const ErrorState: Story = {
  name: 'Error',
  ...withArgs({ state: 'error', errorText: 'Could not load the team. Try again.' }),
};
