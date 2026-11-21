import type { Meta, StoryObj } from '@storybook/react';
import { StatTile } from './StatTile';

const meta = {
  title: 'Composites/StatTile',
  component: StatTile,
  args: { label: 'MRR', value: '3,497 EUR' },
} satisfies Meta<typeof StatTile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Plain: Story = {};
export const Up: Story = { args: { delta: 8.2 } };
export const Down: Story = { args: { delta: -1.3, hint: 'last 30 days' } };
