import type { Meta, StoryObj } from '@storybook/react';
import { EventLog } from './EventLog';

const meta = { title: 'Composites/EventLog', component: EventLog } satisfies Meta<typeof EventLog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Passed: Story = {
  args: {
    entries: [
      {
        id: 'ping',
        label: 'Casino reachable',
        detail: 'POST /webhooks/mio answered 200 in 84 ms',
        status: 'accepted',
      },
      {
        id: 'dup',
        label: 'Duplicate event ignored',
        detail: 'Same event id replayed: no extra spins',
        status: 'duplicate',
      },
    ],
  },
};
export const Rejected: Story = {
  args: {
    entries: [
      {
        id: 'sig',
        label: 'Signature verified',
        detail: 'HMAC header did not match',
        status: 'rejected',
      },
    ],
  },
};
export const Empty: Story = { args: { entries: [] } };
