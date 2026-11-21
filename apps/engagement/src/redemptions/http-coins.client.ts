import { HEADER_IDEMPOTENCY_KEY, HEADER_TENANT_ID } from '@ex-mio/contracts';
import type { CoinsCall, CoinsPort, CoinsRefusalCode, CoinsReply } from './ports';

const REFUSALS: ReadonlySet<string> = new Set<CoinsRefusalCode>([
  'insufficient_funds',
  'invalid_reserve_transition',
  'reserve_not_found',
  'operation_conflict',
]);

export interface HttpCoinsOptions {
  baseUrl: string;
  serviceId: string;
  serviceToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type Verb = 'reserve' | 'capture' | 'release' | 'refund';

/**
 * The HTTP client of the payments reserve (`POST /internal/v1/coins/reserve|capture|release|refund`,
 * spec 4.5; names ASSUMED from the payments Stage A contract). The answer is a value or a throw:
 *  - 2xx with an `amount` -> `{ ok: true, amount }`;
 *  - 404 / 409 with a known refusal `code` -> `{ ok: false, code }`;
 *  - anything else (5xx, timeout, network, an unknown 4xx) THROWS, so the caller repeats the same
 *    call with the same key. A call whose outcome is unclear is never read as a refusal.
 * The sandbox flag travels as a header, never in the body.
 */
export class HttpCoinsClient implements CoinsPort {
  constructor(private readonly options: HttpCoinsOptions) {}

  reserve(call: CoinsCall & { amount: number }, idempotencyKey: string): Promise<CoinsReply> {
    return this.post('reserve', call, idempotencyKey, { amount: call.amount });
  }
  capture(call: CoinsCall, idempotencyKey: string): Promise<CoinsReply> {
    return this.post('capture', call, idempotencyKey);
  }
  release(call: CoinsCall, idempotencyKey: string): Promise<CoinsReply> {
    return this.post('release', call, idempotencyKey);
  }
  refund(call: CoinsCall, idempotencyKey: string): Promise<CoinsReply> {
    return this.post('refund', call, idempotencyKey);
  }

  private async post(
    verb: Verb,
    call: CoinsCall,
    idempotencyKey: string,
    extra: Record<string, unknown> = {},
  ): Promise<CoinsReply> {
    const { baseUrl, serviceId, serviceToken, timeoutMs = 5000, fetchImpl = fetch } = this.options;
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/internal/v1/coins/${verb}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [HEADER_TENANT_ID]: call.tenantId,
        [HEADER_IDEMPOTENCY_KEY]: idempotencyKey,
        'x-service-id': serviceId,
        'x-service-token': serviceToken,
        'x-sandbox': call.sandbox ? '1' : '0',
      },
      body: JSON.stringify({ player_id: call.playerId, reserve_id: call.reserveId, ...extra }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as {
      amount?: unknown;
      code?: unknown;
    } | null;
    if (res.ok && typeof body?.amount === 'number') return { ok: true, amount: body.amount };
    if (
      (res.status === 409 || res.status === 404) &&
      typeof body?.code === 'string' &&
      REFUSALS.has(body.code)
    )
      return { ok: false, code: body.code as CoinsRefusalCode };
    throw new Error(`payments ${verb} answered ${res.status}`);
  }
}
