import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ROLE_LABEL, RoleSwitcher, type ConsoleRole } from './RoleNav';

const meta = {
  title: 'Composites/RoleSwitcher',
  component: RoleSwitcher,
  args: { value: 'admin', onChange: fn() },
} satisfies Meta<typeof RoleSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Switching to Staff reports `staff`. */
export const ToStaff: Story = {
  render: (args) => {
    const [value, setValue] = useState<ConsoleRole>(args.value);
    return (
      <RoleSwitcher
        value={value}
        onChange={(r) => {
          setValue(r);
          args.onChange(r);
        }}
      />
    );
  },
  play: async ({ canvasElement, args }) => {
    const select = within(canvasElement).getByLabelText('Role');
    await expect(
      within(select).getByRole('option', { name: ROLE_LABEL.staff }),
    ).toBeInTheDocument();
    await userEvent.selectOptions(select, 'staff');
    await expect(args.onChange).toHaveBeenCalledWith('staff');
    await expect(select).toHaveValue('staff');
  },
};
