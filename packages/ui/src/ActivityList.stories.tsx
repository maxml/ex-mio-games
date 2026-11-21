import type { Meta, StoryObj } from '@storybook/react';
import { ActivityList } from './ActivityList';
import { StatusPill } from './StatusPill';

const meta = { title: 'Composites/ActivityList', component: ActivityList } satisfies Meta<
  typeof ActivityList
>;

export default meta;
type Story = StoryObj<typeof meta>;

export const History: Story = {
  args: {
    items: [
      { id: 'h1', title: 'Redeemed 20 free spins', subtitle: 'Today 14:02', trailing: '-300' },
      { id: 'h2', title: 'Spin: landed on 250', subtitle: 'Today 13:55', trailing: '+250' },
    ],
  },
};
export const Redemptions: Story = {
  args: {
    bordered: true,
    items: [{ id: 'r1', title: '20 free spins', trailing: <StatusPill status="issuing" /> }],
  },
};
export const Empty: Story = { args: { items: [], empty: 'Nothing redeemed yet.' } };
