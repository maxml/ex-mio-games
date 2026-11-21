// Real adapter: the same `MioApi` over HTTP, every response validated against the shared contracts.
// Paths are provisional; the owning services confirm them when the epics integrate (docs/CONTRACTS.md,
// "Web read models"). Money-like writes carry an Idempotency-Key so a double click or a retry is one
// request to the server.
import {
  AdminOverview,
  DepositResult,
  HEADER_IDEMPOTENCY_KEY,
  OperatorState,
  PaymentAttemptView,
  PlayerRedemptionView,
  PlayerState,
  SpinResultView,
} from '../../types';
import { http as defaultHttp, isHttpError, type HttpClient, type ResponseSchema } from '../http';
import { MioApiError, type MioApi } from './api';

const idempotencyKey = (): string => globalThis.crypto.randomUUID();

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!isHttpError(e)) throw e;
    if (e.status === 403 || e.status === 401) throw new MioApiError('forbidden', e.message);
    if (e.code === 'validation_error' || e.code === 'parse_error')
      throw new MioApiError('bad_response', e.message);
    if (e.status === 0) throw new MioApiError('network', e.message);
    if (e.status === 409 || e.status === 422) throw new MioApiError('invalid', e.message);
    throw new MioApiError('invalid', e.message);
  }
}

export function createHttpApi(client: HttpClient = defaultHttp): MioApi {
  const post = <T>(
    path: string,
    body: unknown,
    schema: ResponseSchema<T>,
    headers?: Record<string, string>,
  ) => call(() => client.post<T>(path, body, { schema, headers }));
  /** Writes whose response body the screens do not read (they refetch the state instead). */
  const send = async (path: string, body?: unknown, headers?: Record<string, string>) => {
    await call(() => client.post<unknown>(path, body ?? {}, { headers }));
  };

  return {
    player: {
      getState: () =>
        call(() => client.get<PlayerState>('/api/player/state', { schema: PlayerState })),
      spin: async () => {
        try {
          return await post('/api/player/spins', {}, SpinResultView, {
            [HEADER_IDEMPOTENCY_KEY]: idempotencyKey(),
          });
        } catch (e) {
          if (e instanceof MioApiError && e.code === 'invalid')
            throw new MioApiError('no_spins', e.message);
          throw e;
        }
      },
      redeem: (itemId) =>
        post('/api/player/redemptions', { itemId }, PlayerRedemptionView, {
          [HEADER_IDEMPOTENCY_KEY]: idempotencyKey(),
        }),
      simulateDeposit: (eur = 40) => post('/api/sandbox/deposits', { eur }, DepositResult),
      setCasinoDown: (on) => send('/api/sandbox/casino-down', { on }),
    },
    operator: {
      getState: () =>
        call(() => client.get<OperatorState>('/api/operator/state', { schema: OperatorState })),
      createAccount: () => send('/api/operator/account'),
      selectPlan: (planId) => send('/api/operator/plan', { planId }),
      startPayment: (planId, last4) =>
        post('/api/operator/payments', { planId, last4 }, PaymentAttemptView, {
          [HEADER_IDEMPOTENCY_KEY]: idempotencyKey(),
        }),
      cancelPayment: (attemptId) =>
        send(`/api/operator/payments/${encodeURIComponent(attemptId)}/cancel`),
      runSandbox: () => send('/api/operator/sandbox/run'),
      startGoLive: () => send('/api/operator/go-live'),
      confirmFirstLiveDeposit: () => send('/api/operator/go-live/first-deposit'),
      saveRules: (rules) => send('/api/operator/rules', rules),
      publishWheel: (weights) => send('/api/operator/wheel/publish', { weights }),
      setPrice: (itemId, priceCoins) =>
        send(`/api/operator/catalog/${encodeURIComponent(itemId)}/price`, { priceCoins }),
      setVisible: (itemId, visible) =>
        send(`/api/operator/catalog/${encodeURIComponent(itemId)}/visibility`, { visible }),
      completeStep: (step) => send('/api/operator/steps/complete', { step }),
    },
    admin: {
      getOverview: () =>
        call(() => client.get<AdminOverview>('/api/platform/overview', { schema: AdminOverview })),
      actAsTenant: (request) => send('/api/platform/act-as', request),
    },
  };
}
