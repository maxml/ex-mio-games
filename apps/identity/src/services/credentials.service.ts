import { Injectable } from '@nestjs/common';
import {
  type CredentialIssued,
  type CredentialSummary,
  type IntegrationEnvironment,
  type PutRewardApiRequest,
  type RewardApiSummary,
  type TenantIntegration,
} from '@ex-mio/contracts';
import { emitProductEventAs, type ProductAuth } from '@ex-mio/logger';
import { IdentityError } from '../errors';
import type { Clock, CredentialRow, Repos, RewardApiRow, UnitOfWork } from '../model/ports';
import { AccessService, effectiveTenant, type Subject } from './access.service';
import { AuditService } from './audit.service';
import {
  compactUuid,
  decryptSecret,
  encryptSecret,
  expandUuid,
  hmacHex,
  randomToken,
  sha256Hex,
} from './crypto';

const KEY_PREFIX = 'key_';
const API_PREFIX = 'mio_live_';

/** `<prefix><tenant as 32 hex>_<random>`: the tenant is a routing hint; the row must exist under it. */
function tenantOfToken(token: string, prefix: string): string | undefined {
  if (typeof token !== 'string' || !token.startsWith(prefix)) return undefined;
  const rest = token.slice(prefix.length);
  const sep = rest.indexOf('_');
  if (sep !== 32) return undefined;
  return expandUuid(rest.slice(0, 32));
}

/**
 * Per-tenant, per-platform integration credentials: an api key (hashed at rest), an HMAC secret
 * (sealed with CREDENTIALS_KEK), a key id and an environment (production or sandbox). Launches
 * use the key status (revoked, or retiring past its grace, is refused); the same secrets are served
 * to engagement for the casino-native webhook check (D-15 Q-1).
 */
@Injectable()
export class CredentialsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repos: Repos,
    private readonly clock: Clock,
    private readonly access: AccessService,
    private readonly kek: string,
    private readonly audit: AuditService,
  ) {}

  /**
   * D-27: the operator registers where MIO calls the casino to issue a reward, and the secret that
   * signs those calls, for one environment. `credentials.rotate` (operator_admin only) decides who
   * may; the tenant is the subject's own (or the acting tenant), never an input. The row and its
   * audit row are one transaction. The secret is sealed and never returned.
   */
  async putRewardApi(
    subject: Subject,
    casino: string,
    input: PutRewardApiRequest,
  ): Promise<RewardApiSummary> {
    const tenantId = effectiveTenant(subject);
    await this.access.authorize(subject, 'credentials.rotate', { tenant_id: tenantId });
    // D-30 (F1): a production reward API is https. Plain http is for hosts listed in
    // REWARD_API_ALLOW_HOSTS (compose: casino-sim) and for the sandbox endpoint.
    if (input.environment === 'production') {
      const url = new URL(input.base_url);
      const allowed = (process.env.REWARD_API_ALLOW_HOSTS ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h !== '');
      if (url.protocol !== 'https:' && !allowed.includes(url.hostname.toLowerCase())) {
        throw new IdentityError(
          'VALIDATION_FAILED',
          'a production reward API must use https (http only for hosts in REWARD_API_ALLOW_HOSTS)',
        );
      }
    }
    const row: RewardApiRow = {
      tenant_id: tenantId,
      platform: casino,
      environment: input.environment,
      base_url: input.base_url,
      api_key_enc: input.api_key === undefined ? null : encryptSecret(input.api_key, this.kek),
      issue_deadline_ms:
        input.environment === 'production' ? (input.issue_deadline_ms ?? null) : null,
    };
    await this.uow.run(tenantId, async (tx) => {
      if (input.environment === 'sandbox') {
        // The sandbox endpoint is served beside a production one, never instead of it.
        const existing = await this.repos.rewardApis.list(tx, tenantId);
        const hasProduction = existing.some(
          (r) => r.platform === casino && r.environment === 'production',
        );
        if (!hasProduction)
          throw new IdentityError('VALIDATION_FAILED', 'register the production reward API first');
      }
      await this.repos.rewardApis.upsert(tx, row);
      await this.audit.recordChangeIn(tx, {
        tenantId,
        actorUserId: subject.userId,
        actorTenantId: subject.tenantId,
        actingTenantId: subject.acting?.tenantId ?? null,
        action: 'credentials.rotate',
        reason: `reward-api ${casino} ${input.environment} set`,
      });
    });
    return {
      platform: casino,
      environment: row.environment,
      base_url: row.base_url,
      has_api_key: row.api_key_enc !== null,
      issue_deadline_ms: row.issue_deadline_ms,
    };
  }

  private async create(
    tenantId: string,
    platform: string,
    environment: IntegrationEnvironment,
  ): Promise<{ row: CredentialRow; issued: CredentialIssued }> {
    const hex = compactUuid(tenantId);
    const issued: CredentialIssued = {
      key_id: `${KEY_PREFIX}${hex}_${randomToken(9)}`,
      api_key: `${API_PREFIX}${hex}_${randomToken(24)}`,
      hmac_secret: randomToken(32),
    };
    const row: CredentialRow = {
      tenant_id: tenantId,
      key_id: issued.key_id,
      platform,
      environment,
      api_key_hash: sha256Hex(issued.api_key),
      secret_enc: encryptSecret(issued.hmac_secret, this.kek),
      status: 'active',
      retiring_until: null,
      created_at: this.clock.now(),
    };
    return { row, issued };
  }

  /** Issue a key for a tenant and platform. The key and secret are shown here, once. */
  async issue(
    tenantId: string,
    platform: string,
    options: { environment: IntegrationEnvironment; subject?: Subject },
  ): Promise<CredentialIssued> {
    const { row, issued } = await this.create(tenantId, platform, options.environment);
    await this.uow.run(tenantId, (tx) => this.repos.credentials.insert(tx, row));
    this.announceIssued(tenantId, row.environment, false, options.subject);
    return issued;
  }

  /** Issue on behalf of an operator admin (or an acting platform admin). */
  async issueFor(
    subject: Subject,
    platform: string,
    environment: IntegrationEnvironment,
  ): Promise<CredentialIssued> {
    const tenantId = effectiveTenant(subject);
    await this.access.authorize(subject, 'credentials.rotate', { tenant_id: tenantId });
    return this.issue(tenantId, platform, { environment, subject });
  }

  async list(subject: Subject): Promise<CredentialSummary[]> {
    const tenantId = effectiveTenant(subject);
    await this.access.authorize(subject, 'credentials.read', { tenant_id: tenantId });
    const rows = await this.uow.run(tenantId, (tx) => this.repos.credentials.list(tx, tenantId));
    const now = this.clock.now();
    return rows.map((r) => ({
      key_id: r.key_id,
      platform: r.platform,
      environment: r.environment,
      status: this.statusOf(r, now),
      created_at: new Date(r.created_at * 1000).toISOString(),
    }));
  }

  private statusOf(r: CredentialRow, now: number): CredentialRow['status'] {
    if (r.status === 'retiring' && (r.retiring_until ?? 0) <= now) return 'revoked';
    return r.status;
  }

  /** Rows as stored, for the at-rest test. */
  async storedRowsForTest(tenantId: string): Promise<CredentialRow[]> {
    return this.uow.run(tenantId, (tx) => this.repos.credentials.list(tx, tenantId));
  }

  /** A new key; the old one stops now (grace 0) or after `graceSeconds`, in the same transaction. */
  async rotate(
    subject: Subject,
    keyId: string,
    options: { graceSeconds: number },
  ): Promise<CredentialIssued> {
    const tenantId = effectiveTenant(subject);
    await this.access.authorize(subject, 'credentials.rotate', { tenant_id: tenantId });
    const grace = Math.max(0, Math.floor(options.graceSeconds ?? 0));
    const now = this.clock.now();
    const { issued, environment } = await this.uow.run(tenantId, async (tx) => {
      const old = await this.repos.credentials.findByKeyId(tx, tenantId, keyId);
      if (!old) throw new IdentityError('NOT_FOUND', 'key not found');
      const made = await this.create(tenantId, old.platform, old.environment);
      await this.repos.credentials.insert(tx, made.row);
      await this.repos.credentials.update(tx, tenantId, keyId, {
        status: grace > 0 ? 'retiring' : 'revoked',
        retiring_until: grace > 0 ? now + grace : null,
      });
      return { issued: made.issued, environment: made.row.environment };
    });
    this.announceIssued(tenantId, environment, true, subject);
    return issued;
  }

  /** After the commit: a key was issued (or rotated). The key id and secret never go in the event. */
  private announceIssued(
    tenantId: string,
    environment: IntegrationEnvironment,
    rotated: boolean,
    subject?: Subject,
  ): void {
    // The actor is the verified subject of the request (the same data as the AuthContext); a key
    // issued by the service itself (no subject) is attributed to the identity service.
    const auth: ProductAuth = subject
      ? {
          mode: 'user',
          tenantId: subject.tenantId,
          principalId: subject.userId,
          roles: subject.roles,
          acting: subject.acting,
          sandbox: environment === 'sandbox', // the environment of the key, not of the operator
        }
      : {
          mode: 'service',
          tenantId,
          principalId: 'identity',
          roles: [],
          service: 'identity',
          sandbox: environment === 'sandbox',
        };
    emitProductEventAs(auth, {
      event: 'identity.credential_issued',
      tenant_id: tenantId,
      props: { environment, rotated },
    });
  }

  /** A live key by key id (launch tokens): revoked or grace-expired keys are not found. */
  async findLiveByKeyId(
    keyId: string,
  ): Promise<{ row: CredentialRow; secret: string } | undefined> {
    const tenantId = tenantOfToken(keyId, KEY_PREFIX);
    if (!tenantId) return undefined;
    const row = await this.uow.run(tenantId, (tx) =>
      this.repos.credentials.findByKeyId(tx, tenantId, keyId),
    );
    if (!row || this.statusOf(row, this.clock.now()) === 'revoked') return undefined;
    return { row, secret: decryptSecret(row.secret_enc, this.kek) };
  }

  /** The environment a key was issued for; `undefined` for an unknown key. */
  async environmentOfKey(keyId: string): Promise<IntegrationEnvironment | undefined> {
    const tenantId = tenantOfToken(keyId, KEY_PREFIX);
    if (!tenantId) return undefined;
    const row = await this.uow.run(tenantId, (tx) =>
      this.repos.credentials.findByKeyId(tx, tenantId, keyId),
    );
    return row?.environment;
  }

  /**
   * X-7: what engagement needs for a casino-native webhook check and the reward callback. The
   * platform and environment are those of the newest live PRODUCTION credential (or of the newest
   * live one when there is no production credential); `webhook_secrets` are the live credentials of
   * that platform and environment, newest first (the active key, then at most one retiring key
   * still inside its grace), and `sandbox.webhook_secrets` the live sandbox ones beside production
   * (F5). The tenant is the argument, never a caller input.
   */
  async integration(tenantId: string): Promise<TenantIntegration> {
    const tenant = await this.uow.run(null, (tx) => this.repos.tenants.findById(tx, tenantId));
    if (!tenant || tenant.type !== 'operator')
      throw new IdentityError('NOT_FOUND', 'no integration');
    const rows = await this.uow.run(tenantId, (tx) => this.repos.credentials.list(tx, tenantId));
    const now = this.clock.now();
    // active before retiring, newest first (list order is oldest first, so reverse it)
    const live = rows
      .filter((r) => this.statusOf(r, now) !== 'revoked')
      .reverse()
      .sort((a, b) => Number(a.status === 'retiring') - Number(b.status === 'retiring'));
    // F5: production is the primary set. A sandbox credential issued later never replaces it; it is
    // served beside it as `sandbox.webhook_secrets`. A tenant with sandbox credentials only is a
    // sandbox integration (environment `sandbox`, its secrets in `webhook_secrets`).
    const head = live.find((r) => r.environment === 'production') ?? live[0];
    if (!head) throw new IdentityError('NOT_FOUND', 'no integration');
    const secretsOf = (environment: IntegrationEnvironment): string[] =>
      live
        .filter((r) => r.platform === head.platform && r.environment === environment)
        .slice(0, 2)
        .map((r) => decryptSecret(r.secret_enc, this.kek));
    const sandboxSecrets = head.environment === 'production' ? secretsOf('sandbox') : [];
    const rewardApi = await this.rewardApiOf(tenantId, head.platform);
    return {
      tenant_id: tenantId,
      platform: head.platform,
      status: tenant.status,
      environment: head.environment,
      webhook_secrets: secretsOf(head.environment),
      ...(sandboxSecrets.length > 0 ? { sandbox: { webhook_secrets: sandboxSecrets } } : {}),
      ...(rewardApi ? { reward_api: rewardApi } : {}),
      // per-tenant, derived from the KEK so it is stable, secret and needs no extra column (D-12)
      player_hash_key: hmacHex(this.kek, `player-hash-key:${tenantId}`),
    };
  }

  /**
   * D-27: the reward API of the tenant's casino platform, as engagement's `CasinoRewardApiConfig`.
   * No production endpoint means no reward API at all (the sandbox one is never served alone), so
   * an order ends in NEEDS_REVIEW `no_adapter` instead of reaching a casino by guess. The tenant is
   * the argument; the secrets are opened here and served to engagement only.
   */
  private async rewardApiOf(
    tenantId: string,
    platform: string,
  ): Promise<TenantIntegration['reward_api']> {
    const rows = await this.uow.run(tenantId, (tx) => this.repos.rewardApis.list(tx, tenantId));
    const of = (environment: IntegrationEnvironment) =>
      rows.find(
        (r) => r.tenant_id === tenantId && r.platform === platform && r.environment === environment,
      );
    const prod = of('production');
    if (!prod) return undefined;
    const sandbox = of('sandbox');
    const open = (r: RewardApiRow | undefined): string | undefined =>
      r?.api_key_enc ? decryptSecret(r.api_key_enc, this.kek) : undefined;
    const apiKey = open(prod);
    const sandboxKey = open(sandbox);
    return {
      base_url: prod.base_url,
      ...(apiKey ? { api_key: apiKey } : {}),
      ...(sandbox ? { sandbox_base_url: sandbox.base_url } : {}),
      ...(sandboxKey ? { sandbox_api_key: sandboxKey } : {}),
      ...(prod.issue_deadline_ms ? { issue_deadline_ms: prod.issue_deadline_ms } : {}),
    };
  }

  /** The tenant-less internal lookup by slug: `undefined` when the slug or its integration is unknown. */
  async integrationBySlug(slug: string): Promise<TenantIntegration | undefined> {
    const tenant = await this.uow.run(null, (tx) =>
      this.repos.tenants.findBySlug(tx, String(slug ?? '').toLowerCase()),
    );
    if (!tenant || tenant.type !== 'operator') return undefined;
    try {
      return await this.integration(tenant.id);
    } catch (err) {
      if (err instanceof IdentityError && err.code === 'NOT_FOUND') return undefined;
      throw err;
    }
  }
}
