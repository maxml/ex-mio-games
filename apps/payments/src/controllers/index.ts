import type { Type } from '@nestjs/common';
import { BalanceController } from './balance.controller';
import { BillingController } from './billing.controller';
import { CoinsController } from './coins.controller';
import { LedgerAdminController } from './ledger-admin.controller';
import { OperatorPlanController } from './operator-plan.controller';

/**
 * Every controller the payments app serves. `createAppModule` registers exactly this list, and each
 * one is guarded by `ActingCoinGuard` (the wiring and acting-ban tests pin both).
 */
export const paymentsControllers: Type[] = [
  CoinsController,
  BalanceController,
  BillingController,
  LedgerAdminController,
  OperatorPlanController,
];
