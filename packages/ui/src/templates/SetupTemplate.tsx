import type { ReactNode } from 'react';
import { Button } from '../Button';
import { EmptyState } from '../EmptyState';
import { SetupChecklist } from '../SetupChecklist';
import type { Step } from '../Stepper';
import { Link } from '../Typography';
import { Stack } from '../Layout';
import { OperatorShell, ReadOnlyNotice, StateBody, type TemplateBase } from './OperatorShell';

export interface SetupTemplateProps extends TemplateBase {
  steps: Step[];
  /** Id of the open step. */
  current: string;
  onSelectStep: (stepId: string) => void;
  /** The panel to show for each step id; the page builds them from the panel components. */
  panels: Record<string, ReactNode>;
  /** Every step is done and the operator is live: shows "You are live". */
  live?: boolean;
  engagementHref?: string;
  operationsHref?: string;
}

/** Get started: the setup checklist with the open step's panel under it. */
export function SetupTemplate({
  shell,
  state,
  errorText,
  readOnly,
  steps,
  current,
  onSelectStep,
  panels,
  live,
  engagementHref = '/operator/engagement/rules',
  operationsHref = '/operator/operations/redemptions',
}: SetupTemplateProps) {
  return (
    <OperatorShell
      {...shell}
      current="setup"
      title="Set up your integration"
      intro="Six steps from account to your first live deposit."
    >
      <StateBody
        state={state}
        errorText={errorText}
        empty={
          <EmptyState
            title="Nothing is set up yet"
            action={<Button onClick={() => onSelectStep(steps[0]?.id ?? 'signup')}>Start</Button>}
          >
            Start with your account.
          </EmptyState>
        }
      >
        <Stack gap={6}>
          <SetupChecklist steps={steps} current={current} onSelect={onSelectStep} />
          {readOnly ? (
            <ReadOnlyNotice />
          ) : live ? (
            <EmptyState title="You are live">
              Next: <Link href={engagementHref}>set up engagement</Link> or{' '}
              <Link href={operationsHref}>open operations</Link>.
            </EmptyState>
          ) : (
            panels[current]
          )}
        </Stack>
      </StateBody>
    </OperatorShell>
  );
}
