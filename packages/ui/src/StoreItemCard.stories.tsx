import type { Meta, StoryObj } from '@storybook/react';
import { StoreItemCard } from './StoreItemCard';

const ITEM = {
  id: 's1',
  name: '20 free spins',
  description: 'On a featured slot, wager free.',
  priceCoins: 300,
  kind: 'free_spins' as const,
};

const meta = {
  title: 'Composites/StoreItemCard',
  component: StoreItemCard,
  args: { item: ITEM, balance: 420, onRedeem: () => undefined },
} satisfies Meta<typeof StoreItemCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Affordable: Story = {};
export const NotEnoughCoins: Story = { args: { balance: 120 } };
export const SoldOut: Story = { args: { item: { ...ITEM, stock: 0 } } };
export const Busy: Story = { args: { busy: true } };
