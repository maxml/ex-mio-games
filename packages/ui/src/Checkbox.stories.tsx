import type { Meta, StoryObj } from '@storybook/react';
import { Checkbox } from './Checkbox';
import { StatusPill } from './StatusPill';

const meta = {
  title: 'Primitives/Checkbox',
  component: Checkbox,
  args: { label: 'Visible to players' },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unchecked: Story = {};
export const Checked: Story = { args: { defaultChecked: true } };
export const Disabled: Story = { args: { disabled: true } };
export const HiddenLabelWithStatus: Story = {
  args: {
    hideLabel: true,
    label: 'Visible to players: 20 free spins',
    defaultChecked: true,
    trailing: <StatusPill status="published" />,
  },
};
