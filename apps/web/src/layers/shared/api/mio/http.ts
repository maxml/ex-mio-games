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
import { isOutcomeUnknown, MioApiError, type MioApi } from './api';

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

/**
 * W-6: the store's 409s. `idempotency_in_progress` is the same key still being processed (retry with it);
 * every other one is a definite business answer: the order was refused, nothing was reserved.
 */
const REDEEM_BUSINESS_CODES = new Set([
  'insufficient_funds',
  'out_of_stock',
  'limit_reached',
  'item_inactive',
  'illegal_transition',
]);

function redeemError(e: unknown): unknown {
  if (!(e instanceof MioApiError) || e.code !== 'invalid' || e.detail?.status !== 409) return e;
  if (e.detail.serverCode === 'idempotency_in_progress')
    return new MioApiError('retryable', e.message, e.detail);
  if (REDEEM_BUSINESS_CODES.has(e.detail.serverCode))
    return new MioApiError('redeem_refused', e.message, e.detail);
  return e;
}

export function createHttpApi(client: HttpClient = defaultHttp): MioApi {
  /** The key of a spin whose outcome is not known yet; the next spin call re-asks with the same one. */
  let spinKey: string | null = null;
  /** The same, per item, for a redemption: a retry after a lost reply must not become a second order. */
  const redeemKeys = new Map<string, string>();
  /** And per attempt for a payment cancel (L2 requires the key). */
  const cancelKeys = new Map<string, string>();
  /** And per (plan, card) for starting a payment attempt. */
  const paymentKeys = new Map<string, string>();
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
      redeem: async (itemId) => {
        const key = redeemKeys.get(itemId) ?? idempotencyKey();
        redeemKeys.set(itemId, key);
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await post('/api/player/redemptions', { itemId }, PlayerRedemptionView, {
              [HEADER_IDEMPOTENCY_KEY]: key,
            });
            redeemKeys.delete(itemId);
            return result;
          } catch (raw) {
            const e = redeemError(raw);
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
            // A definite answer ends the action; an unknown outcome keeps the key for the retry.
            if (!unknown) redeemKeys.delete(itemId);
            throw e;
          }
        }
      },
      simulateDeposit: (eur = 40) => post('/api/sandbox/deposits', { eur }, DepositResult),
      setCasinoDown: (on) => send('/api/sandbox/casino-down', { on }),
    },
    operator: {
      getState: () =>
        call(() => client.get<OperatorState>('/api/operator/state', { schema: OperatorState })),
      // W-11: the console's company name, e-mail and password reach L1's signup through the BFF.
      createAccount: (input) => send('/api/operator/account', input),
      // The plan choice is console state, not a service call (L2 has no "selected plan" before payment).
      selectPlan: async () => undefined,
      // W-9: the full test card number goes to the BFF (L2 keeps last4 and brand only). The key is minted per
      // user action and kept while the outcome is unknown.
      startPayment: async (planId, last4, cardNumber) => {
        const slot = `${planId}:${last4}`;
        const key = paymentKeys.get(slot) ?? idempotencyKey();
        paymentKeys.set(slot, key);
        try {
          const result = await post(
            '/api/operator/payments',
            { planId, last4, cardNumber },
            PaymentAttemptView,
            { [HEADER_IDEMPOTENCY_KEY]: key },
          );
          paymentKeys.delete(slot);
          return result;
        } catch (e) {
          if (!isOutcomeUnknown(e)) paymentKeys.delete(slot);
          throw e;
        }
      },
      // W-9: L2 refuses a cancel without an Idempotency-Key (400 `idempotency_key_required`).
      cancelPayment: async (attemptId) => {
        const key = cancelKeys.get(attemptId) ?? idempotencyKey();
        cancelKeys.set(attemptId, key);
        try {
          await send(`/api/operator/payments/${encodeURIComponent(attemptId)}/cancel`, undefined, {
            [HEADER_IDEMPOTENCY_KEY]: key,
          });
          cancelKeys.delete(attemptId);
        } catch (e) {
          if (!isOutcomeUnknown(e)) cancelKeys.delete(attemptId);
          throw e;
        }
      },
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
