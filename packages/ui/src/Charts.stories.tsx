import type { Meta, StoryObj } from '@storybook/react';
import { BarChart, FunnelChart } from './Charts';

const meta = { title: 'Composites/Charts', component: BarChart } satisfies Meta<typeof BarChart>;

export default meta;
type Story = StoryObj;

export const Bars: Story = {
  args: {
    label: 'Daily spins, thousands',
    values: [31, 36, 33, 41, 44, 39, 47, 52, 49, 55, 58, 54, 61, 66],
  },
};
export const Funnel: Story = {
  render: () => (
    <FunnelChart
      steps={[
        { step: 'Signups', value: 240 },
        { step: 'Plan chosen', value: 150 },
        { step: 'Keys created', value: 118 },
        { step: 'First live deposit', value: 41 },
      ]}
    />
  ),
};
