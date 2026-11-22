import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import {
  GoLivePanel,
  KeysPanel,
  PlanPanel,
  RewardApiPanel,
  SandboxPanel,
  SignupPanel,
} from '../SetupPanels';
import { SetupTemplate, type SetupTemplateProps } from './SetupTemplate';
import { LIVE_KEYS, PLANS, SANDBOX_KEYS, shellFor, stepsDone } from './fixtures';

const meta = {
  title: 'Templates/Operator/Setup checklist',
  component: SetupTemplate,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SetupTemplate>;

export default meta;
type Story = StoryObj;

type Demo = Partial<SetupTemplateProps> & { done?: number; start?: string };

/** Holds the open step, as the page does. The panels get no-op callbacks. */
function SetupDemo({ done = 2, start = 'keys', ...rest }: Demo) {
  const [current, setCurrent] = useState(start);
  const steps = stepsDone(done);
  return (
    <SetupTemplate
      shell={shellFor('admin')}
      steps={steps}
      current={current}
      onSelectStep={setCurrent}
      panels={{
        signup: <SignupPanel onSubmit={fn()} done />,
        plan: <PlanPanel plans={PLANS} planId="growth" onSelectPlan={fn()} onPay={fn()} paid />,
        keys: (
          <KeysPanel
            keys={SANDBOX_KEYS}
            onCopy={fn()}
            issueLabel="Issue production keys"
            onIssue={fn()}
          />
        ),
        'reward-api': <RewardApiPanel onSubmit={fn()} />,
        sandbox: <SandboxPanel entries={[]} onRun={fn()} />,
        golive: (
          <GoLivePanel
            steps={steps}
            onSelectStep={setCurrent}
            liveKeys={LIVE_KEYS}
            phase="idle"
            onStart={fn()}
          />
        ),
      }}
      {...rest}
    />
  );
}

const demo = (d: Demo): Story => ({ render: () => <SetupDemo {...d} /> });

export const Admin: Story = demo({});
export const Staff: Story = demo({ readOnly: true, shell: shellFor('staff') });
export const Support: Story = demo({ readOnly: true, shell: shellFor('support') });
export const Empty: Story = demo({ done: 0, start: 'signup', state: 'empty' });
export const Loading: Story = demo({ state: 'loading' });
export const ErrorState: Story = {
  name: 'Error',
  ...demo({ state: 'error', errorText: 'Could not load your setup. Try again.' }),
};
export const Sandbox: Story = demo({ done: 4, start: 'sandbox' });

/** Six steps done: the page says "You are live". */
export const Live: Story = {
  ...demo({ done: 6, live: true, shell: shellFor('admin', 'live') }),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('You are live')).toBeVisible();
    await expect(c.getByText('6 of 6 done')).toBeVisible();
    await expect(c.getByRole('link', { name: 'set up engagement' })).toBeVisible();
  },
};

/** Page-level flow: "2 of 6 done", open the next step, its panel shows. */
export const Progress: Story = {
  ...demo({ start: 'signup' }),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('2 of 6 done')).toBeVisible();
    const nav = c.getByRole('navigation', { name: 'Progress' });
    await expect(nav.textContent?.match(/\(complete/g)).toHaveLength(2);
    await expect(c.queryByRole('heading', { name: 'Integration keys' })).not.toBeInTheDocument();
    await userEvent.click(within(nav).getByRole('button', { name: /Integration keys/ }));
    await expect(c.getByRole('heading', { name: 'Integration keys' })).toBeVisible();
    await expect(within(nav).getByRole('button', { name: /Integration keys/ })).toHaveAttribute(
      'aria-current',
      'step',
    );
  },
};
