import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { Role } from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { UniqueViolationError } from '../errors';
import type {
  AuditRow,
  CredentialRow,
  PlayerLinkRow,
  Repos,
  RewardApiRow,
  SigningKeyRow,
  TenantRow,
  Tx,
  UnitOfWork,
  UserRow,
} from './ports';

const m = (tx: Tx): EntityManager => tx as EntityManager;

/** Postgres unique violation (23505) -> UniqueViolationError named by the constraint/index. */
async function guarded<T>(
  key: string | ((constraint: string) => string),
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as { code?: string; driverError?: { code?: string; constraint?: string } };
    const code = e.code ?? e.driverError?.code;
    if (code === '23505') {
      const constraint =
        e.driverError?.constraint ?? (err as { constraint?: string }).constraint ?? '';
      throw new UniqueViolationError(typeof key === 'function' ? key(constraint) : key);
    }
    throw err;
  }
}

const secs = (d: Date | string | null): number | null =>
  d === null ? null : Math.floor(new Date(d).getTime() / 1000);
const ts = (s: number | null): Date | null => (s === null ? null : new Date(s * 1000));

/** Postgres unit of work: tenant-scoped transactions set `app.tenant_id`; platform ones do not. */
@Injectable()
export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Db) {}

  run<T>(tenantId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return tenantId ? this.runTenant(tenantId, fn) : this.db.platformTx(fn);
  }

  private runTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    // Db.tenantTx reads the ambient context; identity picks the tenant per call, so it opens the
    // transaction with an explicit id through the same helper the foundation uses.
    return this.db.tenantTxFor(tenantId, fn);
  }

  publish(tx: Tx, event: Parameters<UnitOfWork['publish']>[1]): Promise<void> {
    return this.db.publish(m(tx), event);
  }
}

export function pgRepos(): Repos {
  return {
    tenants: {
      async insert(tx, row: TenantRow) {
        await guarded(
          (c) => (c.includes('one_platform') ? 'platform' : 'slug'),
          () =>
            m(tx).query(
              `INSERT INTO "tenants" ("id","type","name","slug","status","domains","provider_tenant_id")
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [
                row.id,
                row.type,
                row.name,
                row.slug,
                row.status,
                row.domains,
                row.provider_tenant_id,
              ],
            ),
        );
      },
      findById: (tx, id) => one(tx, `WHERE "id" = $1`, [id]),
      findBySlug: (tx, slug) => one(tx, `WHERE "slug" = $1`, [slug]),
      findByDomain: (tx, domain) => one(tx, `WHERE $1 = ANY("domains")`, [domain]),
      platform: (tx) => one(tx, `WHERE "type" = 'platform'`, []),
      async setStatus(tx, id, status) {
        const res = await m(tx).query(
          `UPDATE "tenants" SET "status" = $2 WHERE "id" = $1 RETURNING "id"`,
          [id, status],
        );
        return rowsOf(res).length > 0;
      },
      async setProviderTenant(tx, id, pid) {
        await m(tx).query(`UPDATE "tenants" SET "provider_tenant_id" = $2 WHERE "id" = $1`, [
          id,
          pid,
        ]);
      },
      async listOperatorSlugs(tx) {
        const rows = (await m(tx).query(
          `SELECT "slug" FROM "tenants" WHERE "type" = 'operator' ORDER BY "slug"`,
        )) as Array<{ slug: string }>;
        return rows.map((r) => r.slug);
      },
    },
    users: {
      async insert(tx, row) {
        await guarded('email', () =>
          m(tx).query(
            `INSERT INTO "users" ("tenant_id","id","email","kind") VALUES ($1,$2,$3,$4)`,
            [row.tenant_id, row.id, row.email, row.kind],
          ),
        );
      },
      async insertRole(tx, tenantId, userId, role) {
        await m(tx).query(
          `INSERT INTO "user_roles" ("tenant_id","user_id","role") VALUES ($1,$2,$3)`,
          [tenantId, userId, role],
        );
      },
      async insertProviderLink(tx, row) {
        await guarded('provider_link', () =>
          m(tx).query(
            `INSERT INTO "provider_links" ("tenant_id","user_id","provider","provider_uid") VALUES ($1,$2,$3,$4)`,
            [row.tenant_id, row.user_id, row.provider, row.provider_uid],
          ),
        );
      },
      async providerUid(tx, tenantId, userId) {
        const rows = (await m(tx).query(
          `SELECT "provider_uid" FROM "provider_links" WHERE "tenant_id" = $1 AND "user_id" = $2`,
          [tenantId, userId],
        )) as Array<{ provider_uid: string }>;
        return rows[0]?.provider_uid ?? null;
      },
      async findByEmail(tx, tenantId, emailLower) {
        return userRow(tx, `WHERE u."tenant_id" = $1 AND lower(u."email") = $2`, [
          tenantId,
          emailLower,
        ]).then((r) => r[0] ?? null);
      },
      async findById(tx, tenantId, id) {
        return userRow(tx, `WHERE u."tenant_id" = $1 AND u."id" = $2`, [tenantId, id]).then(
          (r) => r[0] ?? null,
        );
      },
      async listStaff(tx, tenantId) {
        return userRow(
          tx,
          `WHERE u."tenant_id" = $1 AND u."kind" = 'staff' ORDER BY u."created_at", u."id"`,
          [tenantId],
        );
      },
    },
    players: {
      async find(tx, tenantId, platform, ext) {
        return link(tx, `"tenant_id" = $1 AND "platform" = $2 AND "external_player_id" = $3`, [
          tenantId,
          platform,
          ext,
        ]).then((r) => r[0] ?? null);
      },
      async findByUser(tx, tenantId, userId) {
        return link(tx, `"tenant_id" = $1 AND "user_id" = $2`, [tenantId, userId]).then(
          (r) => r[0] ?? null,
        );
      },
      async insert(tx, tenantId, row) {
        await guarded('player_link', () =>
          m(tx).query(
            `INSERT INTO "player_links" ("tenant_id","user_id","platform","external_player_id") VALUES ($1,$2,$3,$4)`,
            [tenantId, row.user_id, row.platform, row.external_player_id],
          ),
        );
      },
      async delete(tx, tenantId, userId) {
        const res = (await m(tx).query(
          `DELETE FROM "player_links" WHERE "tenant_id" = $1 AND "user_id" = $2 RETURNING "user_id"`,
          [tenantId, userId],
        )) as unknown;
        return rowsOf(res).length > 0;
      },
      list: (tx, tenantId) =>
        link(tx, `"tenant_id" = $1 ORDER BY "created_at", "user_id"`, [tenantId]),
    },
    jti: {
      async insert(tx, tenantId, jti, expiresAt, sandbox) {
        // expired nonces can never be replayed (the token itself is expired): drop them as we go
        await m(tx).query(
          `DELETE FROM "launch_jti" WHERE "tenant_id" = $1 AND "expires_at" < now() - interval '1 hour'`,
          [tenantId],
        );
        await guarded('jti', () =>
          m(tx).query(
            `INSERT INTO "launch_jti" ("tenant_id","jti","expires_at","sandbox") VALUES ($1,$2,$3,$4)`,
            [tenantId, jti, ts(expiresAt), sandbox],
          ),
        );
      },
    },
    credentials: {
      async insert(tx, row) {
        await m(tx).query(
          `INSERT INTO "integration_credentials"
             ("tenant_id","key_id","platform","environment","api_key_hash","secret_enc","status","retiring_until","created_at")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            row.tenant_id,
            row.key_id,
            row.platform,
            row.environment,
            row.api_key_hash,
            row.secret_enc,
            row.status,
            ts(row.retiring_until),
            ts(row.created_at),
          ],
        );
      },
      findByKeyId: (tx, tenantId, keyId) =>
        cred(tx, `"tenant_id" = $1 AND "key_id" = $2`, [tenantId, keyId]).then((r) => r[0] ?? null),
      findByApiKeyHash: (tx, tenantId, hash) =>
        cred(tx, `"tenant_id" = $1 AND "api_key_hash" = $2`, [tenantId, hash]).then(
          (r) => r[0] ?? null,
        ),
      list: (tx, tenantId) =>
        cred(tx, `"tenant_id" = $1 ORDER BY "created_at", "key_id"`, [tenantId]),
      async update(tx, tenantId, keyId, patch) {
        await m(tx).query(
          `UPDATE "integration_credentials" SET "status" = $3, "retiring_until" = $4 WHERE "tenant_id" = $1 AND "key_id" = $2`,
          [tenantId, keyId, patch.status, ts(patch.retiring_until)],
        );
      },
    },
    rewardApis: {
      async upsert(tx, row) {
        await m(tx).query(
          `INSERT INTO "reward_apis"
             ("tenant_id","platform","environment","base_url","api_key_enc","issue_deadline_ms","updated_at")
           VALUES ($1,$2,$3,$4,$5,$6, now())
           ON CONFLICT ("tenant_id","platform","environment") DO UPDATE
             SET "base_url" = EXCLUDED."base_url", "api_key_enc" = EXCLUDED."api_key_enc",
                 "issue_deadline_ms" = EXCLUDED."issue_deadline_ms", "updated_at" = now()`,
          [
            row.tenant_id,
            row.platform,
            row.environment,
            row.base_url,
            row.api_key_enc,
            row.issue_deadline_ms,
          ],
        );
      },
      async list(tx, tenantId) {
        const rows = (await m(tx).query(
          `SELECT * FROM "reward_apis" WHERE "tenant_id" = $1 ORDER BY "platform", "environment"`,
          [tenantId],
        )) as Array<Record<string, unknown>>;
        return rows.map((r) => ({
          tenant_id: String(r.tenant_id),
          platform: String(r.platform),
          environment: r.environment as RewardApiRow['environment'],
          base_url: String(r.base_url),
          api_key_enc: r.api_key_enc === null ? null : String(r.api_key_enc),
          issue_deadline_ms: r.issue_deadline_ms === null ? null : Number(r.issue_deadline_ms),
        }));
      },
    },
    audit: {
      async insert(tx, row: AuditRow) {
        const res = (await m(tx).query(
          `INSERT INTO "audit_log"
             ("tenant_id","id","occurred_at","actor_user_id","actor_tenant_id","acting_tenant_id","action","reason","service","route","decision","caller_service")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT ("tenant_id","id") DO NOTHING RETURNING "id"`,
          [
            row.tenant_id,
            row.id,
            row.occurred_at,
            row.actor_user_id,
            row.actor_tenant_id,
            row.acting_tenant_id,
            row.action,
            row.reason,
            row.service,
            row.route,
            row.decision,
            row.caller_service,
          ],
        )) as unknown;
        return rowsOf(res).length > 0;
      },
      async list(tx, tenantId) {
        const rows = (await m(tx).query(
          `SELECT * FROM "audit_log" WHERE "tenant_id" = $1 ORDER BY "occurred_at", "id"`,
          [tenantId],
        )) as Array<Record<string, unknown>>;
        return rows.map((r) => ({
          tenant_id: String(r.tenant_id),
          id: String(r.id),
          occurred_at: new Date(r.occurred_at as string).toISOString(),
          actor_user_id: (r.actor_user_id as string | null) ?? null,
          actor_tenant_id: (r.actor_tenant_id as string | null) ?? null,
          acting_tenant_id: (r.acting_tenant_id as string | null) ?? null,
          action: String(r.action),
          reason: String(r.reason ?? ''),
          service: (r.service as string | null) ?? null,
          route: (r.route as string | null) ?? null,
          decision: (r.decision as string | null) ?? null,
          caller_service: (r.caller_service as string | null) ?? null,
        }));
      },
    },
    keys: {
      async list(tx) {
        const rows = (await m(tx).query(
          `SELECT * FROM "signing_keys" ORDER BY "created_at", "kid"`,
        )) as Array<Record<string, unknown>>;
        return rows.map(
          (r): SigningKeyRow => ({
            kid: String(r.kid),
            public_jwk: r.public_jwk as Record<string, string>,
            private_enc: String(r.private_enc),
            created_at: secs(r.created_at as Date) ?? 0,
            retired: Boolean(r.retired),
          }),
        );
      },
      async insert(tx, row) {
        await m(tx).query(
          `INSERT INTO "signing_keys" ("kid","public_jwk","private_enc","created_at","retired") VALUES ($1,$2,$3,$4,false)`,
          [row.kid, JSON.stringify(row.public_jwk), row.private_enc, ts(row.created_at)],
        );
      },
      async retire(tx, kid) {
        await m(tx).query(`UPDATE "signing_keys" SET "retired" = true WHERE "kid" = $1`, [kid]);
      },
    },
  };
}

/** typeorm's `query` returns rows, or `[rows, count]` for UPDATE/DELETE ... RETURNING. */
function rowsOf(res: unknown): unknown[] {
  if (
    Array.isArray(res) &&
    res.length === 2 &&
    Array.isArray(res[0]) &&
    typeof res[1] === 'number'
  ) {
    return res[0];
  }
  return Array.isArray(res) ? res : [];
}

async function one(tx: Tx, where: string, params: unknown[]): Promise<TenantRow | null> {
  const rows = (await m(tx).query(
    `SELECT "id","type","name","slug","status","domains","provider_tenant_id" FROM "tenants" ${where} LIMIT 1`,
    params,
  )) as TenantRow[];
  return rows[0] ?? null;
}

async function userRow(tx: Tx, where: string, params: unknown[]): Promise<UserRow[]> {
  const rows = (await m(tx).query(
    `SELECT u."tenant_id", u."id", u."email", u."kind",
            COALESCE((SELECT array_agg(r."role" ORDER BY r."role") FROM "user_roles" r
                       WHERE r."tenant_id" = u."tenant_id" AND r."user_id" = u."id"), '{}') AS roles
       FROM "users" u ${where}`,
    params,
  )) as Array<UserRow & { roles: Role[] }>;
  return rows.map((r) => ({
    tenant_id: r.tenant_id,
    id: r.id,
    email: r.email,
    kind: r.kind,
    roles: r.roles,
  }));
}

async function link(tx: Tx, where: string, params: unknown[]): Promise<PlayerLinkRow[]> {
  const rows = (await m(tx).query(
    `SELECT "user_id","platform","external_player_id" FROM "player_links" WHERE ${where}`,
    params,
  )) as PlayerLinkRow[];
  return rows.map((r) => ({
    user_id: r.user_id,
    platform: r.platform,
    external_player_id: r.external_player_id,
  }));
}

async function cred(tx: Tx, where: string, params: unknown[]): Promise<CredentialRow[]> {
  const rows = (await m(tx).query(
    `SELECT * FROM "integration_credentials" WHERE ${where}`,
    params,
  )) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    tenant_id: String(r.tenant_id),
    key_id: String(r.key_id),
    platform: String(r.platform),
    environment: r.environment as CredentialRow['environment'],
    api_key_hash: String(r.api_key_hash),
    secret_enc: String(r.secret_enc),
    status: r.status as CredentialRow['status'],
    retiring_until: secs(r.retiring_until as Date | null),
    created_at: secs(r.created_at as Date) ?? 0,
  }));
}
