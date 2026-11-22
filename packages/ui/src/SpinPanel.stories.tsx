import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { SpinPanel, type SpinPanelProps } from './SpinPanel';
import { SEGMENTS } from './templates/fixtures';
import type { WheelSpin } from './Wheel';

const meta = {
  title: 'Composites/SpinPanel',
  component: SpinPanel,
  args: {
    segments: SEGMENTS,
    spin: null,
    spinsLeft: 3,
    durationMs: 50,
    size: 240,
    onSpin: fn(),
    onSpinEnd: fn(),
  },
} satisfies Meta<typeof SpinPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Stands in for the server: each `onSpin` answers with a new spin result. */
function Wired(args: SpinPanelProps) {
  const [spin, setSpin] = useState<WheelSpin | null>(null);
  return (
    <SpinPanel
      {...args}
      spin={spin}
      result={spin ? `You won ${SEGMENTS[spin.index]!.label} coins` : undefined}
      onSpin={() => {
        args.onSpin();
        setSpin({ id: 'spin-1', index: 3 });
      }}
    />
  );
}

/** Click Spin: `onSpin` once, the button is off while the wheel turns, then the result is announced. */
export const Spin: Story = {
  render: (args) => <Wired {...args} />,
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: 'Spin' }));
    await expect(args.onSpin).toHaveBeenCalledTimes(1);
    await expect(c.getByRole('button', { name: 'Spin' })).toBeDisabled();
    await waitFor(() => expect(args.onSpinEnd).toHaveBeenCalledTimes(1), { timeout: 4000 });
    await waitFor(() => expect(c.getByText('You won 100 coins')).toBeVisible());
    await expect(c.getByRole('button', { name: 'Spin' })).toBeEnabled();
  },
};

/** A double click must reach the server once. */
export const DoubleClick: Story = {
  render: (args) => <Wired {...args} />,
  play: async ({ canvasElement, args }) => {
    await userEvent.dblClick(within(canvasElement).getByRole('button', { name: 'Spin' }));
    await expect(args.onSpin).toHaveBeenCalledTimes(1);
  },
};

export const NoSpinsLeft: Story = { args: { spinsLeft: 0 } };
