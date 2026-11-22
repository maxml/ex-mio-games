import type { Meta, StoryObj } from '@storybook/react';
import { Field, Input, Select } from './Input';

const meta = {
  title: 'Primitives/Input',
  component: Input,
  args: { 'aria-label': 'Email address', placeholder: 'Email address' },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithValue: Story = { args: { defaultValue: 'hello@example.com' } };
export const Invalid: Story = { args: { invalid: true, defaultValue: 'not-an-email' } };
export const Disabled: Story = { args: { disabled: true, value: 'Disabled' } };
export const Small: Story = { args: { size: 'sm' } };

export const SelectControl: Story = {
  render: () => (
    <Select aria-label="Plan">
      <option>Starter</option>
      <option>Growth</option>
    </Select>
  ),
};

/** Label, control and message wired together with matching ids. */
export const LabelledField: Story = {
  render: () => (
    <Field label="Work email" hint="We send the verification link here.">
      {({ id, describedBy }) => <Input id={id} type="email" aria-describedby={describedBy} />}
    </Field>
  ),
};
export const FieldWithError: Story = {
  render: () => (
    <Field label="Work email" error="Enter an email like name@company.com">
      {({ id, invalid, describedBy }) => (
        <Input
          id={id}
          type="email"
          defaultValue="nope"
          invalid={invalid}
          aria-describedby={describedBy}
        />
      )}
    </Field>
  ),
};
