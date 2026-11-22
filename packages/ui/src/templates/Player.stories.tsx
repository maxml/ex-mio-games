import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { PlayerWidgetTemplate, type PlayerWidgetTemplateProps } from './PlayerAdmin';
import { HISTORY, SEGMENTS, STORE_ITEMS } from './fixtures';

const meta = {
  title: 'Templates/Player/Widget',
  component: PlayerWidgetTemplate,
  parameters: { layout: 'fullscreen' },
  args: {
    environment: 'sandbox',
    balance: 1200,
    spinsLeft: 3,
    segments: SEGMENTS,
    spin: null,
    onSpin: fn(),
    items: STORE_ITEMS,
    onRedeem: fn(),
    history: HISTORY,
  },
} satisfies Meta<typeof PlayerWidgetTemplate>;

export default meta;
type Story = StoryObj<typeof meta>;

const withArgs = (a: Partial<PlayerWidgetTemplateProps>): Story => ({ args: a as never });

// A player has no operator role, so there are no Admin, Staff or Support variants here.
export const Default: Story = {};
export const Sandbox: Story = withArgs({ environment: 'sandbox' });
export const Live: Story = withArgs({ environment: 'live' });
export const Empty: Story = withArgs({ state: 'empty' });
export const Loading: Story = withArgs({ state: 'loading' });
export const ErrorState: Story = {
  name: 'Error',
  ...withArgs({ state: 'error', errorText: 'The widget could not load. Try again.' }),
};
