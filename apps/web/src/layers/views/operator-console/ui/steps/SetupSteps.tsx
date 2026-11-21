'use client';

import { useRef, useState } from 'react';
import { useMioMutation, type SignupInput } from '@/layers/shared/api';
import {
  Alert,
  Button,
  Card,
  CardForm,
  EventLog,
  Field,
  Input,
  KeyList,
  KeyRow,
  Link,
  PlanCard,
  StatusPill,
  Text,
  Toast,
} from '@/layers/shared/ui';
import type { StepProps } from './types';

export function SignupStep({ s, nav }: StepProps) {
  const create = useMioMutation<SignupInput>((a, input) => a.operator.createAccount(input));
  const [company, setCompany] = useState('Cherry Row Ltd');
  const [password, setPassword] = useState('correct horse');
  const [email, setEmail] = useState('');
  const bad = email !== '' && !/^\S+@\S+\.\S+$/.test(email);
  const created = s.accountCreated;
  return (
    <Card
      title="Create your operator account"
      description="No card needed to start. You get a sandbox straight away."
    >
      <form
        className="grid max-w-md gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!bad && email && !created) create.mutate({ companyName: company, email, password });
        }}
      >
        <Field label="Company name">
          {({ id }) => (
            <Input id={id} value={company} onChange={(e) => setCompany(e.target.value)} />
          )}
        </Field>
        <Field
          label="Work email"
          hint="We send the verification link here."
          error={bad ? 'Enter an email like name@company.com' : undefined}
        >
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              invalid={invalid}
              aria-describedby={describedBy}
            />
          )}
        </Field>
        <Field label="Password">
          {({ id }) => (
            <Input
              id={id}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={created} loading={create.isPending}>
          {created ? 'Account created' : 'Create account'}
        </Button>
      </form>
      {created && (
        <Alert tone="success" className="mt-4">
          Account created (mock). A sandbox is ready for you.
        </Alert>
      )}
      {nav({ canContinue: created, hint: 'Create the account to continue.' })}
    </Card>
  );
}

function Checkout({
  s,
  planId,
  amount,
  description,
  onCancel,
}: {
  s: StepProps['s'];
  planId: string;
  amount: number;
  description: string;
  onCancel: () => void;
}) {
  const start = useMioMutation<{ last4: string; number?: string }, unknown>((a, c) =>
    a.operator.startPayment(planId, c.last4, c.number),
  );
  const cancel = useMioMutation<string>((a, id) => a.operator.cancelPayment(id));
  const [attempted, setAttempted] = useState(false);
  const card = useRef<string | undefined>(undefined);
  const processing = s.payment?.status === 'processing' || start.isPending;
  const declined = attempted && s.payment?.status === 'declined';
  return (
    <CardForm
      onSubmitCard={(digits) => {
        card.current = digits;
      }}
      amount={amount}
      description={description}
      testMode
      processing={processing}
      failure={
        declined
          ? 'The card was declined by the test provider. Use 4242 4242 4242 4242 instead.'
          : undefined
      }
      onSubmit={(last4) => {
        setAttempted(true);
        start.mutate({ last4, number: card.current });
      }}
      onCancel={() => {
        if (s.payment?.status === 'processing') cancel.mutate(s.payment.id);
        onCancel();
      }}
    />
  );
}

export function PlanStep({ s, nav }: StepProps) {
  const select = useMioMutation<string>((a, id) => a.operator.selectPlan(id));
  const [paying, setPaying] = useState(false);
  const chosen = s.plans.find((p) => p.id === s.plan) ?? s.plans[0];
  if (!chosen) return null;

  if (s.planActive) {
    const paid = s.plans.find((p) => p.id === s.paidPlan) ?? chosen; // what was charged, not what is selected now
    return (
      <Card
        title="Plan active"
        description="Payment received through the fake provider (test mode)."
      >
        <Text className="flex flex-wrap items-center gap-2">
          <StatusPill status="active" />
          <span className="font-semibold">{paid.name}</span> at {s.paidAmount ?? paid.price} EUR /
          month, paid with the test card ending {s.cardLast4}.
        </Text>
        {nav()}
      </Card>
    );
  }
  if (paying || s.payment?.status === 'processing') {
    return (
      <Checkout
        s={s}
        planId={chosen.id}
        amount={chosen.price}
        description={`${chosen.name} plan, first month`}
        onCancel={() => setPaying(false)}
      />
    );
  }
  return (
    <Card
      title="Choose a plan"
      description="Billed monthly. Pay now to activate it; cancel any time."
    >
      <div role="radiogroup" aria-label="Plan" className="grid gap-3 md:grid-cols-3">
        {s.plans.map((p) => (
          <PlanCard
            key={p.id}
            {...p}
            selected={s.plan === p.id}
            onSelect={() => select.mutate(p.id)}
          />
        ))}
      </div>
      <Text tone="muted" className="mt-4">
        Payment uses the fake provider in test mode; a real card form arrives with the Stripe
        provider.
      </Text>
      <Button className="mt-4" onClick={() => setPaying(true)}>
        Choose plan and pay
      </Button>
      {nav({ canContinue: s.planActive, hint: 'Pay for a plan to continue.' })}
    </Card>
  );
}

export function KeysStep({ nav }: StepProps) {
  const [shown, setShown] = useState(false);
  const [note, setNote] = useState('');
  const rotate = () => setNote('Webhook secret rotated: the old secret works for 24 more hours.');
  const copy = (label: string) => () => setNote(`Copied: ${label} (mock, nothing is copied)`);
  return (
    <Card
      title="Integration keys"
      description="Test keys. Live keys unlock after the sandbox test passes."
    >
      <KeyList>
        <KeyRow
          label="Publishable key (widget)"
          value="pk_test_9d41c0a7e2b84f10"
          onCopy={copy('Publishable key')}
        />
        <KeyRow
          label="Secret key (server to server)"
          value={shown ? 'sk_test_EXAMPLE_0000000000' : 'sk_test_' + '•'.repeat(20)}
          onCopy={copy('Secret key')}
        />
        <KeyRow
          label="Webhook secret (verify casino events)"
          value={shown ? 'whsec_a83d0c1177ef42b9' : 'whsec_' + '•'.repeat(16)}
          onCopy={copy('Webhook secret')}
        />
      </KeyList>
      <Toast
        className="mt-3 empty:hidden"
        message={note}
        onDismiss={() => setNote('')}
        tone="success"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setShown((v) => !v)}>
          {shown ? 'Hide secrets' : 'Reveal secrets'}
        </Button>
        <Button variant="danger" onClick={rotate}>
          Rotate webhook secret
        </Button>
      </div>
      {nav()}
    </Card>
  );
}

export function SandboxStep({ s, nav }: StepProps) {
  const pass = useMioMutation<void>((a) => a.operator.runSandbox());
  const [state, setState] = useState<'idle' | 'running' | 'done'>(
    s.sandboxPassed ? 'done' : 'idle',
  );
  const [shown, setShown] = useState(s.sandboxPassed ? s.sandboxChecks.length : 0);
  const run = useRef(0);
  const timers = useRef<number[]>([]);
  function start() {
    const mine = ++run.current;
    timers.current.forEach(window.clearTimeout);
    setState('running');
    setShown(0);
    s.sandboxChecks.forEach((_, i) => {
      timers.current.push(
        window.setTimeout(
          () => {
            if (run.current !== mine) return;
            setShown(i + 1);
            if (i === s.sandboxChecks.length - 1) {
              setState('done');
              pass.mutate();
            }
          },
          500 * (i + 1),
        ),
      );
    });
  }
  return (
    <Card
      title="Sandbox casino test"
      description="Our simulated casino sends a deposit, then checks that your integration behaves."
      actions={
        <Button onClick={start} loading={state === 'running'}>
          {state === 'idle' ? 'Run test' : 'Run again'}
        </Button>
      }
    >
      <EventLog
        entries={s.sandboxChecks
          .slice(0, shown)
          .map((c) => ({ ...c, status: 'accepted' as const }))}
      />
      {state === 'done' && (
        <Text tone="success" strong className="mt-4" role="status">
          All {s.sandboxChecks.length} checks passed. Live keys are unlocked.
        </Text>
      )}
      {nav({
        canContinue: s.sandboxPassed,
        hint: 'Run the sandbox test and pass all checks to continue.',
      })}
    </Card>
  );
}

export function GoLiveStep({ s, nav, goTo }: StepProps) {
  const start = useMioMutation<void>((a) => a.operator.startGoLive());
  const firstDeposit = useMioMutation<void>((a) => a.operator.confirmFirstLiveDeposit());
  const missing = [
    !s.accountCreated && { label: 'Create your account', step: 0 },
    !s.planActive && { label: 'Pay for a plan', step: 1 },
    !s.sandboxPassed && { label: 'Pass the sandbox test', step: 3 },
  ].filter((m): m is { label: string; step: number } => m !== false);
  return (
    <Card
      title="Go live"
      description="Switch from test keys to live keys and wait for the first real deposit from your casino."
    >
      {missing.length > 0 && s.live === 'off' ? (
        <Alert tone="warning">
          Live keys stay locked until an account exists, a plan is paid and the sandbox test passes.
          Still missing:
          <ul className="mt-1 list-disc pl-5">
            {missing.map((m) => (
              <li key={m.step}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="underline"
                  onClick={() => goTo(m.step)}
                >
                  {m.label}
                </Button>
              </li>
            ))}
          </ul>
        </Alert>
      ) : (
        <div className="grid gap-4">
          <KeyList>
            <KeyRow label="Publishable key (widget)" value="pk_live_EXAMPLE_00000000" />
            <KeyRow
              label="Secret key (server to server)"
              value={
                s.live === 'off' ? 'Shown after you switch to live' : 'sk_live_EXAMPLE_0000000000'
              }
            />
          </KeyList>
          {s.live === 'off' && (
            <div>
              <Button loading={start.isPending} onClick={() => start.mutate()}>
                Switch to live keys
              </Button>
            </div>
          )}
          {s.live === 'awaiting' && (
            <div className="grid gap-3">
              <Alert tone="info">
                <span role="status">
                  Live keys are on. Waiting for the first live deposit event from your casino.
                </span>
              </Alert>
              <div>
                <Button
                  variant="secondary"
                  loading={firstDeposit.isPending}
                  onClick={() => firstDeposit.mutate()}
                >
                  Simulate the first live deposit (mock casino)
                </Button>
              </div>
            </div>
          )}
          {s.live === 'live' && (
            <Alert tone="success">
              <span role="status">
                <strong>You are live.</strong> First live deposit received: 40 EUR, spins granted
                under your rules. Players now see the widget.{' '}
                <Link href="../embed/widget">Open the player widget</Link>
              </span>
            </Alert>
          )}
        </div>
      )}
      {nav({
        canContinue: s.live === 'live',
        hint: 'Switch to live keys and wait for the first live deposit to continue.',
      })}
    </Card>
  );
}
