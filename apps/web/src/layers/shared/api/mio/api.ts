// The typed surface the three screens talk to. Two adapters implement it: `createMockApi` (in-memory,
// default) and `createHttpApi` (real services, validated against the shared zod contracts). Screens
// never know which one they have; `getMioApi` picks one from `NEXT_PUBLIC_MIO_API`.
import type {
  ActAsTenantRequest,
  AdminOverview,
  DepositResult,
  OperatorState,
  OperatorStepId,
  PaymentAttemptView,
  PlayerRedemptionView,
  PlayerState,
  RulesView,
  SpinResultView,
} from '../../types';

export type MioApiErrorCode =
  | 'no_spins'
  | 'redeem_refused'
  | 'invalid'
  | 'forbidden'
  | 'network'
  | 'bad_response';

export class MioApiError extends Error {
  constructor(
    readonly code: MioApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MioApiError';
  }
}

export interface PlayerApi {
  getState(): Promise<PlayerState>;
  /** The server picks the segment; the client only animates to the returned index. */
  spin(): Promise<SpinResultView>;
  redeem(itemId: string): Promise<PlayerRedemptionView>;
  /** Sandbox casino only: simulates a confirmed deposit. */
  simulateDeposit(eur?: number): Promise<DepositResult>;
  /** Sandbox casino only: make the next reward fail (shows failed, then refunded). */
  setCasinoDown(on: boolean): Promise<void>;
}

export interface OperatorApi {
  getState(): Promise<OperatorState>;
  createAccount(): Promise<void>;
  selectPlan(planId: string): Promise<void>;
  startPayment(planId: string, last4: string): Promise<PaymentAttemptView>;
  cancelPayment(attemptId: string): Promise<void>;
  runSandbox(): Promise<void>;
  startGoLive(): Promise<void>;
  confirmFirstLiveDeposit(): Promise<void>;
  saveRules(rules: RulesView): Promise<void>;
  publishWheel(weights: number[]): Promise<void>;
  setPrice(itemId: string, priceCoins: number): Promise<void>;
  setVisible(itemId: string, visible: boolean): Promise<void>;
  completeStep(step: OperatorStepId): Promise<void>;
}

export interface AdminApi {
  getOverview(): Promise<AdminOverview>;
  /** Needs a reason; the server writes the audit entry. */
  actAsTenant(request: ActAsTenantRequest): Promise<void>;
}

export interface MioApi {
  player: PlayerApi;
  operator: OperatorApi;
  admin: AdminApi;
}
