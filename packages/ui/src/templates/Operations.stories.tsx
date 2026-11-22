import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { RedemptionsTemplate, type RedemptionsTemplateProps } from './Operations';
import { REDEMPTIONS, shellFor } from './fixtures';

const meta = {
  title: 'Templates/Operator/Operations',
  component: RedemptionsTemplate,
  parameters: { layout: 'fullscreen' },
  args: { shell: shellFor('admin'), rows: REDEMPTIONS, onResolve: fn() },
} satisfies Meta<typeof RedemptionsTemplate>;

export default meta;
type Story = StoryObj<typeof meta>;

const withArgs = (a: Partial<RedemptionsTemplateProps>): Story => ({ args: a as never });

export const Admin: Story = {};
export const Staff: Story = withArgs({ shell: shellFor('staff'), readOnly: true });
export const Support: Story = withArgs({ shell: shellFor('support'), readOnly: true });
export const Empty: Story = withArgs({ rows: [] });
export const Loading: Story = withArgs({ state: 'loading' });
export const ErrorState: Story = {
  name: 'Error',
  ...withArgs({
    shell: shellFor('support'),
    state: 'error',
    errorText: "Support access cannot read this tenant's engagement data.",
  }),
};

/** Page-level flow: pick a review row, the panel opens, a short reason keeps Submit off. */
export const ResolveReview: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.queryByRole('heading', { name: /Resolve/ })).not.toBeInTheDocument();
    await userEvent.click(c.getByRole('button', { name: 'Resolve r2' }));
    await expect(c.getByRole('heading', { name: /Resolve 10 EUR cash bonus/ })).toBeVisible();
    const submit = c.getByRole('button', { name: 'Submit' });
    await userEvent.type(c.getByLabelText('Reason'), 'ok');
    await expect(submit).toBeDisabled();
    await userEvent.clear(c.getByLabelText('Reason'));
    await userEvent.type(c.getByLabelText('Reason'), 'player confirmed');
    await userEvent.click(c.getByRole('radio', { name: 'Not issued' }));
    await userEvent.click(submit);
    await expect(args.onResolve).toHaveBeenCalledTimes(1);
    await expect(args.onResolve).toHaveBeenCalledWith(
      { outcome: 'not_issued', reason: 'player confirmed' },
      'r2',
    );
  },
};

/** Staff reads the queue and has no Resolve button. */
export const StaffHasNoResolve: Story = {
  ...withArgs({ shell: shellFor('staff'), readOnly: true }),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('Needs review', { selector: 'span' })).toBeVisible();
    await expect(c.queryByRole('button', { name: /Resolve/ })).not.toBeInTheDocument();
  },
};

/** The filter narrows the queue. */
export const FilterByStatus: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: 'Issued' }));
    await expect(c.getByRole('button', { name: 'Issued' })).toHaveAttribute('aria-pressed', 'true');
    await expect(c.getByText('player-1003')).toBeVisible();
    await expect(c.queryByText('player-1001')).not.toBeInTheDocument();
  },
};
