import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { FilterBar } from './FilterBar';

const OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'issued', label: 'Issued' },
];

const meta = {
  title: 'Composites/FilterBar',
  component: FilterBar<string>,
  args: { options: OPTIONS, value: 'all', onChange: fn() },
} satisfies Meta<typeof FilterBar<string>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value);
    return (
      <FilterBar
        {...args}
        value={value}
        onChange={(v) => {
          setValue(v);
          args.onChange(v);
        }}
      />
    );
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(c.getByRole('button', { name: 'Pending' }));
    await expect(c.getByRole('button', { name: 'Pending' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(c.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    await expect(args.onChange).toHaveBeenCalledWith('pending');
  },
};
