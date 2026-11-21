import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
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
export const InvalidWeight: Story = {
  args: { rows: ROWS, weights: [30, 0, 18, 12], onChange: () => undefined },
};
