import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { SetupChecklist } from './SetupChecklist';
import { stepsDone } from './templates/fixtures';

const meta = {
  title: 'Composites/SetupChecklist',
  component: SetupChecklist,
  args: { steps: stepsDone(2), current: 'keys', onSelect: fn() },
} satisfies Meta<typeof SetupChecklist>;

export default meta;
type Story = StoryObj<typeof meta>;

/** "2 of 6 done", and the stepper keeps its `Progress` landmark and "(complete)" text. */
export const Progress: Story = {
  render: (args) => {
    const [current, setCurrent] = useState(args.current);
    return (
      <SetupChecklist
        {...args}
        current={current}
        onSelect={(id) => {
          setCurrent(id);
          args.onSelect(id);
        }}
      />
    );
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.getByText('2 of 6 done')).toBeVisible();
    const nav = c.getByRole('navigation', { name: 'Progress' });
    await expect(nav.textContent?.match(/\(complete/g)).toHaveLength(2);
    await userEvent.click(within(nav).getByRole('button', { name: /Reward API/ }));
    await expect(args.onSelect).toHaveBeenCalledWith('reward-api');
  },
};

export const Missing: Story = {
  args: { variant: 'missing', steps: stepsDone(3) },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.getByText('Still missing')).toBeVisible();
    await expect(c.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument();
    await userEvent.click(c.getByRole('button', { name: 'Sandbox test' }));
    await expect(args.onSelect).toHaveBeenCalledWith('sandbox');
  },
};
