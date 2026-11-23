'use client';

import { useState } from 'react';
import { useMioMutation, type SignupInput } from '@/layers/shared/api';
import type { OperatorState, OperatorStepId } from '@/layers/shared/types';
import {
  SetupTemplate,
  SignupPanel,
  StepNav,
  type Step,
  type TemplateBase,
} from '@/layers/shared/ui';
import { RequireAccess, useOperatorPage } from '../model/shell';
import {
  AccountStep,
  GoLiveStep,
  KeysStep,
  PlanStep,
  RewardApiStep,
  SandboxStep,
  type StepContext,
} from './setup-steps';

/** The six setup steps, in order. `reward-api` has no server state yet: its draft is local. */
const SETUP = [
  { id: 'signup', label: 'Account', View: AccountStep },
  { id: 'plan', label: 'Plan', View: PlanStep },
  { id: 'keys', label: 'Keys', View: KeysStep },
  { id: 'reward-api', label: 'Reward API', View: RewardApiStep },
  { id: 'sandbox', label: 'Sandbox test', View: SandboxStep },
  { id: 'golive', label: 'Go live', View: GoLiveStep },
] as const;

type SetupId = (typeof SETUP)[number]['id'];
type SetupTemplateBase = Pick<TemplateBase, 'shell' | 'state' | 'errorText'>;

/** Steps the server (or the mock) says are done; only the reward-API draft is local. */
function doneOf(id: SetupId, s: OperatorState, rewardApi: string | null): boolean {
  if (id === 'reward-api') return rewardApi !== null;
  return s.done[id as OperatorStepId] ?? false;
}

function firstOpen(s: OperatorState, rewardApi: string | null): SetupId {
  return SETUP.find((x) => !doneOf(x.id, s, rewardApi))?.id ?? SETUP[SETUP.length - 1]!.id;
}

function SetupBody({
  s,
  start,
  template,
}: {
  s: OperatorState;
  start?: string;
  template: SetupTemplateBase;
}) {
  const [rewardApi, setRewardApi] = useState<string | null>(null);
  const [current, setCurrent] = useState<SetupId>(
    SETUP.find((x) => x.id === start)?.id ?? firstOpen(s, null),
  );
  const complete = useMioMutation<OperatorStepId>((a, id) => a.operator.completeStep(id));
  const index = SETUP.findIndex((x) => x.id === current);
  const select = (id: string) => {
    const hit = SETUP.find((x) => x.id === id);
    if (hit) setCurrent(hit.id);
  };
  const steps: Step[] = SETUP.map((x) => ({
    id: x.id,
    label: x.label,
    done: doneOf(x.id, s, rewardApi),
  }));
  const last = index === SETUP.length - 1;
  const nav: StepContext['nav'] = (opts) => (
    <StepNav
      index={index}
      nextLabel={last ? 'Finish setup' : `Continue to ${SETUP[index + 1]!.label.toLowerCase()}`}
      canContinue={opts?.canContinue ?? true}
      hint={opts?.hint}
      onBack={() => setCurrent(SETUP[Math.max(0, index - 1)]!.id)}
      onNext={() => {
        if (current !== 'reward-api') complete.mutate(current);
        if (!last) setCurrent(SETUP[index + 1]!.id);
      }}
    />
  );
  const ctx: StepContext = { s, nav, goTo: select, rewardApi, saveRewardApi: setRewardApi };
  const panels = Object.fromEntries(SETUP.map((x) => [x.id, <x.View key={x.id} {...ctx} />]));
  return (
    <SetupTemplate
      {...template}
      steps={steps}
      current={current}
      onSelectStep={select}
      panels={panels}
      live={s.live === 'live'}
    />
  );
}

/** Get started: the setup checklist. `step` opens one step (`?step=signup`), `denied` shows the access notice. */
export function SetupPage({ step, denied }: { step?: string; denied?: string }) {
  return (
    <RequireAccess pageId="setup">
      {() => <SetupLoaded step={step} denied={denied} />}
    </RequireAccess>
  );
}

/** A visitor with no session: the Account step only. Creating the account signs them in. */
function ProspectSetup({ template }: { template: SetupTemplateBase }) {
  const create = useMioMutation<SignupInput>((a, input) => a.operator.createAccount(input));
  return (
    <SetupTemplate
      {...template}
      state={undefined}
      steps={[{ id: 'signup', label: 'Account', done: false }]}
      current="signup"
      onSelectStep={() => undefined}
      panels={{
        signup: (
          <SignupPanel
            busy={create.isPending}
            defaults={{ company: 'Cherry Row Ltd', password: 'correct horse' }}
            error={create.isError ? 'The account could not be created. Try again.' : undefined}
            onSubmit={({ company, email, password }) =>
              create.mutate({ companyName: company, email, password })
            }
          />
        ),
      }}
    />
  );
}

function SetupLoaded({ step, denied }: { step?: string; denied?: string }) {
  const { s, shell, state, errorText, role } = useOperatorPage('setup', denied);
  const template = { shell, state, errorText };
  if (!s && role === 'prospect' && state !== 'loading')
    return <ProspectSetup template={template} />;
  // The body mounts once the state is there, so the open step starts from what is really done.
  if (!s)
    return (
      <SetupTemplate
        {...template}
        steps={[]}
        current=""
        onSelectStep={() => undefined}
        panels={{}}
      />
    );
  return <SetupBody s={s} start={step} template={template} />;
}
