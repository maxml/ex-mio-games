// The hybrid adapter in live mode: the services' plan ids drive the plan step, and a real paid plan unlocks the
// mock-answered go-live step. Mutation: drop the `selectedPlan` / `mockPlanSynced` handling and these go red.
import { describe, expect, it } from 'vitest';
import type { OperatorState } from '../../types';
import { createStore } from './engine/store';
import { createHybridApi } from './hybrid';
import { createMockApi } from './mock';

const PLANS = [
  { id: 'free', name: 'Free', price: 0, spins: '', extra: '' },
  { id: 'pro', name: 'Pro', price: 49, spins: '', extra: '' },
];

function setup(planActive: boolean) {
  const realBase = createMockApi({ store: createStore() });
  const real = {
    ...realBase,
    operator: {
      ...realBase.operator,
      getState: async (): Promise<OperatorState> => ({
        ...(await realBase.operator.getState()),
        accountCreated: true,
        plans: PLANS,
        planActive,
      }),
    },
  };
  const mock = createMockApi({ store: createStore() });
  return { api: createHybridApi(real, mock), mock };
}

describe('hybrid operator plan in live mode', () => {
  it('defaults to the first paid plan of the service, and keeps the operator selection', async () => {
    const { api } = setup(false);
    expect((await api.operator.getState()).plan).toBe('pro');
    await api.operator.selectPlan('free');
    expect((await api.operator.getState()).plan).toBe('free');
  });

  it('a really active plan settles the mock plan once, so the go-live gate can open', async () => {
    const { api, mock } = setup(true);
    expect((await mock.operator.getState()).planActive).toBe(false);
    await api.operator.getState();
    await new Promise((r) => setTimeout(r, 1500));
    expect((await mock.operator.getState()).planActive).toBe(true);
  });
});
