import { Injectable } from '@nestjs/common';
import {
  WEBHOOK_MAX_SKEW_SECONDS,
  type CredentialIssued,
  type CredentialSummary,
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
  safeEqual,
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

const webhookInvalid = () => new IdentityError('WEBHOOK_SIGNATURE_INVALID', 'invalid webhook signature');

/**
 * Per-tenant, per-platform integration credentials: an api key (hashed at rest), an HMAC secret
 * (sealed with CREDENTIALS_KEK) and a key id. One lookup serves webhooks and launches, and it
 * honours the key status in both: revoked, or retiring past its grace, is refused.
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

  private async create(tenantId: string, platform: string): Promise<{ row: CredentialRow; issued: CredentialIssued }> {
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
      api_key_hash: sha256Hex(issued.api_key),
      secret_enc: encryptSecret(issued.hmac_secret, this.kek),
      status: 'active',
      retiring_until: null,
      created_at: this.clock.now(),
    };
    return { row, issued };
  }

  /** Issue a key for a tenant and platform. The key and secret are shown here, once. */
  async issue(tenantId: string, platform: string): Promise<CredentialIssued> {
    const { row, issued } = await this.create(tenantId, platform);
    await this.uow.run(tenantId, (tx) => this.repos.credentials.insert(tx, row));
    return issued;
  }

  /** Issue on behalf of an operator admin (or an acting platform admin). */
  async issueFor(subject: Subject, platform: string): Promise<CredentialIssued> {
    const tenantId = effectiveTenant(subject);
    await this.access.authorize(subject, 'credentials.rotate', { tenant_id: tenantId });
    return this.issue(tenantId, platform);
  }

  async list(subject: Subject): Promise<CredentialSummary[]> {
    const tenantId = effectiveTenant(subject);
    await this.access.authorize(subject, 'credentials.read', { tenant_id: tenantId });
    const rows = await this.uow.run(tenantId, (tx) => this.repos.credentials.list(tx, tenantId));
    const now = this.clock.now();
    return rows.map((r) => ({
      key_id: r.key_id,
      platform: r.platform,
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
      const { row, issued } = await this.create(tenantId, old.platform);
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

  /** Webhook check: the tenant (and platform) is the one of the key that signed, nothing else. */
  async verifyWebhookDetailed(input: {
    apiKey: string;
    timestamp: number;
    signature: string;
    rawBody: string;
  }): Promise<{ tenant_id: string; key_id: string; platform: string }> {
    const tenantId = tenantOfToken(input.apiKey, API_PREFIX);
    const row = tenantId
      ? await this.uow.run(tenantId, (tx) =>
          this.repos.credentials.findByApiKeyHash(tx, tenantId, sha256Hex(input.apiKey)),
        )
      : null;
    // always compute a signature, so an unknown key costs the same as a wrong one
    const secret = row ? decryptSecret(row.secret_enc, this.kek) : 'unknown-key-placeholder';
    const expected = hmacHex(secret, `${input.timestamp}.${input.rawBody}`);
    const sigOk = safeEqual(expected, String(input.signature ?? ''));
    const skewOk = Math.abs(this.clock.now() - input.timestamp) <= WEBHOOK_MAX_SKEW_SECONDS;
    const live = row ? this.statusOf(row, this.clock.now()) !== 'revoked' : false;
    if (!row || !sigOk || !skewOk || !live) throw webhookInvalid();
    return { tenant_id: row.tenant_id, key_id: row.key_id, platform: row.platform };
  }

  async verifyWebhook(input: {
    apiKey: string;
    timestamp: number;
    signature: string;
    rawBody: string;
  }): Promise<{ tenant_id: string; key_id: string }> {
    const { tenant_id, key_id } = await this.verifyWebhookDetailed(input);
    return { tenant_id, key_id };
  }
}
