import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { PlanPicker } from './PlanPicker';
import { PLANS } from './templates/fixtures';

const meta = {
  title: 'Composites/PlanPicker',
  component: PlanPicker,
  args: { plans: PLANS, value: null, onChange: fn() },
} satisfies Meta<typeof PlanPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Choosing: Story = {
  render: (args) => {
    const [value, setValue] = useState<string | null>(args.value);
    return (
      <PlanPicker
        {...args}
        value={value}
        onChange={(id) => {
          setValue(id);
          args.onChange(id);
        }}
      />
    );
  },
  play: async ({ canvasElement, args }) => {
    const group = within(canvasElement).getByRole('radiogroup', { name: 'Choose a plan' });
    await userEvent.click(within(group).getByRole('radio', { name: /Growth/ }));
    await expect(args.onChange).toHaveBeenCalledWith('growth');
    await expect(within(group).getByRole('radio', { name: /Growth/ })).toBeChecked();
  },
};

export const Locked: Story = { args: { value: 'growth', disabled: true } };
