import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ResolvePanel } from './ResolvePanel';

const meta = {
  title: 'Composites/ResolvePanel',
  component: ResolvePanel,
  args: { redemptionLabel: '10 EUR cash bonus for player-1002', onResolve: fn(), preview: true },
} satisfies Meta<typeof ResolvePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A 2-character reason keeps Submit off; a valid reason and "Not issued" resolves once. */
export const Resolve: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const submit = c.getByRole('button', { name: 'Submit' });
    await expect(submit).toBeDisabled();
    await userEvent.type(c.getByLabelText('Reason'), 'ok');
    await expect(submit).toBeDisabled();
    await userEvent.clear(c.getByLabelText('Reason'));
    await userEvent.type(c.getByLabelText('Reason'), 'player confirmed');
    await userEvent.click(c.getByRole('radio', { name: 'Not issued' }));
    await expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await expect(args.onResolve).toHaveBeenCalledTimes(1);
    await expect(args.onResolve).toHaveBeenCalledWith({
      outcome: 'not_issued',
      reason: 'player confirmed',
    });
  },
};
