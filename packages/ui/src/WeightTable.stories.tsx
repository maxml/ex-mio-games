import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { WeightTable } from './WeightTable';

const ROWS = [10, 25, 50, 100].map((coins, i) => ({ id: `r${i}`, coins }));

const meta = { title: 'Composites/WeightTable', component: WeightTable } satisfies Meta<
  typeof WeightTable
>;

export default meta;
type Story = StoryObj;

export const Editing: Story = {
  render: () => {
    const [w, setW] = useState([30, 24, 18, 12]);
    return (
      <WeightTable
        rows={ROWS}
        weights={w}
        onChange={(i, v) => setW((cur) => cur.map((x, j) => (j === i ? v : x)))}
      />
    );
  },
};

/** A weight of 0 marks its input invalid; a positive weight clears it. */
export const InvalidWeight: Story = {
  render: () => {
    const [w, setW] = useState([30, 0, 18, 12]);
    return (
      <WeightTable
        rows={ROWS}
        weights={w}
        onChange={(i, v) => setW((cur) => cur.map((x, j) => (j === i ? v : x)))}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const bad = c.getByLabelText('Weight for 25 coins');
    await expect(bad).toHaveAttribute('aria-invalid', 'true');
    await expect(c.getByLabelText('Weight for 10 coins')).not.toHaveAttribute('aria-invalid');
    await userEvent.clear(bad);
    await userEvent.type(bad, '5');
    await expect(bad).not.toHaveAttribute('aria-invalid');
  },
};
