import { Injectable } from '@nestjs/common';
import {
  createEvent,
  PLATFORM_TENANT_ID,
  uuidv7,
  type TenantStatus,
  type TenantStatusResponse,
  type TenantType,
  type TenantView,
} from '@ex-mio/contracts';
import { AuthorizationRefused } from '@ex-mio/service-kit';
import { IdentityError, ProviderError, UniqueViolationError } from '../errors';
import type { Repos, TenantRow, Tx, UnitOfWork } from '../model/ports';
import type { IdentityProvider } from './identity-provider';

export const toTenantView = (t: TenantRow): TenantView => ({
  id: t.id,
  type: t.type,
  name: t.name,
  slug: t.slug,
  status: t.status,
});

@Injectable()
export class TenantsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repos: Repos,
    private readonly provider: IdentityProvider,
    private readonly baseDomain: string,
  ) {}

  /** The seeded platform tenant (fixed id, created by the migration). */
  async platformTenant(): Promise<TenantView> {
    const row = await this.uow.run(null, (tx) => this.repos.tenants.platform(tx));
    if (!row) throw new IdentityError('NOT_FOUND', 'platform tenant is not seeded');
    return toTenantView(row);
  }

  /** One provider tenant per MIO tenant (D-7); created on first need for the platform tenant. */
  async providerTenantFor(tenantId: string): Promise<string> {
    const row = await this.uow.run(null, (tx) => this.repos.tenants.findById(tx, tenantId));
    if (!row) throw new IdentityError('NOT_FOUND', 'tenant not found');
    if (row.provider_tenant_id) return row.provider_tenant_id;
    const made = await this.createProviderTenant(row.slug);
    await this.uow.run(null, (tx) => this.repos.tenants.setProviderTenant(tx, tenantId, made));
    return made;
  }

  async createProviderTenant(name: string): Promise<string> {
    try {
      return (await this.provider.createTenant(`t-${name}`)).providerTenantId;
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new IdentityError('PROVIDER_UNAVAILABLE', 'identity provider unavailable');
      }
      throw err;
    }
  }

  /** Create a tenant and announce it: the row and the outbox event commit in one transaction. */
  async create(input: {
    type: TenantType;
    name: string;
    slug: string;
  }): Promise<{ tenant: TenantView }> {
    if (input.type === 'platform') throw new IdentityError('TENANT_PLATFORM_EXISTS');
    const providerTenantId = await this.createProviderTenant(input.slug);
    const id = uuidv7();
    try {
      const row = await this.uow.run(id, (tx) =>
        this.createInTx(tx, { id, ...input, providerTenantId }),
      );
      return { tenant: toTenantView(row) };
    } catch (err) {
      throw mapTenantViolation(err);
    }
  }

  /** The tenant row plus its `identity.tenant.created` event, inside the caller's transaction. */
  async createInTx(
    tx: Tx,
    input: { id: string; type: TenantType; name: string; slug: string; providerTenantId: string },
  ): Promise<TenantRow> {
    if (input.type === 'platform') throw new IdentityError('TENANT_PLATFORM_EXISTS');
    const row: TenantRow = {
      id: input.id,
      type: 'operator',
      name: input.name,
      slug: input.slug,
      status: 'active',
      domains: [],
      provider_tenant_id: input.providerTenantId,
    };
    await this.repos.tenants.insert(tx, row);
    await this.uow.publish(
      tx,
      createEvent({
        type: 'identity.tenant.created',
        tenantId: row.id,
        payload: { name: row.name, slug: row.slug },
      }),
    );
    return row;
  }

  async slugTaken(slug: string): Promise<boolean> {
    return (await this.uow.run(null, (tx) => this.repos.tenants.findBySlug(tx, slug))) !== null;
  }

  async get(id: string): Promise<TenantView> {
    const row = await this.uow.run(null, (tx) => this.repos.tenants.findById(tx, id));
    if (!row) throw new IdentityError('NOT_FOUND', 'tenant not found');
    return toTenantView(row);
  }

  async status(id: string): Promise<TenantStatusResponse> {
    const t = await this.get(id);
    return { tenant_id: t.id, status: t.status };
  }

  async setStatus(id: string, status: TenantStatus): Promise<TenantView> {
    if (id === PLATFORM_TENANT_ID && status !== 'active') {
      throw new AuthorizationRefused({
        code: 'FORBIDDEN',
        message: 'the platform tenant cannot be suspended',
      });
    }
    const found = await this.uow.run(null, async (tx) => {
      const ok = await this.repos.tenants.setStatus(tx, id, status);
      return ok ? this.repos.tenants.findById(tx, id) : null;
    });
    if (!found) throw new IdentityError('NOT_FOUND', 'tenant not found');
    return toTenantView(found);
  }

  /**
   * The tenant of a login: from the Host only (`<slug>.<BASE_DOMAIN>` or a registered domain).
   * An unknown host is TENANT_UNRESOLVED; there is no default tenant.
   */
  async resolveByHost(rawHost: string): Promise<TenantView> {
    const host = rawHost.trim().toLowerCase().replace(/:\d+$/, '');
    const unresolved = new IdentityError('TENANT_UNRESOLVED', 'unknown host');
    if (!host) throw unresolved;
    const suffix = `.${this.baseDomain.toLowerCase()}`;
    const row = await this.uow.run(null, async (tx) => {
      if (host.endsWith(suffix)) {
        const label = host.slice(0, -suffix.length);
        if (label && !label.includes('.')) {
          const bySlug = await this.repos.tenants.findBySlug(tx, label);
          if (bySlug) return bySlug;
        }
      }
      return this.repos.tenants.findByDomain(tx, host);
    });
    if (!row) throw unresolved;
    return toTenantView(row);
  }

  async listOperatorSlugs(): Promise<string[]> {
    return this.uow.run(null, (tx) => this.repos.tenants.listOperatorSlugs(tx));
  }
}

export function mapTenantViolation(err: unknown): unknown {
  if (err instanceof UniqueViolationError) {
    if (err.key === 'platform') return new IdentityError('TENANT_PLATFORM_EXISTS');
    if (err.key === 'slug') return new IdentityError('SLUG_TAKEN', 'slug already taken');
  }
  return err;
}
