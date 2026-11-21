import { Injectable } from '@nestjs/common';
import {
  type CredentialIssued,
  type CredentialSummary,
  type IntegrationEnvironment,
  type TenantIntegration,
} from '@ex-mio/contracts';
import { IdentityError } from '../errors';
import type { Clock, CredentialRow, Repos, UnitOfWork } from '../model/ports';
import { AccessService, effectiveTenant, type Subject } from './access.service';
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
  ) {}

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
    options: { environment?: IntegrationEnvironment } = {},
  ): Promise<CredentialIssued> {
    const { row, issued } = await this.create(
      tenantId,
      platform,
      options.environment ?? 'production',
    );
    await this.uow.run(tenantId, (tx) => this.repos.credentials.insert(tx, row));
    return issued;
  }

  /** Issue on behalf of an operator admin (or an acting platform admin). */
  async issueFor(
    subject: Subject,
    platform: string,
    environment: IntegrationEnvironment = 'production',
  ): Promise<CredentialIssued> {
    const tenantId = effectiveTenant(subject);
    await this.access.authorize(subject, 'credentials.rotate', { tenant_id: tenantId });
    return this.issue(tenantId, platform, { environment });
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
    return this.uow.run(tenantId, async (tx) => {
      const old = await this.repos.credentials.findByKeyId(tx, tenantId, keyId);
      if (!old) throw new IdentityError('NOT_FOUND', 'key not found');
      const { row, issued } = await this.create(tenantId, old.platform, old.environment);
      await this.repos.credentials.insert(tx, row);
      await this.repos.credentials.update(tx, tenantId, keyId, {
        status: grace > 0 ? 'retiring' : 'revoked',
        retiring_until: grace > 0 ? now + grace : null,
      });
      return issued;
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
   * platform and environment are those of the newest live credential; the secrets are those of the
   * live credentials for that platform and environment, newest first (the active key, then at most
   * one retiring key still inside its grace). The tenant is the argument, never a caller input.
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
    const head = live[0];
    if (!head) throw new IdentityError('NOT_FOUND', 'no integration');
    const secrets = live
      .filter((r) => r.platform === head.platform && r.environment === head.environment)
      .slice(0, 2)
      .map((r) => decryptSecret(r.secret_enc, this.kek));
    return {
      tenant_id: tenantId,
      platform: head.platform,
      status: tenant.status,
      environment: head.environment,
      webhook_secrets: secrets,
      // per-tenant, derived from the KEK so it is stable, secret and needs no extra column (D-12)
      player_hash_key: hmacHex(this.kek, `player-hash-key:${tenantId}`),
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
