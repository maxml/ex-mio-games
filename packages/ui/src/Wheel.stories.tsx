import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
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

/** A new spin id reports once; rendering again with the same id does not report again. */
export const NewSpinReportsOnce: Story = {
  args: { durationMs: 50, onSpinEnd: fn() },
  render: (args) => {
    const [spin, setSpin] = useState<{ id: string; index: number } | null>(null);
    const [renders, setRenders] = useState(0);
    return (
      <div className="grid gap-3">
        <Wheel {...args} spin={spin} />
        <Button onClick={() => setSpin({ id: 'spin-a', index: 2 })}>New spin</Button>
        <Button
          variant="secondary"
          onClick={() => {
            setSpin({ id: 'spin-a', index: 2 });
            setRenders((n) => n + 1);
          }}
        >
          Re-render with the same id
        </Button>
        <p>Renders: {renders}</p>
      </div>
    );
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(args.onSpinEnd).not.toHaveBeenCalled();
    await userEvent.click(c.getByRole('button', { name: 'New spin' }));
    await waitFor(() => expect(args.onSpinEnd).toHaveBeenCalledTimes(1), { timeout: 4000 });
    await expect(args.onSpinEnd).toHaveBeenCalledWith('spin-a');
    await userEvent.click(c.getByRole('button', { name: 'Re-render with the same id' }));
    await expect(c.getByText('Renders: 1')).toBeVisible();
    await new Promise((r) => setTimeout(r, 400));
    await expect(args.onSpinEnd).toHaveBeenCalledTimes(1);
  },
};
