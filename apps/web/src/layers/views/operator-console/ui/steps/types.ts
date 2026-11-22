import type { ReactNode } from 'react';
import type { OperatorState, OperatorStepId } from '@/layers/shared/types';

export const STEPS: { id: OperatorStepId; label: string }[] = [
  { id: 'signup', label: 'Sign up' },
  { id: 'plan', label: 'Plan' },
  { id: 'keys', label: 'Keys' },
  { id: 'sandbox', label: 'Sandbox test' },
  { id: 'golive', label: 'Go live' },
  { id: 'rules', label: 'Rules' },
  { id: 'wheel', label: 'Wheel' },
  { id: 'store', label: 'Store' },
  { id: 'redemptions', label: 'Redemptions' },
  { id: 'billing', label: 'Usage & invoice' },
];

export interface StepProps {
  s: OperatorState;
  /** Back / Continue for this step; a step passes what is missing while it cannot continue. */
  nav: (opts?: { canContinue?: boolean; hint?: string }) => ReactNode;
  goTo: (index: number) => void;
}
