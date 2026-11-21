import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';
import { Card } from './Card';
import { StatusPill } from './StatusPill';

const meta = { title: 'Primitives/Card', component: Card } satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { children: 'Card body' } };
export const WithHeader: Story = {
  args: {
    title: 'Spin rules',
    description: 'When does a deposit earn spins?',
    actions: <StatusPill status="published" />,
    children: 'Card body',
  },
};
export const WithAction: Story = {
  args: {
    title: 'Integration keys',
    actions: <Button size="sm">Rotate</Button>,
    children: 'Keys go here',
  },
};
