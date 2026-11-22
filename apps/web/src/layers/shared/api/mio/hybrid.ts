// The adapter the app uses with `NEXT_PUBLIC_MIO_API=http`: the real BFF for every call a service answers,
// the mock for the few calls no service has an endpoint for (W-4, W-13, W-14; listed in
// docs/submission/known-gaps.md). The mock is kept per call, never as a fallback for an error: a failed real
// call stays a failed call.
import type { OperatorState } from '../../types';
import { MioApiError, type MioApi } from './api';

/** Calls (and fields) answered by the mock because no service endpoint exists. Mirrors known-gaps.md. */
export const GAP_CALLS = {
  /** G-1 (W-4): `GET /v1/me/transactions` does not exist. */
  'player.getState.history': 'W-4',
  /** G-4 (W-14): no sandbox-check or go-live route (rules and wheel exist and are called). */
  'operator.runSandbox': 'W-14',
  'operator.startGoLive': 'W-14',
  'operator.confirmFirstLiveDeposit': 'W-14',
  'operator.completeStep': 'W-14',
  'operator.selectPlan': 'console state',
  'operator.getState.{rules,wheel,sandbox,live,done}': 'W-14',
  /** G-2 (W-13): no cross-tenant platform reads. */
  'admin.getOverview.{tenants,funnel}': 'W-13',
} as const;

/** The operator-state fields a service answers; everything else of the state is the mock's. */
const REAL_OPERATOR_FIELDS = [
  'accountCreated',
  'plans',
  'planActive',
  'invoicePaid',
  'cardLast4',
  'payment',
  'paidPlan',
  'paidAmount',
  'catalog',
  'redemptions',
  'usage',
  'invoice',
] as const satisfies ReadonlyArray<keyof OperatorState>;

export function createHybridApi(real: MioApi, mock: MioApi): MioApi {
  return {
    player: {
      ...real.player,
      getState: async () => {
        const [state, mockState] = await Promise.all([
          real.player.getState(),
          mock.player.getState(),
        ]);
        return { ...state, history: mockState.history };
      },
    },
    operator: {
      ...real.operator,
      getState: async () => {
        const [live, base] = await Promise.all([
          // No BFF session yet (before the signup step) is "nothing real to show", not a failure.
          real.operator.getState().catch((e: unknown) => {
            if (e instanceof MioApiError && e.code === 'forbidden') return null;
            throw e;
          }),
          mock.operator.getState(),
        ]);
        if (!live) return base;
        const merged: OperatorState = { ...base };
        for (const key of REAL_OPERATOR_FIELDS) Object.assign(merged, { [key]: live[key] });
        return merged;
      },
      // The mock keeps the console's own flag in step, so its go-live gate sees the real signup.
      createAccount: async (input) => {
        await real.operator.createAccount(input);
        await mock.operator.createAccount(input);
      },
      selectPlan: (planId) => mock.operator.selectPlan(planId),
      runSandbox: () => mock.operator.runSandbox(),
      startGoLive: () => mock.operator.startGoLive(),
      confirmFirstLiveDeposit: () => mock.operator.confirmFirstLiveDeposit(),
      // Real PUT first (engagement stores the version); the mock then keeps the console's own copy in step,
      // because no service route reads the published rules and wheel back into the console's shape.
      saveRules: async (rules) => {
        await real.operator.saveRules(rules);
        await mock.operator.saveRules(rules);
      },
      publishWheel: async (weights) => {
        await real.operator.publishWheel(weights);
        await mock.operator.publishWheel(weights);
      },
      completeStep: (step) => mock.operator.completeStep(step),
    },
    admin: {
      ...real.admin,
      getOverview: async () => {
        const [live, base] = await Promise.all([
          real.admin.getOverview(),
          mock.admin.getOverview(),
        ]);
        return { ...base, audit: live.audit };
      },
    },
  };
}
