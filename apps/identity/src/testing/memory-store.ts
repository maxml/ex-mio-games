import { PLATFORM_TENANT_ID, type EventEnvelope, type Role } from '@ex-mio/contracts';
import { TenantMismatchError, tryTenantContext } from '@ex-mio/tenancy';
import { UniqueViolationError } from '../errors';
import type {
  AuditRow,
  CredentialRow,
  PlayerLinkRow,
  Repos,
  SigningKeyRow,
  TenantRow,
  Tx,
  UnitOfWork,
  UserRow,
} from '../model/ports';

/**
 * In-memory twin of the Postgres repositories, for the kernel. Two properties matter for the
 * tests that guard concurrency (F16):
 *  - every method yields before it reads, so a service that checks and then inserts without a
 *    unique key or a lock interleaves with a concurrent caller exactly as it would over a network;
 *  - unique keys are enforced inside the single synchronous mutation, like a unique index.
 * A transaction keeps an undo log: on failure its writes are reverted, like a rollback.
 */

const tick = (): Promise<void> => Promise.resolve();

interface MemTx {
  undo: Array<() => void>;
}
const asTx = (tx: Tx): MemTx => tx as MemTx;

export class MemoryStore {
  readonly tenants = new Map<string, TenantRow>();
  readonly users: Array<{
    tenant_id: string;
    id: string;
    email: string | null;
    kind: 'staff' | 'player';
  }> = [];
  readonly roles: Array<{ tenant_id: string; user_id: string; role: Role }> = [];
  readonly providerLinks: Array<{
    tenant_id: string;
    user_id: string;
    provider: string;
    provider_uid: string;
  }> = [];
  readonly playerLinks: Array<PlayerLinkRow & { tenant_id: string }> = [];
  readonly jti: Array<{ tenant_id: string; jti: string; expires_at: number }> = [];
  readonly credentials: CredentialRow[] = [];
  readonly audit: AuditRow[] = [];
  readonly keys: SigningKeyRow[] = [];
  readonly outbox: EventEnvelope[] = [];
  outboxFails = false;

  constructor() {
    this.tenants.set(PLATFORM_TENANT_ID, {
      id: PLATFORM_TENANT_ID,
      type: 'platform',
      name: 'Platform',
      slug: 'platform',
      status: 'active',
      domains: [],
      provider_tenant_id: null,
    });
  }

  uow(): UnitOfWork {
    return {
      run: async (tenantId, fn) => {
        // Same rule as withTenantTransaction: an explicit tenant that differs from the ambient one
        // would move the rest of the flow to another tenant, so it is refused.
        const ambient = tryTenantContext();
        if (tenantId && ambient && ambient.tenantId.toLowerCase() !== tenantId.toLowerCase()) {
          throw new TenantMismatchError();
        }
        const tx: MemTx = { undo: [] };
        try {
          return await fn(tx);
        } catch (err) {
          for (const undo of tx.undo.reverse()) undo();
          throw err;
        }
      },
      publish: async (tx, event) => {
        await tick();
        if (this.outboxFails) throw new Error('outbox unavailable');
        this.outbox.push(event);
        asTx(tx).undo.push(() => {
          const i = this.outbox.indexOf(event);
          if (i >= 0) this.outbox.splice(i, 1);
        });
      },
    };
  }

  private push<T>(tx: Tx, list: T[], row: T): void {
    list.push(row);
    asTx(tx).undo.push(() => {
      const i = list.indexOf(row);
      if (i >= 0) list.splice(i, 1);
    });
  }

  private userView(u: {
    tenant_id: string;
    id: string;
    email: string | null;
    kind: 'staff' | 'player';
  }): UserRow {
    return {
      ...u,
      roles: this.roles
        .filter((r) => r.tenant_id === u.tenant_id && r.user_id === u.id)
        .map((r) => r.role),
    };
  }

  repos(): Repos {
    // The repository methods below are object-literal members, so they need the store as `s`.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const s = this;
    return {
      tenants: {
        async insert(tx, row) {
          await tick();
          if (
            row.type === 'platform' &&
            [...s.tenants.values()].some((t) => t.type === 'platform')
          ) {
            throw new UniqueViolationError('platform');
          }
          if ([...s.tenants.values()].some((t) => t.slug === row.slug))
            throw new UniqueViolationError('slug');
          s.tenants.set(row.id, row);
          asTx(tx).undo.push(() => s.tenants.delete(row.id));
        },
        async findById(_tx, id) {
          await tick();
          return s.tenants.get(id) ?? null;
        },
        async findBySlug(_tx, slug) {
          await tick();
          return [...s.tenants.values()].find((t) => t.slug === slug) ?? null;
        },
        async findByDomain(_tx, domain) {
          await tick();
          return [...s.tenants.values()].find((t) => t.domains.includes(domain)) ?? null;
        },
        async platform() {
          await tick();
          return [...s.tenants.values()].find((t) => t.type === 'platform') ?? null;
        },
        async setStatus(_tx, id, status) {
          await tick();
          const t = s.tenants.get(id);
          if (!t) return false;
          t.status = status;
          return true;
        },
        async setProviderTenant(_tx, id, pid) {
          await tick();
          const t = s.tenants.get(id);
          if (t) t.provider_tenant_id = pid;
        },
        async listOperatorSlugs() {
          await tick();
          return [...s.tenants.values()]
            .filter((t) => t.type === 'operator')
            .map((t) => t.slug)
            .sort();
        },
      },
      users: {
        async insert(tx, row) {
          await tick();
          if (
            row.email &&
            s.users.some(
              (u) =>
                u.tenant_id === row.tenant_id &&
                u.email?.toLowerCase() === row.email?.toLowerCase(),
            )
          ) {
            throw new UniqueViolationError('email');
          }
          s.push(tx, s.users, { ...row });
        },
        async insertRole(tx, tenant_id, user_id, role) {
          await tick();
          s.push(tx, s.roles, { tenant_id, user_id, role });
        },
        async insertProviderLink(tx, row) {
          await tick();
          if (
            s.providerLinks.some((l) => l.tenant_id === row.tenant_id && l.user_id === row.user_id)
          ) {
            throw new UniqueViolationError('provider_link');
          }
          s.push(tx, s.providerLinks, { ...row });
        },
        async providerUid(_tx, tenantId, userId) {
          await tick();
          return (
            s.providerLinks.find((l) => l.tenant_id === tenantId && l.user_id === userId)
              ?.provider_uid ?? null
          );
        },
        async findByEmail(_tx, tenantId, emailLower) {
          await tick();
          const u = s.users.find(
            (x) => x.tenant_id === tenantId && x.email?.toLowerCase() === emailLower,
          );
          return u ? s.userView(u) : null;
        },
        async findById(_tx, tenantId, id) {
          await tick();
          const u = s.users.find((x) => x.tenant_id === tenantId && x.id === id);
          return u ? s.userView(u) : null;
        },
        async listStaff(_tx, tenantId) {
          await tick();
          return s.users
            .filter((u) => u.tenant_id === tenantId && u.kind === 'staff')
            .map((u) => s.userView(u));
        },
      },
      players: {
        async find(_tx, tenantId, platform, ext) {
          await tick();
          const l = s.playerLinks.find(
            (x) =>
              x.tenant_id === tenantId && x.platform === platform && x.external_player_id === ext,
          );
          return l ? strip(l) : null;
        },
        async findByUser(_tx, tenantId, userId) {
          await tick();
          const l = s.playerLinks.find((x) => x.tenant_id === tenantId && x.user_id === userId);
          return l ? strip(l) : null;
        },
        async insert(tx, tenantId, row) {
          await tick();
          if (
            s.playerLinks.some(
              (x) =>
                x.tenant_id === tenantId &&
                ((x.platform === row.platform && x.external_player_id === row.external_player_id) ||
                  x.user_id === row.user_id),
            )
          ) {
            throw new UniqueViolationError('player_link');
          }
          s.push(tx, s.playerLinks, { ...row, tenant_id: tenantId });
        },
        async delete(tx, tenantId, userId) {
          await tick();
          const i = s.playerLinks.findIndex(
            (x) => x.tenant_id === tenantId && x.user_id === userId,
          );
          if (i < 0) return false;
          const [row] = s.playerLinks.splice(i, 1);
          asTx(tx).undo.push(() => {
            if (row) s.playerLinks.splice(i, 0, row);
          });
          return true;
        },
        async list(_tx, tenantId) {
          await tick();
          return s.playerLinks.filter((x) => x.tenant_id === tenantId).map(strip);
        },
      },
      jti: {
        async insert(tx, tenantId, jti, expiresAt) {
          await tick();
          if (s.jti.some((j) => j.tenant_id === tenantId && j.jti === jti))
            throw new UniqueViolationError('jti');
          s.push(tx, s.jti, { tenant_id: tenantId, jti, expires_at: expiresAt });
        },
      },
      credentials: {
        async insert(tx, row) {
          await tick();
          s.push(tx, s.credentials, { ...row });
        },
        async findByKeyId(_tx, tenantId, keyId) {
          await tick();
          return s.credentials.find((c) => c.tenant_id === tenantId && c.key_id === keyId) ?? null;
        },
        async findByApiKeyHash(_tx, tenantId, hash) {
          await tick();
          return (
            s.credentials.find((c) => c.tenant_id === tenantId && c.api_key_hash === hash) ?? null
          );
        },
        async list(_tx, tenantId) {
          await tick();
          return s.credentials.filter((c) => c.tenant_id === tenantId).map((c) => ({ ...c }));
        },
        async update(tx, tenantId, keyId, patch) {
          await tick();
          const c = s.credentials.find((x) => x.tenant_id === tenantId && x.key_id === keyId);
          if (!c) return;
          const before = { status: c.status, retiring_until: c.retiring_until };
          Object.assign(c, patch);
          asTx(tx).undo.push(() => Object.assign(c, before));
        },
      },
      audit: {
        async insert(tx, row) {
          await tick();
          if (s.audit.some((a) => a.tenant_id === row.tenant_id && a.id === row.id)) return false;
          s.push(tx, s.audit, { ...row });
          return true;
        },
        async list(_tx, tenantId) {
          await tick();
          return s.audit.filter((a) => a.tenant_id === tenantId).map((a) => ({ ...a }));
        },
      },
      keys: {
        async list() {
          await tick();
          return s.keys.map((k) => ({ ...k }));
        },
        async insert(tx, row) {
          await tick();
          s.push(tx, s.keys, { ...row });
        },
        async retire(_tx, kid) {
          await tick();
          const k = s.keys.find((x) => x.kid === kid);
          if (k) k.retired = true;
        },
      },
    };
  }
}

const strip = (l: PlayerLinkRow & { tenant_id?: string }): PlayerLinkRow => ({
  user_id: l.user_id,
  platform: l.platform,
  external_player_id: l.external_player_id,
});
