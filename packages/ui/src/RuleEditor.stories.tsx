import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { RuleEditor, type RuleValues } from './RuleEditor';

const meta = { title: 'Composites/RuleEditor', component: RuleEditor } satisfies Meta<
  typeof RuleEditor
>;

export default meta;
type Story = StoryObj;

export const Editing: Story = {
  render: () => {
    const [value, setValue] = useState<RuleValues>({ min: 20, spins: 1, per: true, cap: 10 });
    return (
      <RuleEditor
        value={value}
        onChange={setValue}
        preview={`Preview: a 40 EUR deposit earns ${Math.min(Math.floor(40 / (value.min || 1)) * value.spins, value.cap)} spin(s).`}
      />
    );
  },
};

export const Invalid: Story = {
  args: {
    value: { min: 0, spins: 1, per: true, cap: 10 },
    onChange: () => undefined,
    preview: 'Values must be whole numbers, at least 1.',
  },
};

/** Min 0 shows the error and `aria-invalid`; fixing it clears both. */
export const InvalidToValid: Story = {
  render: () => {
    const [value, setValue] = useState<RuleValues>({ min: 0, spins: 1, per: true, cap: 10 });
    return <RuleEditor value={value} onChange={setValue} preview="Preview" />;
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const min = c.getByLabelText('Minimum deposit (EUR)');
    await expect(min).toHaveAttribute('aria-invalid', 'true');
    await expect(c.getByRole('alert')).toHaveTextContent('Enter a whole number, at least 1.');
    await userEvent.clear(min);
    await userEvent.type(min, '20');
    await expect(min).not.toHaveAttribute('aria-invalid');
    await expect(c.queryByRole('alert')).not.toBeInTheDocument();
  },
};
