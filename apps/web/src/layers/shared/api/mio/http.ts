// Real adapter: the same `MioApi` over HTTP, every response validated against the shared contracts.
// Paths are provisional; the owning services confirm them when the services are wired (docs/CONTRACTS.md,
// "Web read models"). Money-like writes carry an Idempotency-Key. One user action is one key: a spin
// keeps its key across every retry until the server gives a definite answer, so a retry can never
// become a second spin.
import {
  AdminOverview,
  DepositResult,
  HEADER_IDEMPOTENCY_KEY,
  OperatorState,
  PaymentAttemptView,
  PlayerRedemptionView,
  PlayerState,
  SpinResultView,
  WIRE,
} from '../../types';
import { http as defaultHttp, isHttpError, type HttpClient, type ResponseSchema } from '../http';
import { MioApiError, type MioApi } from './api';

const idempotencyKey = (): string => globalThis.crypto.randomUUID();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Backoff for a 409 "same key still in flight": bounded, then the caller sees `retryable`. */
const IN_FLIGHT_BACKOFF_MS = [150, 300, 600];

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!isHttpError(e)) throw e;
    const detail = { status: e.status, serverCode: String(e.code) };
    if (e.status === 403 || e.status === 401) throw new MioApiError('forbidden', e.message, detail);
    if (e.code === 'validation_error' || e.code === 'parse_error')
      throw new MioApiError('bad_response', e.message, detail);
    // A lost reply, a timeout or a 5xx: the write may or may not have happened.
    if (e.status === 0 || e.status >= 500)
      throw new MioApiError('network-or-server', e.message, detail);
    throw new MioApiError('invalid', e.message, detail);
  }
}

/** A spin's 409 is either "no credit left" (explicit code only) or "same key in flight" (retryable). */
function spinError(e: unknown): unknown {
  if (!(e instanceof MioApiError) || e.code !== 'invalid' || e.detail?.status !== 409) return e;
  return e.detail.serverCode === WIRE.spin.noCreditCode
    ? new MioApiError('no_spins', e.message, e.detail)
    : new MioApiError('retryable', e.message, e.detail);
}

export function createHttpApi(client: HttpClient = defaultHttp): MioApi {
  /** The key of a spin whose outcome is not known yet; the next spin call re-asks with the same one. */
  let spinKey: string | null = null;
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
        // Minted once per action, kept while the outcome is unknown, dropped on a definite answer.
        const key = (spinKey ??= idempotencyKey());
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await post(WIRE.spinPath, {}, SpinResultView, {
              [HEADER_IDEMPOTENCY_KEY]: key,
            });
            spinKey = null;
            return result;
          } catch (raw) {
            const e = spinError(raw);
            const code = e instanceof MioApiError ? e.code : null;
            if (code === 'retryable' && attempt < IN_FLIGHT_BACKOFF_MS.length) {
              await sleep(IN_FLIGHT_BACKOFF_MS[attempt]!);
              continue;
            }
            const unknown =
              code === null ||
              code === 'retryable' ||
              code === 'network-or-server' ||
              code === 'bad_response';
            if (!unknown) spinKey = null;
            throw e;
          }
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
