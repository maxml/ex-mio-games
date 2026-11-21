import type { Meta, StoryObj } from '@storybook/react';
import { CoinBalance, CoinIcon } from './CoinBalance';

const meta = {
  title: 'Composites/CoinBalance',
  component: CoinBalance,
  args: { coins: 1420 },
} satisfies Meta<typeof CoinBalance>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Large: Story = { args: { size: 'lg' } };
export const Zero: Story = { args: { coins: 0 } };
export const Icon: Story = { render: () => <CoinIcon className="size-8" /> };
