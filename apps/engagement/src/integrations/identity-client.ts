import {
  INTERNAL_ROUTES,
  InternalResolvePlayerResponse,
  PlayerLinkResponse,
  TenantIntegration as TenantIntegrationSchema,
  type CasinoPlayerPort,
  type ServiceName,
} from '@ex-mio/contracts';
import type { PlayerDirectoryPort, TenantIntegration, TenantIntegrationPort } from './ports';

/**
 * The HTTP client of identity's internal routes (`INTERNAL_ROUTES`, tenant in the path, service token
 * with `aud=identity`, caller allow-list `svc:engagement`). Engagement's side of three contracts:
 *  - X-1: `resolveOrCreate` turns the casino's player id into the internal player id (ingest, before
 *    the outbox write); identity is the only writer of the player mapping.
 *  - X-8: `externalPlayerId` is the reverse, read per order by the reward-request builder (D-20); a 404
 *    after an erasure is `undefined`, never a guess.
 *  - X-7: the tenant's casino integration (secrets, hash key, environment) by slug or by tenant id.
 * Every failure that is not a documented 404 THROWS: callers treat it as transport, never as "absent".
 */

export interface ServiceTokenOptions {
  identityUrl: string;
  /** The calling service (`engagement`) and its secret from `SERVICE_CLIENT_SECRET`. */
  clientId: ServiceName;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  nowMs?: () => number;
}

/** Mints and caches service tokens per target audience (`POST /v1/auth/service-token`). */
export class ServiceTokenSource {
  private readonly cache = new Map<string, { value: string; expiresAtMs: number }>();

  constructor(private readonly options: ServiceTokenOptions) {}

  async tokenFor(audience: ServiceName): Promise<string> {
    const {
      identityUrl,
      clientId,
      clientSecret,
      fetchImpl = fetch,
      timeoutMs = 3000,
    } = this.options;
    const now = (this.options.nowMs ?? Date.now)();
    const hit = this.cache.get(audience);
    if (hit && hit.expiresAtMs - 30_000 > now) return hit.value;
    const res = await fetchImpl(`${identityUrl.replace(/\/$/, '')}/v1/auth/service-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, audience }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`service token for ${audience}: identity answered ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number')
      throw new Error('service token: malformed answer');
    this.cache.set(audience, {
      value: body.access_token,
      expiresAtMs: now + body.expires_in * 1000,
    });
    return body.access_token;
  }
}

/** `/internal/v1/tenants/:tenantId/...` with the placeholders filled and the method dropped. */
export function internalUrl(
  base: string,
  template: string,
  params: Record<string, string>,
): string {
  const path = template.replace(/^[A-Z]+ /, '').replace(/:(\w+)/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`internal route ${template}: no value for :${name}`);
    return encodeURIComponent(value);
  });
  return `${base.replace(/\/$/, '')}${path}`;
}

export class IdentityHttpClient
  implements PlayerDirectoryPort, CasinoPlayerPort, TenantIntegrationPort
{
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly identityUrl: string,
    private readonly tokens: ServiceTokenSource,
    options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  private async call(method: 'GET' | 'POST', url: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.tokens.tokenFor('identity')}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  async resolveOrCreate(
    tenantId: string,
    platform: string,
    externalPlayerId: string,
  ): Promise<string> {
    const res = await this.call(
      'POST',
      internalUrl(this.identityUrl, INTERNAL_ROUTES.resolvePlayer, { tenantId }),
      { platform, external_player_id: externalPlayerId },
    );
    if (!res.ok) throw new Error(`identity players/resolve answered ${res.status}`);
    return InternalResolvePlayerResponse.parse(await res.json()).user_id;
  }

  async externalPlayerId(
    tenantId: string,
    userId: string,
  ): Promise<{ platform: string; external_player_id: string } | undefined> {
    const res = await this.call(
      'GET',
      internalUrl(this.identityUrl, INTERNAL_ROUTES.playerLink, { tenantId, userId }),
    );
    if (res.status === 404) return undefined; // the link was deleted by an erasure (X-8)
    if (!res.ok) throw new Error(`identity players/link answered ${res.status}`);
    return PlayerLinkResponse.parse(await res.json());
  }

  async lookup(tenantSlug: string): Promise<TenantIntegration | undefined> {
    return this.integration(
      internalUrl(this.identityUrl, INTERNAL_ROUTES.integrationBySlug, { slug: tenantSlug }),
    );
  }

  async lookupById(tenantId: string): Promise<TenantIntegration | undefined> {
    return this.integration(
      internalUrl(this.identityUrl, INTERNAL_ROUTES.integration, { tenantId }),
    );
  }

  private async integration(url: string): Promise<TenantIntegration | undefined> {
    const res = await this.call('GET', url);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`identity integration answered ${res.status}`);
    return TenantIntegrationSchema.parse(await res.json());
  }
}
