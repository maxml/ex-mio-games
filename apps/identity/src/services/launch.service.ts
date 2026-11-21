import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  LAUNCH_TOKEN_ALGS,
  LAUNCH_TOKEN_AUDIENCE,
  LAUNCH_TOKEN_CLOCK_SKEW_SECONDS,
  LAUNCH_TOKEN_MAX_TTL_SECONDS,
  type Audience,
  type LaunchResponse,
} from '@ex-mio/contracts';
import { IdentityError, ProviderError, UniqueViolationError } from '../errors';
import type { Clock, Repos, UnitOfWork } from '../model/ports';
import { safeEqual } from './crypto';
import { CredentialsService } from './credentials.service';
import type { IdentityProvider } from './identity-provider';
import { PlayersService } from './players.service';
import { SessionsService } from './sessions.service';
import { TenantsService } from './tenants.service';

const LaunchClaims = z.object({
  pid: z.string().trim().min(1).max(128),
  plat: z.string().trim().min(1).max(64),
  aud: z.literal(LAUNCH_TOKEN_AUDIENCE),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(8).max(200),
});

const invalid = (why = 'launch token invalid') => new IdentityError('LAUNCH_TOKEN_INVALID', why);

/**
 * A casino-signed launch token becomes a player session only when every check passes, in this
 * order: header and key (tenant and platform come from the key), signature, claims, expiry and
 * lifetime, platform, tenant status, then the single-use `jti` (recorded only now), the player
 * link and the provider call. Anything that fails before the `jti` leaves no trace.
 */
@Injectable()
export class LaunchService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repos: Repos,
    private readonly clock: Clock,
    private readonly credentials: CredentialsService,
    private readonly players: PlayersService,
    private readonly sessions: SessionsService,
    private readonly tenants: TenantsService,
    private readonly provider: IdentityProvider,
  ) {}

  async exchange(input: { token: string; audience: Audience }): Promise<LaunchResponse> {
    const parts = String(input.token ?? '').split('.');
    if (parts.length !== 3 || parts.some((p) => !p)) throw invalid();
    const [h, p, s] = parts as [string, string, string];
    let header: Record<string, unknown>;
    let payload: unknown;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      throw invalid();
    }
    if (!header || typeof header !== 'object') throw invalid();
    if (!(LAUNCH_TOKEN_ALGS as readonly unknown[]).includes(header.alg)) throw invalid();
    if (typeof header.kid !== 'string' || !header.kid) throw invalid();

    const key = await this.credentials.findLiveByKeyId(header.kid);
    if (!key) throw invalid();
    const expected = createHmac('sha256', key.secret).update(`${h}.${p}`).digest('base64url');
    if (!safeEqual(expected, s)) throw invalid();

    const parsed = LaunchClaims.safeParse(payload);
    if (!parsed.success) throw invalid();
    const claims = parsed.data;
    const now = this.clock.now();
    if (now >= claims.exp) throw new IdentityError('LAUNCH_TOKEN_EXPIRED', 'launch token expired');
    if (claims.iat > now + LAUNCH_TOKEN_CLOCK_SKEW_SECONDS) throw invalid();
    if (claims.exp - claims.iat > LAUNCH_TOKEN_MAX_TTL_SECONDS) throw invalid();
    // the platform comes from the key too: the claim must agree with it (F7)
    if (claims.plat !== key.row.platform) throw invalid();

    const tenantId = key.row.tenant_id;
    const tenant = await this.tenants.get(tenantId).catch(() => {
      throw invalid();
    });
    if (tenant.status !== 'active') throw new IdentityError('TENANT_SUSPENDED', 'tenant is suspended');

    try {
      await this.uow.run(tenantId, (tx) =>
        this.repos.jti.insert(tx, tenantId, claims.jti, claims.exp),
      );
    } catch (err) {
      if (err instanceof UniqueViolationError) {
        throw new IdentityError('LAUNCH_TOKEN_REPLAYED', 'launch token already used');
      }
      throw err;
    }

    const { user_id } = await this.players.resolveOrCreate(tenantId, key.row.platform, claims.pid);
    const providerTenant = await this.tenants.providerTenantFor(tenantId);
    try {
      const existing = await this.uow.run(tenantId, (tx) =>
        this.repos.users.providerUid(tx, tenantId, user_id),
      );
      const { uid } = await this.provider.exchangeLaunchToken(providerTenant, {
        userId: user_id,
        platform: key.row.platform,
        externalPlayerId: claims.pid,
        ...(existing ? { existingUid: existing } : {}),
      });
      if (!existing) {
        await this.uow
          .run(tenantId, (tx) =>
            this.repos.users.insertProviderLink(tx, {
              tenant_id: tenantId,
              user_id,
              provider: 'firebase',
              provider_uid: uid,
            }),
          )
          .catch((e) => {
            if (!(e instanceof UniqueViolationError)) throw e;
          });
      }
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new IdentityError('PROVIDER_UNAVAILABLE', 'identity provider unavailable');
      }
      throw err;
    }

    const token = this.sessions.issueUserToken({
      sub: user_id,
      tid: tenantId,
      roles: ['player'],
      aud: input.audience,
    });
    return { ...token, user_id, tenant_id: tenantId };
  }
}
