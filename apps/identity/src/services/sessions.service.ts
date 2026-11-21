import {
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
  createPrivateKey,
} from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  ACCESS_TTL_MAX_SECONDS,
  ACTING_TTL_MAX_SECONDS,
  PLATFORM_TENANT_ID,
  SERVICE_CALL_POLICY,
  SERVICE_TOKEN_SCOPE,
  SERVICE_TOKEN_TTL_MAX_SECONDS,
  TOKEN_ISSUER,
  type Audience,
  type JwksResponse,
  type LoginRequest,
  type ServiceName,
  type ServiceTokenRequest,
  type StartActingRequest,
  type TokenResponse,
  type Role,
} from '@ex-mio/contracts';
import { IdentityError, ProviderError } from '../errors';
import type { Clock, Repos, SigningKeyRow, UnitOfWork } from '../model/ports';
import type { Subject } from './access.service';
import { AuditService } from './audit.service';
import { decryptSecret, encryptSecret, randomToken, safeEqual } from './crypto';
import type { IdentityProvider } from './identity-provider';
import { TenantsService } from './tenants.service';

export type KeyGenerator = () => { privatePem: string; publicJwk: Record<string, string> };

export const generateSigningKey: KeyGenerator = () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicJwk: publicKey.export({ format: 'jwk' }) as Record<string, string>,
  };
};

const b64 = (v: Buffer | string): string => Buffer.from(v).toString('base64url');

interface LoadedKey {
  kid: string;
  key: KeyObject;
  publicJwk: Record<string, string>;
  createdAt: number;
}

/**
 * Our own RS256 tokens (spec 1.4): login, acting sessions, launch sessions and service tokens, and
 * the key set behind the JWKS. Private keys live in `signing_keys`, sealed with CREDENTIALS_KEK;
 * the JWKS carries public members only. Rotation adds a key that signs; the old one stays in the
 * JWKS until retired.
 */
@Injectable()
export class SessionsService {
  private keys: LoadedKey[] = [];

  constructor(
    private readonly uow: UnitOfWork,
    private readonly repos: Repos,
    private readonly clock: Clock,
    private readonly provider: IdentityProvider,
    private readonly tenants: TenantsService,
    private readonly audit: AuditService,
    private readonly options: {
      kek: string;
      serviceSecrets: Partial<Record<ServiceName, string>>;
      keyGenerator?: KeyGenerator;
    },
  ) {}

  // ---- keys ----------------------------------------------------------------------------------

  /** Load the key set; create the first key when there is none. Call at boot. */
  async init(): Promise<void> {
    await this.reload();
    if (this.keys.length === 0) await this.rotateKey();
  }

  async reload(): Promise<void> {
    const rows = await this.uow.run(null, (tx) => this.repos.keys.list(tx));
    this.keys = rows
      .filter((r) => !r.retired)
      .sort((a, b) => a.created_at - b.created_at)
      .map((r) => ({
        kid: r.kid,
        key: createPrivateKey(decryptSecret(r.private_enc, this.options.kek)),
        publicJwk: r.public_jwk,
        createdAt: r.created_at,
      }));
  }

  async rotateKey(): Promise<{ kid: string }> {
    const gen = (this.options.keyGenerator ?? generateSigningKey)();
    const kid = `k-${randomToken(9)}`;
    const row: SigningKeyRow = {
      kid,
      public_jwk: { ...gen.publicJwk, kid, alg: 'RS256', use: 'sig' },
      private_enc: encryptSecret(gen.privatePem, this.options.kek),
      created_at: this.clock.now(),
      retired: false,
    };
    await this.uow.run(null, (tx) => this.repos.keys.insert(tx, row));
    await this.reload();
    return { kid };
  }

  async retireKey(kid: string): Promise<void> {
    await this.uow.run(null, (tx) => this.repos.keys.retire(tx, kid));
    await this.reload();
  }

  /** Public members only. Synchronous: it reads the loaded key set. */
  jwks(): JwksResponse {
    return { keys: this.keys.map((k) => k.publicJwk) } as JwksResponse;
  }

  /** Sign arbitrary claims with the newest key (RS256, `kid` header). */
  sign(claims: Record<string, unknown>): string {
    const current = this.keys[this.keys.length - 1];
    if (!current) throw new Error('no signing key loaded');
    const input = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: current.kid }))}.${b64(JSON.stringify(claims))}`;
    const sig = createSign('RSA-SHA256').update(input).sign(current.key);
    return `${input}.${b64(sig)}`;
  }

  // ---- user tokens ---------------------------------------------------------------------------

  issueUserToken(input: {
    sub: string;
    tid: string;
    roles: Role[];
    aud: Audience;
    act?: { tenant_id: string; reason: string };
    ttl?: number;
  }): TokenResponse {
    const now = this.clock.now();
    const ttl = Math.min(input.ttl ?? ACCESS_TTL_MAX_SECONDS, ACCESS_TTL_MAX_SECONDS);
    const token = this.sign({
      iss: TOKEN_ISSUER,
      sub: input.sub,
      tid: input.tid,
      roles: input.roles,
      aud: input.aud,
      iat: now,
      exp: now + ttl,
      jti: randomUUID(),
      ...(input.act ? { act: input.act } : {}),
    });
    return { access_token: token, token_type: 'Bearer', expires_in: ttl };
  }

  /** Sign in to the tenant resolved from the Host. Roles come from our database only. */
  async login(tenantId: string, input: LoginRequest): Promise<TokenResponse> {
    const tenant = await this.tenants.get(tenantId).catch(() => {
      throw new IdentityError('INVALID_CREDENTIALS', 'invalid credentials');
    });
    if (tenant.status !== 'active') throw new IdentityError('TENANT_SUSPENDED', 'tenant is suspended');
    const invalid = new IdentityError('INVALID_CREDENTIALS', 'invalid credentials');
    const email = input.email.trim().toLowerCase();
    const user = await this.uow.run(tenantId, (tx) =>
      this.repos.users.findByEmail(tx, tenantId, email),
    );
    const providerTenant = await this.tenants.providerTenantFor(tenantId);
    let verified: { uid: string } | null;
    try {
      verified = await this.provider.verifyCredentials(providerTenant, {
        email,
        password: input.password,
      });
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new IdentityError('PROVIDER_UNAVAILABLE', 'identity provider unavailable');
      }
      throw err;
    }
    if (!user || !verified || user.kind !== 'staff' || user.roles.length === 0) throw invalid;
    return this.issueUserToken({
      sub: user.id,
      tid: tenantId,
      roles: user.roles,
      aud: input.audience,
    });
  }

  /** Acting session (spec 1.7): platform_admin only, never from an acting session, always audited. */
  async startActing(subject: Subject, input: Omit<StartActingRequest, 'audience'> & { audience?: Audience }): Promise<TokenResponse> {
    const isAdmin =
      subject.roles.includes('platform_admin') && subject.tenantId === PLATFORM_TENANT_ID;
    if (!isAdmin || subject.acting) {
      throw new IdentityError('ACTING_FORBIDDEN', 'acting sessions are for the platform admin');
    }
    if (input.tenant_id === PLATFORM_TENANT_ID) {
      throw new IdentityError('ACTING_FORBIDDEN', 'acting on the platform tenant is meaningless');
    }
    const target = await this.tenants.get(input.tenant_id); // NOT_FOUND when unknown
    // D-15 Q-4: 8 to 500 characters (the existence of the tenant is answered first)
    const reason = (input.reason ?? '').trim();
    if (reason.length < 8 || reason.length > 500) {
      throw new IdentityError('ACTING_REASON_REQUIRED', 'a reason of 8 to 500 characters is required');
    }
    await this.audit.record({
      tenantId: target.id,
      actorUserId: subject.userId,
      actorTenantId: PLATFORM_TENANT_ID,
      actingTenantId: target.id,
      action: 'acting.start',
      reason,
    });
    return this.issueUserToken({
      sub: subject.userId,
      tid: PLATFORM_TENANT_ID,
      roles: ['platform_admin'],
      aud: input.audience ?? 'identity',
      act: { tenant_id: target.id, reason },
      ttl: ACTING_TTL_MAX_SECONDS,
    });
  }

  // ---- service tokens (D-4, D-14) --------------------------------------------------------------

  /** Client credentials: a short-lived token with no tenant, only for an audience on the client's list. */
  issueServiceToken(input: ServiceTokenRequest): TokenResponse {
    const denied = new IdentityError('INVALID_SERVICE_CREDENTIALS', 'invalid service credentials');
    const secret = this.options.serviceSecrets[input.client_id];
    // compare even when the client is unknown, so the time does not tell them apart
    const ok = safeEqual(input.client_secret, secret ?? randomToken(16));
    if (!secret || !ok) throw denied;
    const audiences = Object.keys(SERVICE_CALL_POLICY[input.client_id] ?? {});
    if (!audiences.includes(input.audience)) throw denied;
    const now = this.clock.now();
    const token = this.sign({
      iss: TOKEN_ISSUER,
      sub: `svc:${input.client_id}`,
      aud: input.audience,
      scope: SERVICE_TOKEN_SCOPE,
      iat: now,
      exp: now + SERVICE_TOKEN_TTL_MAX_SECONDS,
      jti: randomUUID(),
    });
    return { access_token: token, token_type: 'Bearer', expires_in: SERVICE_TOKEN_TTL_MAX_SECONDS };
  }
}
