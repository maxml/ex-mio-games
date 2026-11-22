import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import {
  GoLivePanel,
  KeysPanel,
  PlanPanel,
  RewardApiPanel,
  SandboxPanel,
  SignupPanel,
} from './SetupPanels';
import { LIVE_KEYS, PLANS, SANDBOX_KEYS, stepsDone } from './templates/fixtures';

// The six Setup panels, one story group each.
const meta = { title: 'Composites/Setup panels', component: SignupPanel } satisfies Meta<
  typeof SignupPanel
>;

export default meta;
type Story = StoryObj;

export const Signup: Story = {
  render: () => <SignupPanel onSubmit={fn()} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: 'Create account' }));
    await expect(c.getByText('Enter the company name.')).toBeVisible();
    await expect(c.getByText('Enter a valid email address.')).toBeVisible();
  },
};

export const SignupDone: Story = { render: () => <SignupPanel onSubmit={fn()} done /> };

export const Plan: Story = {
  render: () => <PlanPanel plans={PLANS} planId="growth" onSelectPlan={fn()} onPay={fn()} />,
};

export const PlanPaid: Story = {
  render: () => <PlanPanel plans={PLANS} planId="growth" onSelectPlan={fn()} onPay={fn()} paid />,
};

export const Keys: Story = {
  render: () => (
    <KeysPanel
      keys={SANDBOX_KEYS}
      issueLabel="Issue production keys"
      onIssue={fn()}
      onCopy={fn()}
      preview
    />
  ),
};

export const KeysNone: Story = {
  render: () => <KeysPanel keys={[]} issueLabel="Issue sandbox keys" onIssue={fn()} />,
};

/** `http://` for a host that is not allow-listed is refused; https submits. */
export const RewardApi: Story = {
  render: () => <RewardApiPanel onSubmit={fn()} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const input = c.getByLabelText('Reward endpoint URL');
    await userEvent.type(input, 'http://evil.example');
    await expect(c.getByRole('alert')).toHaveTextContent('must use https://');
    await expect(c.getByRole('button', { name: 'Save endpoint' })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, 'https://casino.example/reward');
    await expect(c.queryByRole('alert')).not.toBeInTheDocument();
    await expect(c.getByRole('button', { name: 'Save endpoint' })).toBeEnabled();
  },
};

const onRewardApi = fn();

export const RewardApiSubmit: Story = {
  render: () => <RewardApiPanel onSubmit={onRewardApi} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.type(c.getByLabelText('Reward endpoint URL'), 'https://casino.example/reward');
    await userEvent.click(c.getByRole('button', { name: 'Save endpoint' }));
    await expect(onRewardApi).toHaveBeenCalledTimes(1);
    await expect(onRewardApi).toHaveBeenCalledWith('https://casino.example/reward');
  },
};

export const Sandbox: Story = {
  render: () => (
    <SandboxPanel
      onRun={fn()}
      entries={[
        {
          id: 'e1',
          label: 'Deposit event',
          detail: 'sent to the sandbox casino',
          status: 'accepted',
        },
        { id: 'e2', label: 'Reward call', detail: 'credited 100 coins', status: 'accepted' },
      ]}
    />
  ),
};

export const GoLiveBlocked: Story = {
  render: () => (
    <GoLivePanel
      steps={stepsDone(4)}
      onSelectStep={fn()}
      liveKeys={LIVE_KEYS}
      phase="idle"
      onStart={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('Still missing')).toBeVisible();
    await expect(c.getByRole('button', { name: 'Switch to live keys' })).toBeDisabled();
  },
};

export const GoLiveWaiting: Story = {
  render: () => (
    <GoLivePanel
      steps={stepsDone(5)}
      onSelectStep={fn()}
      liveKeys={LIVE_KEYS}
      phase="waiting"
      onStart={fn()}
      onConfirmDeposit={fn()}
    />
  ),
};
