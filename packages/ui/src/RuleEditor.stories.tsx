import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
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
