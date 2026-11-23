'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useMioMutation, type SignupInput } from '@/layers/shared/api';
import type { IssuedCredentialView, OperatorState } from '@/layers/shared/types';
import {
  Alert,
  GoLivePanel,
  KeysPanel,
  PlanPanel,
  RewardApiPanel,
  SandboxPanel,
  SignupPanel,
  Stack,
  Text,
  type KeyEntry,
} from '@/layers/shared/ui';

/** The panel of one setup step, with Back and Continue around it. */
export interface StepContext {
  s: OperatorState;
  /** Back / Continue for this step; a step passes what is missing while it cannot continue. */
  nav: (opts?: { canContinue?: boolean; hint?: string }) => ReactNode;
  goTo: (stepId: string) => void;
  rewardApi: string | null;
  saveRewardApi: (url: string) => void;
}

const DEMO_DEFAULTS = { company: 'Cherry Row Ltd', password: 'correct horse' };
const DECLINED = 'The card was declined by the test provider. Use 4242 4242 4242 4242 instead.';

export function AccountStep({ s, nav }: StepContext) {
  const create = useMioMutation<SignupInput>((a, input) => a.operator.createAccount(input));
  return (
    <Stack>
      <SignupPanel
        done={s.accountCreated}
        busy={create.isPending}
        defaults={DEMO_DEFAULTS}
        error={create.isError ? 'The account could not be created. Try again.' : undefined}
        onSubmit={({ company, email, password }) =>
          create.mutate({ companyName: company, email, password })
        }
      />
      {nav({ canContinue: s.accountCreated, hint: 'Create the account to continue.' })}
    </Stack>
  );
}

export function PlanStep({ s, nav }: StepContext) {
  const select = useMioMutation<string>((a, id) => a.operator.selectPlan(id));
  const start = useMioMutation<{ planId: string; last4: string; number?: string }, unknown>(
    (a, c) => a.operator.startPayment(c.planId, c.last4, c.number),
  );
  const cancel = useMioMutation<string>((a, id) => a.operator.cancelPayment(id));
  const [attempted, setAttempted] = useState(false);
  const chosen = s.plans.find((p) => p.id === s.plan) ?? s.plans[0];
  const paid = s.plans.find((p) => p.id === s.paidPlan) ?? chosen; // what was charged, not what is selected now
  return (
    <Stack>
      <PlanPanel
        plans={s.plans}
        planId={chosen?.id ?? null}
        onSelectPlan={(id) => select.mutate(id)}
        paid={s.planActive}
        paidNote={
          paid
            ? `${paid.name} at ${s.paidAmount ?? paid.price} EUR / month, paid with the test card ending ${s.cardLast4 ?? ''}.`
            : undefined
        }
        processing={s.payment?.status === 'processing' || start.isPending}
        failure={attempted && s.payment?.status === 'declined' ? DECLINED : undefined}
        onPay={(last4, number) => {
          if (!chosen) return;
          setAttempted(true);
          start.mutate({ planId: chosen.id, last4, number });
        }}
        onCancel={() => {
          if (s.payment?.status === 'processing') cancel.mutate(s.payment.id);
        }}
      />
      {nav({ canContinue: s.planActive, hint: 'Pay for a plan to continue.' })}
    </Stack>
  );
}

export function KeysStep({ nav }: StepContext) {
  const [note, setNote] = useState('');
  const issue = useMioMutation<void, IssuedCredentialView>((a) =>
    a.operator.issueCredentials('sandbox'),
  );
  const issued = issue.data;
  const keys: KeyEntry[] = issued
    ? [
        { id: 'keyId', label: 'Key id (sent with every casino event)', value: issued.keyId },
        { id: 'apiKey', label: 'API key (server to server)', value: issued.apiKey, secret: true },
        {
          id: 'hmacSecret',
          label: 'HMAC secret (signs casino events and launch tokens)',
          value: issued.hmacSecret,
          secret: true,
        },
      ]
    : [];
  const copy = (keyId: string) => {
    const key = keys.find((k) => k.id === keyId);
    if (!key) return;
    void navigator.clipboard?.writeText(key.value).then(
      () => setNote(`Copied: ${key.label}`),
      () => setNote(`Could not copy ${key.label}`),
    );
  };
  return (
    <Stack>
      <KeysPanel
        keys={keys}
        issueLabel={issued ? undefined : 'Create sandbox credentials'}
        onIssue={() => issue.mutate()}
        busy={issue.isPending}
        onCopy={copy}
        preview
      />
      {issue.isError && <Alert tone="danger">Credentials could not be created. Try again.</Alert>}
      {note !== '' && (
        <Text tone="success" role="status">
          {note}
        </Text>
      )}
      {nav()}
    </Stack>
  );
}

export function RewardApiStep({ nav, rewardApi, saveRewardApi }: StepContext) {
  return (
    <Stack>
      <RewardApiPanel onSubmit={saveRewardApi} preview />
      {rewardApi && (
        <Alert tone="success" live="status">
          Kept here as a draft (preview, not sent): {rewardApi}
        </Alert>
      )}
      {nav()}
    </Stack>
  );
}

export function SandboxStep({ s, nav }: StepContext) {
  const pass = useMioMutation<void>((a) => a.operator.runSandbox());
  const [running, setRunning] = useState(false);
  const [shown, setShown] = useState(s.sandboxPassed ? s.sandboxChecks.length : 0);
  const run = useRef(0);
  const timers = useRef<number[]>([]);
  function start() {
    const mine = ++run.current;
    timers.current.forEach(window.clearTimeout);
    setRunning(true);
    setShown(0);
    s.sandboxChecks.forEach((_, i) => {
      timers.current.push(
        window.setTimeout(
          () => {
            if (run.current !== mine) return;
            setShown(i + 1);
            if (i === s.sandboxChecks.length - 1) {
              setRunning(false);
              pass.mutate();
            }
          },
          500 * (i + 1),
        ),
      );
    });
  }
  return (
    <Stack>
      <SandboxPanel
        entries={s.sandboxChecks
          .slice(0, shown)
          .map((c) => ({ ...c, status: 'accepted' as const }))}
        running={running}
        onRun={start}
      />
      {s.sandboxPassed && (
        <Text tone="success" strong role="status">
          All {s.sandboxChecks.length} checks passed. Live keys are unlocked.
        </Text>
      )}
      {nav({
        canContinue: s.sandboxPassed,
        hint: 'Run the sandbox test and pass all checks to continue.',
      })}
    </Stack>
  );
}

export function GoLiveStep({ s, nav, goTo }: StepContext) {
  const start = useMioMutation<void>((a) => a.operator.startGoLive());
  const firstDeposit = useMioMutation<void>((a) => a.operator.confirmFirstLiveDeposit());
  return (
    <Stack>
      <GoLivePanel
        steps={[
          { id: 'signup', label: 'Create your account', done: s.accountCreated },
          { id: 'plan', label: 'Pay for a plan', done: s.planActive },
          { id: 'sandbox', label: 'Pass the sandbox test', done: s.sandboxPassed },
        ]}
        onSelectStep={goTo}
        liveKeys={[
          { id: 'pk', label: 'Publishable key (widget)', value: 'pk_live_EXAMPLE_00000000' },
          {
            id: 'sk',
            label: 'Secret key (server to server)',
            value: 'sk_live_EXAMPLE_0000000000',
            secret: true,
          },
        ]}
        phase={s.live === 'off' ? 'idle' : s.live === 'awaiting' ? 'waiting' : 'live'}
        onStart={() => start.mutate()}
        onConfirmDeposit={() => firstDeposit.mutate()}
      />
      {nav({
        canContinue: s.live === 'live',
        hint: 'Switch to live keys and wait for the first live deposit to continue.',
      })}
    </Stack>
  );
}
