import { INTERNAL_ROUTES, RealtimeTicketRedeemResponse } from '@ex-mio/contracts';
import type { ServiceTokenSource } from '../integrations/identity-client';

/**
 * Identity's internal redeem route (D-23): `POST`, tenant-less (the tenant is the ticket's own
 * `tid`), body `{ ticket }`, service token with `aud=identity`, allow-listed for engagement.
 * 200 answers the principal once; a second redeem of the same ticket is 401 REALTIME_TICKET_REPLAYED.
 * The route is the contract constant `INTERNAL_ROUTES.realtimeTicketRedeem`.
 */

export type Principal = RealtimeTicketRedeemResponse;

/** `null` means refused (unknown, expired, replayed, wrong audience). A throw means identity was unreachable. */
export interface TicketRedeemer {
  redeem(ticket: string): Promise<Principal | null>;
}

export class IdentityTicketRedeemer implements TicketRedeemer {
  constructor(
    private readonly identityUrl: string,
    private readonly tokens: ServiceTokenSource,
    private readonly options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {}

  async redeem(ticket: string): Promise<Principal | null> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const res = await fetchImpl(
      `${this.identityUrl.replace(/\/$/, '')}${INTERNAL_ROUTES.realtimeTicketRedeem}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.tokens.tokenFor('identity')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ticket }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 3000),
      },
    );
    // A refused ticket is an answer, not a failure: 400 (malformed), 401 (bad / replayed), 403 (suspended).
    if (res.status === 400 || res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error(`identity realtime-tickets/redeem answered ${res.status}`);
    return RealtimeTicketRedeemResponse.parse(await res.json());
  }
}
