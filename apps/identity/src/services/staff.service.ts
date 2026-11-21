import { Injectable } from '@nestjs/common';
import {
  PLATFORM_TENANT_ID,
  uuidv7,
  type InviteStaffRequest,
  type OperatorSignupRequest,
  type Role,
  type TenantView,
} from '@ex-mio/contracts';
import { IdentityError, ProviderError, UniqueViolationError } from '../errors';
import type { Repos, UnitOfWork } from '../model/ports';
import { AccessService, effectiveTenant, type Subject } from './access.service';
import type { IdentityProvider } from './identity-provider';
import { mapTenantViolation, TenantsService, toTenantView } from './tenants.service';

export interface StaffUser {
  id: string;
  tenant_id: string;
  email: string;
  roles: Role[];
}

const PROVIDER = 'firebase';

@Injectable()
export class StaffService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repos: Repos,
    private readonly provider: IdentityProvider,
    private readonly tenants: TenantsService,
    private readonly access: AccessService,
  ) {}

  private async viaProvider<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new IdentityError('PROVIDER_UNAVAILABLE', 'identity provider unavailable');
      }
      throw err;
    }
  }

  /**
   * Operator signup: a new operator tenant and its first admin. The provider is called first, so a
   * provider failure leaves no tenant and no user; if our transaction then fails, the provider
   * user is removed again.
   */
  async signUpOperator(
    input: Pick<OperatorSignupRequest, 'tenant_name' | 'slug' | 'email' | 'password'>,
  ): Promise<{ tenant: TenantView; user: StaffUser }> {
    const email = input.email.trim().toLowerCase();
    if (await this.tenants.slugTaken(input.slug)) throw new IdentityError('SLUG_TAKEN', 'slug already taken');
    const providerTenantId = await this.tenants.createProviderTenant(input.slug);
    const { uid } = await this.viaProvider(() =>
      this.provider.createUser(providerTenantId, { email, password: input.password }),
    );
    const tenantId = uuidv7();
    const userId = uuidv7();
    try {
      const tenant = await this.uow.run(tenantId, async (tx) => {
        const row = await this.tenants.createInTx(tx, {
          id: tenantId,
          type: 'operator',
          name: input.tenant_name,
          slug: input.slug,
          providerTenantId,
        });
        await this.repos.users.insert(tx, { tenant_id: tenantId, id: userId, email, kind: 'staff' });
        await this.repos.users.insertRole(tx, tenantId, userId, 'operator_admin');
        await this.repos.users.insertProviderLink(tx, {
          tenant_id: tenantId,
          user_id: userId,
          provider: PROVIDER,
          provider_uid: uid,
        });
        return row;
      });
      return {
        tenant: toTenantView(tenant),
        user: { id: userId, tenant_id: tenantId, email, roles: ['operator_admin'] },
      };
    } catch (err) {
      await this.provider.deleteUser(providerTenantId, uid).catch(() => undefined);
      throw mapTenantViolation(err);
    }
  }

  /** The platform admin: seeded at boot, idempotent (the same email returns the same account). */
  async createPlatformAdmin(input: { email: string; password: string }): Promise<StaffUser> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.uow.run(PLATFORM_TENANT_ID, (tx) =>
      this.repos.users.findByEmail(tx, PLATFORM_TENANT_ID, email),
    );
    if (existing) return { id: existing.id, tenant_id: PLATFORM_TENANT_ID, email, roles: existing.roles };
    return this.insertStaff(PLATFORM_TENANT_ID, email, input.password, 'platform_admin');
  }

  private async insertStaff(
    tenantId: string,
    email: string,
    password: string,
    role: Role,
  ): Promise<StaffUser> {
    const providerTenantId = await this.tenants.providerTenantFor(tenantId);
    const { uid } = await this.viaProvider(() =>
      this.provider.createUser(providerTenantId, { email, password }),
    );
    const userId = uuidv7();
    try {
      await this.uow.run(tenantId, async (tx) => {
        await this.repos.users.insert(tx, { tenant_id: tenantId, id: userId, email, kind: 'staff' });
        await this.repos.users.insertRole(tx, tenantId, userId, role);
        await this.repos.users.insertProviderLink(tx, {
          tenant_id: tenantId,
          user_id: userId,
          provider: PROVIDER,
          provider_uid: uid,
        });
      });
    } catch (err) {
      await this.provider.deleteUser(providerTenantId, uid).catch(() => undefined);
      if (err instanceof UniqueViolationError && err.key === 'email') {
        throw new IdentityError('EMAIL_TAKEN', 'email already registered');
      }
      throw err;
    }
    return { id: userId, tenant_id: tenantId, email, roles: [role] };
  }

  /** Invite a member into the inviter's tenant (never a tenant from the request). */
  async invite(subject: Subject, input: InviteStaffRequest): Promise<StaffUser> {
    const tenantId = effectiveTenant(subject);
    await this.access.authorize(subject, 'staff.invite', { tenant_id: tenantId });
    const email = input.email.trim().toLowerCase();
    const taken = await this.uow.run(tenantId, (tx) =>
      this.repos.users.findByEmail(tx, tenantId, email),
    );
    if (taken) throw new IdentityError('EMAIL_TAKEN', 'email already registered');
    return this.insertStaff(tenantId, email, input.password, input.role);
  }

  async list(subject: Subject): Promise<StaffUser[]> {
    const tenantId = effectiveTenant(subject);
    await this.access.authorize(subject, 'staff.list', { tenant_id: tenantId });
    return this.listUnsafeForTest(tenantId);
  }

  /** No authorization: for the boot seed and tests. */
  async listUnsafeForTest(tenantId: string): Promise<StaffUser[]> {
    const rows = await this.uow.run(tenantId, (tx) => this.repos.users.listStaff(tx, tenantId));
    return rows.map((r) => ({
      id: r.id,
      tenant_id: r.tenant_id,
      email: r.email ?? '',
      roles: r.roles,
    }));
  }
}
