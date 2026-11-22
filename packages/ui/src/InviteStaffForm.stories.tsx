import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { InviteStaffForm } from './InviteStaffForm';

const meta = {
  title: 'Composites/InviteStaffForm',
  component: InviteStaffForm,
  args: { onSubmit: fn(), preview: true },
} satisfies Meta<typeof InviteStaffForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Invite: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.type(c.getByLabelText('Email'), 'not-an-email');
    await userEvent.click(c.getByRole('button', { name: 'Send invite' }));
    await expect(c.getByText('Enter a valid email address.')).toBeVisible();
    await expect(args.onSubmit).not.toHaveBeenCalled();
    await userEvent.clear(c.getByLabelText('Email'));
    await userEvent.type(c.getByLabelText('Email'), 'agent@example.com');
    await userEvent.click(c.getByRole('button', { name: 'Send invite' }));
    await expect(args.onSubmit).toHaveBeenCalledWith('agent@example.com');
  },
};
