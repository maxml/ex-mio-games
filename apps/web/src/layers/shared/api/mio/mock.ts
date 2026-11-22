// In-memory adapter: the prototype's reducer behind the async `MioApi`. One store backs the player
// widget, the operator console and the admin, so an operator change is what the player sees next.
// Money-like rules (credit a spin once per id, refund once, pay what the price list says) live in
// the pure reducer and are unit-tested there.
import { ActAsTenantRequest as ActAsTenantSchema } from '../../types';
import type { AdminOverview, OperatorState, PlayerState, RulesView } from '../../types';
import { MioApiError, type MioApi } from './api';
import {
  FUNNEL,
  PLANS,
  REDEMPTIONS,
  SANDBOX_STEPS,
  TENANTS,
  USAGE_DAYS,
  WHEEL_REWARDS,
} from './engine/data';
import { rulesValid, weightsValid } from './engine/reducer';
import {
  appStore,
  cancelPayment,
  createStore,
  requestSpin,
  simulateDeposit,
  startPayment,
  startRedeem,
  type Store,
} from './engine/store';

export interface MockApiOptions {
  /** Defaults to the shared singleton so every screen in one tab sees the same state. */
  store?: Store;
}

export function createMockApi({ store = appStore }: MockApiOptions = {}): MioApi {
  const audit: AdminOverview['audit'] = [];
  let auditSeq = 0;

  // D-1: the spin answer carries the reward, payments credits the coins later. The mock models that
  // lag: the first read after a spin still shows the old balance, the next one has the credit.
  let creditLagReads = 0;

  const playerState = (): PlayerState => {
    const s = store.get();
    let coins = s.player.coins;
    if (creditLagReads > 0 && s.player.lastSpin) {
      creditLagReads -= 1;
      coins -= s.player.lastSpin.coins;
    }
    return {
      coins,
      spins: s.player.spins,
      wheel: WHEEL_REWARDS.map((r) => ({ id: r.id, label: r.label })),
      store: s.operator.catalog
        .filter((i) => i.visible)
        .map(({ visible: _visible, ...item }) => item),
      history: s.player.history,
      redemptions: s.player.redemptions.map((r) => ({
        ...r,
        status: r.status as PlayerState['redemptions'][number]['status'],
      })),
      lastSpin: s.player.lastSpin,
      casinoDown: s.player.casinoDown,
    };
  };

  const operatorState = (): OperatorState => {
    const o = store.get().operator;
    const p = PLANS.find((x) => x.id === (o.invoicePaid ? o.paidPlan : o.plan)) ?? PLANS[1]!;
    const included = Number(p.spins.split(' ')[0]!.replace(/,/g, ''));
    const mine = store.get().player.redemptions.map((r) => ({
      id: r.id,
      player: 'p_you (demo)',
      item: r.item,
      coins: r.coins,
      status: r.status as OperatorState['redemptions'][number]['status'],
      at: 'Just now',
    }));
    return {
      done: o.done,
      accountCreated: o.accountCreated,
      plans: PLANS,
      plan: o.plan,
      planActive: o.planActive,
      invoicePaid: o.invoicePaid,
      cardLast4: o.cardLast4,
      payment: o.payment,
      paidPlan: o.paidPlan,
      paidAmount: o.paidAmount,
      sandboxPassed: o.sandboxPassed,
      sandboxChecks: SANDBOX_STEPS,
      live: o.live,
      rules: o.rules,
      rulesSaved: o.rulesSaved,
      wheel: {
        version: o.wheel.version,
        rewards: WHEEL_REWARDS.map((r, i) => ({ ...r, weight: o.wheel.weights[i] ?? r.weight })),
        versions: o.wheel.versions.map((v) => ({
          ...v,
          state: v.state as 'draft' | 'published' | 'archived',
        })),
      },
      catalog: o.catalog,
      redemptions: [
        ...mine,
        ...REDEMPTIONS.map((r) => ({
          ...r,
          status: r.status as OperatorState['redemptions'][number]['status'],
        })),
      ],
      usage: { spinsThisMonth: 98200, included, activePlayers: 4120, daily: USAGE_DAYS },
      invoice: {
        period: 'November 2026',
        paid: o.invoicePaid,
        plan: p.id,
        total: p.price,
        lines: [
          { id: 'i1', item: `${p.name} plan, November`, qty: '1', amount: p.price },
          {
            id: 'i2',
            item: `Included spins (${p.spins.split(' ')[0]})`,
            qty: p.spins.split(' ')[0]!,
            amount: 0,
          },
          { id: 'i3', item: 'Overage spins at 2.0 EUR per 1,000', qty: '0', amount: 0 },
        ],
      },
    };
  };

  return {
    player: {
      getState: async () => playerState(),
      spin: async () => {
        const result = requestSpin(store);
        if (!result) throw new MioApiError('no_spins', 'No spins left');
        creditLagReads = 1;
        return result;
      },
      redeem: async (itemId) => {
        const id = startRedeem(itemId, store);
        const r = id ? store.get().player.redemptions.find((x) => x.id === id) : undefined;
        if (!r) throw new MioApiError('redeem_refused', 'This item cannot be redeemed now');
        return { ...r, status: r.status as 'pending' };
      },
      simulateDeposit: async (eur = 40) => ({
        accepted: true,
        granted: simulateDeposit(store, eur),
      }),
      setCasinoDown: async (on) => store.dispatch({ type: 'player/casinoDown', on }),
    },
    operator: {
      getState: async () => operatorState(),
      createAccount: async () => store.dispatch({ type: 'account/create' }),
      // Mock mode only: obviously fake values, nothing is issued.
      issueCredentials: async (environment) => ({
        environment,
        keyId: 'key_EXAMPLE_mock',
        apiKey: 'EXAMPLE_api_key_mock',
        hmacSecret: 'EXAMPLE_hmac_secret_mock',
      }),
      selectPlan: async (id) => store.dispatch({ type: 'plan/select', id }),
      startPayment: async (planId, last4) => {
        const id = startPayment(planId, last4, store);
        const pay = store.get().operator.payment;
        if (!id || !pay) throw new MioApiError('invalid', 'A payment cannot be started now');
        return pay;
      },
      cancelPayment: async (id) => cancelPayment(id, store),
      runSandbox: async () => store.dispatch({ type: 'sandbox/pass' }),
      startGoLive: async () => {
        store.dispatch({ type: 'live/start' });
        if (store.get().operator.live === 'off')
          throw new MioApiError(
            'forbidden',
            'Live keys need an account, a paid plan and a passed sandbox test',
          );
      },
      confirmFirstLiveDeposit: async () => store.dispatch({ type: 'live/deposit' }),
      saveRules: async (rules: RulesView) => {
        if (!rulesValid(rules))
          throw new MioApiError('invalid', 'Rules must be whole numbers, at least 1');
        store.dispatch({ type: 'rules/save', rules });
      },
      publishWheel: async (weights) => {
        if (!weightsValid(weights))
          throw new MioApiError('invalid', 'Every weight must be greater than 0');
        store.dispatch({ type: 'wheel/publish', weights });
      },
      setPrice: async (id, price) => store.dispatch({ type: 'catalog/price', id, price }),
      setVisible: async (id, on) => store.dispatch({ type: 'catalog/visible', id, on }),
      completeStep: async (id) => store.dispatch({ type: 'step/complete', id }),
    },
    admin: {
      getOverview: async () => ({
        tenants: TENANTS.map((t) => ({
          ...t,
          status: t.status as 'trial' | 'active' | 'past_due' | 'suspended',
        })),
        funnel: FUNNEL,
        audit: [...audit],
      }),
      actAsTenant: async (request) => {
        const parsed = ActAsTenantSchema.safeParse(request);
        if (!parsed.success)
          throw new MioApiError('invalid', 'A reason of at least 8 characters is required');
        audit.unshift({
          id: `a-${++auditSeq}`,
          tenantId: parsed.data.tenantId,
          reason: parsed.data.reason,
          at: 'Just now',
        });
      },
    },
  };
}

/** A fresh isolated mock (tests, stories). */
export const createIsolatedMockApi = (): MioApi => createMockApi({ store: createStore() });
