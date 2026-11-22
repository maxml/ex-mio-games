import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { RedeemFlow, type RedeemStatus } from './RedeemFlow';
import { STORE_ITEMS } from './templates/fixtures';

const ITEM = STORE_ITEMS[0]!;

const meta = {
  title: 'Composites/RedeemFlow',
  component: RedeemFlow,
  args: { item: ITEM, balance: 1200, onConfirm: fn() },
} satisfies Meta<typeof RedeemFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Stands in for the server: the status moves to pending, then to the given end status. */
function wired(end: RedeemStatus): Story['render'] {
  return (args) => {
    const [status, setStatus] = useState<RedeemStatus | undefined>(undefined);
    return (
      <RedeemFlow
        {...args}
        status={status}
        onConfirm={(item) => {
          args.onConfirm(item);
          setStatus('pending');
          setTimeout(() => setStatus(end), 200);
        }}
      />
    );
  };
}

export const HappyPath: Story = {
  render: wired('issued'),
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: 'Redeem' }));
    await userEvent.click(c.getByRole('button', { name: 'Confirm' }));
    await expect(args.onConfirm).toHaveBeenCalledTimes(1);
    await expect(c.getByText('Pending')).toBeVisible();
    await waitFor(() => expect(c.getByText('Issued')).toBeVisible());
  },
};

export const Refunded: Story = {
  render: wired('failed_refunded'),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: 'Redeem' }));
    await userEvent.click(c.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(c.getByText('Refunded')).toBeVisible());
    await expect(c.getByText('Your 500 coins are back in your balance.')).toBeVisible();
  },
};

/** Cancel at the confirm step creates no redemption. */
export const CancelConfirm: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: 'Redeem' }));
    await userEvent.click(c.getByRole('button', { name: 'Cancel' }));
    await expect(args.onConfirm).not.toHaveBeenCalled();
  },
};

export const NotEnoughCoins: Story = {
  args: { balance: 120 },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole('button', { name: 'Redeem' })).toBeDisabled();
    await expect(c.getByText('380 more coins needed')).toBeVisible();
  },
};
