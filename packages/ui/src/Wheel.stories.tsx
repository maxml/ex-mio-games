import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';
import { Wheel } from './Wheel';

const SEGMENTS = ['10', '25', '50', '100', '250', '500', '1000', '5'].map((label, i) => ({
  id: `s${i}`,
  label,
}));

const meta = {
  title: 'Composites/Wheel',
  component: Wheel,
  args: { segments: SEGMENTS, spin: null, size: 300 },
} satisfies Meta<typeof Wheel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AtRest: Story = {};
/** Mounted with a result already in hand: shown at rest, no animation. */
export const ResultAtRest: Story = { args: { spin: { id: 'spin-1', index: 3 } } };
export const FourSegments: Story = { args: { segments: SEGMENTS.slice(0, 4) } };

/** The server picks the index; the wheel only animates to it. */
export const Spinning: Story = {
  render: (args) => {
    const [spin, setSpin] = useState<{ id: string; index: number } | null>(null);
    return (
      <div className="grid gap-3">
        <Wheel {...args} spin={spin} />
        <Button
          onClick={() =>
            setSpin({
              id: `spin-${Date.now()}`,
              index: Math.floor(Math.random() * SEGMENTS.length),
            })
          }
        >
          Spin
        </Button>
      </div>
    );
  },
};
