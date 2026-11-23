import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
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
/** The casino-page layout the web app ships: a card with tabs, the pending note and one-click redeem. */
export const Embedded: Story = {
  args: {
    embedded: {
      ariaLabel: 'MIO Games widget',
      title: 'Daily Wheel',
      description: '3 spins available',
    },
    balanceNote: '+40 pending',
    confirmRedeem: false,
    redemptions: [{ id: 'r1', title: '20 free spins', trailing: 'Issued' }],
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole('tab', { name: 'Wheel', selected: true })).toBeVisible();
    await userEvent.click(c.getByRole('tab', { name: 'Bonus Store' }));
    await expect(c.getByText('Your redemptions')).toBeVisible();
    await userEvent.click(c.getByRole('tab', { name: 'History' }));
    await expect(c.getByRole('tab', { name: 'History', selected: true })).toBeVisible();
  },
};
export const Empty: Story = withArgs({ state: 'empty' });
export const Loading: Story = withArgs({ state: 'loading' });
export const ErrorState: Story = {
  name: 'Error',
  ...withArgs({ state: 'error', errorText: 'The widget could not load. Try again.' }),
};
