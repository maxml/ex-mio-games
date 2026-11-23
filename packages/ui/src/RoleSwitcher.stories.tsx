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

type DemoRole = ConsoleRole | 'player';

/** The prototype's five roles: the player is not a console role, so the caller passes `roles` and `labels`. */
export const WithPlayer: Story = {
  render: () => {
    const [value, setValue] = useState<DemoRole>('admin');
    return (
      <RoleSwitcher<DemoRole>
        value={value}
        onChange={setValue}
        roles={['admin', 'staff', 'support', 'platform', 'player']}
        labels={{ player: 'Player (widget)' }}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const select = within(canvasElement).getByLabelText('Role');
    await expect(
      within(select).getByRole('option', { name: 'Player (widget)' }),
    ).toBeInTheDocument();
    await userEvent.selectOptions(select, 'player');
    await expect(select).toHaveValue('player');
  },
};

/** Switching to Staff reports `staff`. */
export const ToStaff: Story = {
  render: (args) => {
    const [value, setValue] = useState<ConsoleRole>(args.value as ConsoleRole);
    return (
      <RoleSwitcher
        value={value}
        onChange={(r) => {
          setValue(r as ConsoleRole);
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
