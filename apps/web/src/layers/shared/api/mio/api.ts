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
  /** The outcome is unknown: a lost reply, a timeout or a 5xx. The same idempotency key may be retried. */
  | 'network-or-server'
  /** 409 in flight: the same key is still being processed. Retry with the same key. */
  | 'retryable'
  | 'bad_response';

export class MioApiError extends Error {
  constructor(
    readonly code: MioApiErrorCode,
    message: string,
    /** What the server said, when it said something; lets an adapter refine the code per call. */
    readonly detail: { status: number; serverCode: string } | null = null,
  ) {
    super(message);
    this.name = 'MioApiError';
  }
}

/** Codes that leave a write's outcome unknown, so the caller must re-query, never assume. */
export const isOutcomeUnknown = (e: unknown): boolean =>
  e instanceof MioApiError &&
  (e.code === 'network-or-server' || e.code === 'retryable' || e.code === 'bad_response');

export interface PlayerApi {
  getState(): Promise<PlayerState>;
  /**
   * The server picks the segment; the client only animates to the returned index. The response is
   * the reward, not the balance: the coins land later through payments (D-1). One user action is one
   * idempotency key; the adapter keeps it across retries until the server gives a definite answer.
   */
  spin(): Promise<SpinResultView>;
  redeem(itemId: string): Promise<PlayerRedemptionView>;
  /** Sandbox casino only: simulates a confirmed deposit. */
  simulateDeposit(eur?: number): Promise<DepositResult>;
  /** Sandbox casino only: make the next reward fail (shows failed, then refunded). */
  setCasinoDown(on: boolean): Promise<void>;
}

export interface SignupInput {
  companyName: string;
  email: string;
  password: string;
}

export interface OperatorApi {
  getState(): Promise<OperatorState>;
  /** W-11: what L1's signup needs. The mock ignores it. */
  createAccount(input: SignupInput): Promise<void>;
  selectPlan(planId: string): Promise<void>;
  /** W-9: `cardNumber` is the provider's test card; only the BFF forwards it, L2 keeps last4 and brand. */
  startPayment(planId: string, last4: string, cardNumber?: string): Promise<PaymentAttemptView>;
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
