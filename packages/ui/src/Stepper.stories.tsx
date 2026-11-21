import type { Meta, StoryObj } from '@storybook/react';
import { StepNav } from './StepNav';
import { Stepper } from './Stepper';

const STEPS = [
  { id: 'signup', label: 'Sign up', done: true },
  { id: 'plan', label: 'Plan', done: true },
  { id: 'keys', label: 'Keys' },
  { id: 'sandbox', label: 'Sandbox test' },
];

const meta = { title: 'Primitives/Stepper', component: Stepper } satisfies Meta<typeof Stepper>;

export default meta;
type Story = StoryObj;

/** A tick means the work is finished; position alone never implies completion. */
export const Default: Story = { args: { steps: STEPS, current: 2 } };
export const Clickable: Story = { args: { steps: STEPS, current: 2, onSelect: () => undefined } };

export const Navigation: Story = {
  render: () => (
    <StepNav
      index={2}
      nextLabel="Continue to sandbox test"
      onBack={() => undefined}
      onNext={() => undefined}
    />
  ),
};
export const NavigationBlocked: Story = {
  render: () => (
    <StepNav
      index={3}
      nextLabel="Continue to go live"
      canContinue={false}
      hint="Run the sandbox test and pass all checks to continue."
      onBack={() => undefined}
      onNext={() => undefined}
    />
  ),
};
