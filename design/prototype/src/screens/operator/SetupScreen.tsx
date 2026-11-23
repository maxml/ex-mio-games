import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  GoLivePanel,
  KeysPanel,
  PlanPanel,
  RewardApiPanel,
  SandboxPanel,
  SetupTemplate,
  SignupPanel,
  Stack,
  StepNav,
  Text,
  type EventLogEntry,
  type KeyEntry,
  type Step,
} from '@ex-mio/ui';
import { PLANS, SANDBOX_STEPS } from '../../mock/data';
import { type StepId } from '../../state/reducer';
import { appStore, cancelPayment, startPayment, useApp } from '../../state/store';
import { navigate } from '../../router';
import { useOperatorShell } from './shell';

/** The six setup steps, in order. `reward-api` has no state in the store: its draft is local. */
const SETUP = [
  { id: 'signup', label: 'Account' },
  { id: 'plan', label: 'Plan' },
  { id: 'keys', label: 'Keys' },
  { id: 'reward-api', label: 'Reward API' },
  { id: 'sandbox', label: 'Sandbox test' },
  { id: 'golive', label: 'Go live' },
] as const;
type SetupId = (typeof SETUP)[number]['id'];

const DECLINED = 'The card was declined by the test provider. Use 4242 4242 4242 4242 instead.';
const SANDBOX_STEP_MS = 500;

// Fake values only: copy does nothing, nothing here is a credential.
const SANDBOX_KEYS: KeyEntry[] = [
  { id: 'pk', label: 'Publishable key (widget)', value: 'pk_test_EXAMPLE_00000000' },
  {
    id: 'sk',
    label: 'Secret key (server to server)',
    value: 'sk_test_EXAMPLE_0000000000',
    secret: true,
  },
  { id: 'whsec', label: 'Webhook signing secret', value: 'whsec_EXAMPLE_000000', secret: true },
];
const LIVE_KEYS: KeyEntry[] = [
  { id: 'pk', label: 'Publishable key (widget)', value: 'pk_live_EXAMPLE_00000000' },
  {
    id: 'sk',
    label: 'Secret key (server to server)',
    value: 'sk_live_EXAMPLE_0000000000',
    secret: true,
  },
];

const setupPath = (id: string) => `/operator/setup/${id}`;

/** Get started: the setup checklist. The open step is part of the hash (`#/operator/setup/keys`). */
export function SetupScreen({ step, denied }: { step?: string; denied?: string }) {
  const { shell } = useOperatorShell(denied);
  const op = useApp((s) => s.operator);
  const [rewardApi, setRewardApi] = useState<string | null>(null);
  const [issued, setKeysIssued] = useState(false);
  const keysIssued = issued || op.done.keys;
  const [note, setNote] = useState('');

  const doneOf = (id: SetupId): boolean => (id === 'reward-api' ? rewardApi !== null : op.done[id]);
  const firstOpen = SETUP.find((x) => !doneOf(x.id))?.id ?? SETUP[SETUP.length - 1].id;
  const current: SetupId = SETUP.find((x) => x.id === step)?.id ?? firstOpen;
  const index = SETUP.findIndex((x) => x.id === current);
  const last = index === SETUP.length - 1;
  const select = (id: string) => navigate(setupPath(id));

  const steps: Step[] = SETUP.map((x) => ({ id: x.id, label: x.label, done: doneOf(x.id) }));
  const nav = (opts?: { canContinue?: boolean; hint?: string }): ReactNode => (
    <StepNav
      index={index}
      nextLabel={last ? 'Finish setup' : `Continue to ${SETUP[index + 1].label.toLowerCase()}`}
      canContinue={opts?.canContinue ?? true}
      hint={opts?.hint}
      onBack={() => select(SETUP[Math.max(0, index - 1)].id)}
      onNext={() => {
        if (current !== 'reward-api')
          appStore.dispatch({ type: 'step/complete', id: current as StepId });
        if (!last) select(SETUP[index + 1].id);
      }}
    />
  );

  const paidPlan = PLANS.find((p) => p.id === op.paidPlan);
  const panels: Record<string, ReactNode> = {
    signup: (
      <Stack>
        <SignupPanel
          done={op.accountCreated}
          defaults={{ company: 'Cherry Row Ltd', password: 'correct horse' }}
          onSubmit={() => appStore.dispatch({ type: 'account/create' })}
        />
        {nav({ canContinue: op.accountCreated, hint: 'Create the account to continue.' })}
      </Stack>
    ),
    plan: (
      <Stack>
        <PlanPanel
          plans={PLANS}
          planId={op.plan}
          onSelectPlan={(id) => appStore.dispatch({ type: 'plan/select', id })}
          paid={op.planActive}
          paidNote={
            paidPlan
              ? `${paidPlan.name} at ${op.paidAmount ?? paidPlan.price} EUR / month, paid with the test card ending ${op.cardLast4 ?? ''}.`
              : undefined
          }
          processing={op.payment?.status === 'processing'}
          failure={op.payment?.status === 'declined' ? DECLINED : undefined}
          onPay={(last4) => startPayment(op.plan, last4)}
          onCancel={() => {
            if (op.payment?.status === 'processing') cancelPayment(op.payment.id);
          }}
        />
        {nav({ canContinue: op.planActive, hint: 'Pay for a plan to continue.' })}
      </Stack>
    ),
    keys: (
      <Stack>
        <KeysPanel
          keys={keysIssued ? SANDBOX_KEYS : []}
          issueLabel={keysIssued ? undefined : 'Create sandbox credentials'}
          onIssue={() => setKeysIssued(true)}
          onCopy={(id) => setNote(`Copied: ${SANDBOX_KEYS.find((k) => k.id === id)?.label ?? id}`)}
          preview
        />
        {note !== '' && (
          <Text tone="success" role="status">
            {note}
          </Text>
        )}
        {nav()}
      </Stack>
    ),
    'reward-api': (
      <Stack>
        <RewardApiPanel onSubmit={setRewardApi} preview />
        {rewardApi && (
          <Alert tone="success" live="status">
            Kept here as a draft (preview, not sent): {rewardApi}
          </Alert>
        )}
        {nav()}
      </Stack>
    ),
    sandbox: (
      <Stack>
        <SandboxStep />
        {nav({
          canContinue: op.sandboxPassed,
          hint: 'Run the sandbox test and pass all checks to continue.',
        })}
      </Stack>
    ),
    golive: (
      <Stack>
        <GoLivePanel
          steps={[
            { id: 'signup', label: 'Create your account', done: op.accountCreated },
            { id: 'plan', label: 'Pay for a plan', done: op.planActive },
            { id: 'sandbox', label: 'Pass the sandbox test', done: op.sandboxPassed },
          ]}
          onSelectStep={select}
          liveKeys={LIVE_KEYS}
          phase={op.live === 'off' ? 'idle' : op.live === 'awaiting' ? 'waiting' : 'live'}
          onStart={() => appStore.dispatch({ type: 'live/start' })}
          onConfirmDeposit={() => appStore.dispatch({ type: 'live/deposit' })}
        />
        {nav({
          canContinue: op.live === 'live',
          hint: 'Switch to live keys and wait for the first live deposit to continue.',
        })}
      </Stack>
    ),
  };

  return (
    <SetupTemplate
      shell={shell}
      steps={steps}
      current={current}
      onSelectStep={select}
      panels={panels}
      live={op.live === 'live'}
    />
  );
}

/** The sandbox test: the five checks appear one by one, then the store marks the step done. */
function SandboxStep() {
  const passed = useApp((s) => s.operator.sandboxPassed);
  const [running, setRunning] = useState(false);
  const [shown, setShown] = useState(passed ? SANDBOX_STEPS.length : 0);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);
  function run() {
    timers.current.forEach(window.clearTimeout);
    setRunning(true);
    setShown(0);
    SANDBOX_STEPS.forEach((_, i) => {
      timers.current.push(
        window.setTimeout(
          () => {
            setShown(i + 1);
            if (i === SANDBOX_STEPS.length - 1) {
              setRunning(false);
              appStore.dispatch({ type: 'sandbox/pass' });
            }
          },
          SANDBOX_STEP_MS * (i + 1),
        ),
      );
    });
  }
  const entries: EventLogEntry[] = SANDBOX_STEPS.slice(0, shown).map((c) => ({
    ...c,
    status: 'accepted' as EventLogEntry['status'],
  }));
  return (
    <Stack>
      <SandboxPanel entries={entries} running={running} onRun={run} />
      {passed && (
        <Text tone="success" strong role="status">
          All {SANDBOX_STEPS.length} checks passed. Live keys are unlocked.
        </Text>
      )}
    </Stack>
  );
}
