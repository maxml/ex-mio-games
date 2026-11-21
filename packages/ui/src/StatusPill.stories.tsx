import type { Meta, StoryObj } from '@storybook/react';
import { Badge, StatusPill, type Status } from './StatusPill';

const meta = { title: 'Primitives/StatusPill', component: StatusPill } satisfies Meta<
  typeof StatusPill
>;

export default meta;
type Story = StoryObj;

const ALL: Status[] = [
  'pending',
  'issuing',
  'issued',
  'failed',
  'refunded',
  'accepted',
  'duplicate',
  'rejected',
  'active',
  'trial',
  'past_due',
  'suspended',
  'draft',
  'published',
  'archived',
  'paid',
  'open',
];

export const Single: Story = { args: { status: 'issued' } };
/** Every status the product shows: icon and word, never colour alone. */
export const AllStatuses: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {ALL.map((s) => (
        <StatusPill key={s} status={s} />
      ))}
    </div>
  ),
};
export const Badges: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Badge>Neutral</Badge>
      <Badge tone="primary" icon>
        Selected
      </Badge>
      <Badge tone="warning" icon>
        Unsaved changes
      </Badge>
      <Badge tone="success" icon>
        v3 published
      </Badge>
    </div>
  ),
};
