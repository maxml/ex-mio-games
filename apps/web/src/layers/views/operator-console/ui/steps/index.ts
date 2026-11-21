import type { ComponentType } from 'react';
import type { OperatorStepId } from '@/layers/shared/types';
import { RulesStep, StoreStep, WheelStep } from './ConfigSteps';
import { BillingStep, RedemptionsStep } from './OpsSteps';
import { GoLiveStep, KeysStep, PlanStep, SandboxStep, SignupStep } from './SetupSteps';
import type { StepProps } from './types';

/** Wizard step id to its screen. */
export const ConfigStepsMap: Record<OperatorStepId, ComponentType<StepProps>> = {
  signup: SignupStep,
  plan: PlanStep,
  keys: KeysStep,
  sandbox: SandboxStep,
  golive: GoLiveStep,
  rules: RulesStep,
  wheel: WheelStep,
  store: StoreStep,
  redemptions: RedemptionsStep,
  billing: BillingStep,
};
