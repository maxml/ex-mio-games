import {
  HEADER_IDEMPOTENCY_KEY,
  PAYMENTS_ERROR_CODES,
  PAYMENTS_INTERNAL_ROUTES,
  type PaymentsErrorCode,
} from '@ex-mio/contracts';
import { internalUrl } from '../integrations/identity-client';
import type { CoinsCall, CoinsPort, CoinsRefusalCode, CoinsReply } from './ports';

/**
 * The refusals the saga acts on (`CoinsRefusalCode`, a subset of payments' own `PaymentsErrorCode`,
 * X-5). Anything else, and `idempotency_in_progress` (409, retry the same key) in particular, is
 * transport: this client throws and the saga repeats the same call.
 */
const REFUSALS: ReadonlySet<string> = new Set<CoinsRefusalCode>([
  'insufficient_funds',
  'reserve_already_captured',
  'reserve_already_released',
  'reserve_already_refunded',
  'reserve_not_captured',
  'reserve_not_found',
  'operation_conflict',
  'validation_failed',
  'idempotency_key_reused',
  'forbidden',
]);

export interface HttpCoinsOptions {
  baseUrl: string;
  /** A fresh service token with `aud=payments` (D-14: engagement may call only the coin routes). */
  serviceToken: () => Promise<string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type Verb = 'reserve' | 'capture' | 'release' | 'refund';

/**
 * The HTTP client of the payments reserve, on the names payments owns (X-4, D-12, D-20):
 * `PAYMENTS_INTERNAL_ROUTES` with the tenant in the PATH, a service token, and no tenant, principal
 * or sandbox header. The reserve body is `ReserveCoinsRequest` (`sandbox` rides there, set from the
 * order's server-side flag); capture, release and refund name the reserve in the path and send an
 * empty body. The answer is a value or a throw:
 *  - 2xx with an `amount` -> `{ ok: true, amount }`;
 *  - a documented refusal code in a 4xx body -> `{ ok: false, code }`;
 *  - anything else (5xx, 401/503 of the auth entry point, 409 `idempotency_in_progress`, a timeout,
 *    an unknown code) THROWS, so the caller repeats the same call with the same key. A call whose
 *    outcome is unclear is never read as a refusal.
 */
export class HttpCoinsClient implements CoinsPort {
  constructor(private readonly options: HttpCoinsOptions) {}

  reserve(call: CoinsCall & { amount: number }, idempotencyKey: string): Promise<CoinsReply> {
    return this.post('reserve', call, idempotencyKey, {
      player_id: call.playerId,
      reserve_id: call.reserveId,
      amount: call.amount,
      sandbox: call.sandbox,
    });
  }
  capture(call: CoinsCall, idempotencyKey: string): Promise<CoinsReply> {
    return this.post('capture', call, idempotencyKey, {});
  }
  release(call: CoinsCall, idempotencyKey: string): Promise<CoinsReply> {
    return this.post('release', call, idempotencyKey, {});
  }
  refund(call: CoinsCall, idempotencyKey: string): Promise<CoinsReply> {
    return this.post('refund', call, idempotencyKey, {});
  }

  private async post(
    verb: Verb,
    call: CoinsCall,
    idempotencyKey: string,
    body: Record<string, unknown>,
  ): Promise<CoinsReply> {
    const { baseUrl, serviceToken, timeoutMs = 5000, fetchImpl = fetch } = this.options;
    const url = internalUrl(baseUrl, PAYMENTS_INTERNAL_ROUTES[verb], {
      tenantId: call.tenantId,
      reserveId: call.reserveId,
    });
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await serviceToken()}`,
        [HEADER_IDEMPOTENCY_KEY]: idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const answer = (await res.json().catch(() => null)) as {
      amount?: unknown;
      code?: unknown;
    } | null;
    if (res.ok && typeof answer?.amount === 'number') return { ok: true, amount: answer.amount };
    const code = answer?.code;
    if (
      res.status >= 400 &&
      res.status < 500 &&
      typeof code === 'string' &&
      code in PAYMENTS_ERROR_CODES &&
      PAYMENTS_ERROR_CODES[code as PaymentsErrorCode] === res.status &&
      REFUSALS.has(code)
    )
      return { ok: false, code: code as CoinsRefusalCode };
    throw new Error(`payments ${verb} answered ${res.status}`);
  }
}
