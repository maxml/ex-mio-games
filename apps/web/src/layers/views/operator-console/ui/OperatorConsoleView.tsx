'use client';

import { useState, type ReactNode } from 'react';
import { useMioMutation, useOperatorState } from '@/layers/shared/api';
import { Alert, Button, Page, StepNav, Stepper } from '@/layers/shared/ui';
import { ConfigStepsMap } from './steps';
import { STEPS } from './steps/types';

/**
 * Onboarding wizard: signup, plan, keys, sandbox, go live, rules, wheel weights, catalog,
 * redemptions, usage and invoice. The step bar ticks only what the server says is done.
 */
export function OperatorConsoleView() {
  const { data: s, isPending, isError, refetch } = useOperatorState();
  const [step, setStep] = useState(0);
  const complete = useMioMutation<(typeof STEPS)[number]['id']>((a, id) =>
    a.operator.completeStep(id),
  );

  if (isPending) return <Page title="Operator console">Loading...</Page>;
  if (isError || !s) {
    return (
      <Page title="Operator console">
        <Alert tone="danger">The console could not be loaded.</Alert>
        <Button className="mt-3" variant="secondary" onClick={() => void refetch()}>
          Try again
        </Button>
      </Page>
    );
  }

  const current = STEPS[step] ?? STEPS[0]!;
  const last = step === STEPS.length - 1;
  const nav = (opts?: { canContinue?: boolean; hint?: string }): ReactNode => (
    <StepNav
      index={step}
      nextLabel={last ? 'Finish setup' : `Continue to ${STEPS[step + 1]!.label.toLowerCase()}`}
      canContinue={opts?.canContinue ?? true}
      hint={opts?.hint}
      onBack={() => setStep((i) => Math.max(0, i - 1))}
      onNext={() => {
        complete.mutate(current.id);
        if (!last) setStep(step + 1);
      }}
    />
  );
  const Step = ConfigStepsMap[current.id];

  return (
    <Page
      title="Operator console"
      intro="From signup to a paid, live integration. Each step has Back and Continue; the step bar ticks only what is really done."
    >
      <Stepper
        steps={STEPS.map((x) => ({ ...x, done: s.done[x.id] ?? false }))}
        current={step}
        onSelect={setStep}
        className="mb-6"
      />
      <Step s={s} nav={nav} goTo={setStep} />
    </Page>
  );
}
