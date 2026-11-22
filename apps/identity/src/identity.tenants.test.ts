import { PLATFORM_TENANT_ID } from '@ex-mio/contracts';
import { buildKernel } from './testing/kernel';

/*
 * Choke point: TenantsService (services/tenants.service.ts) over the tenants
 * repository; DB twin in tests/compose/src/identity.compose.test.ts.
 * Backlog: MIO-030 (model), MIO-031 (resolution), MIO-032 (isolation).
 */

describe('INV-TEN: tenant registry', () => {
  // Mutation: drop the "exactly one platform tenant" check (and the partial unique index).
  it('INV-TEN-1 the platform tenant is seeded once and a second platform tenant is refused', async () => {
    const k = await buildKernel();
    const platform = await k.tenants.platformTenant();
    expect(platform).toMatchObject({ type: 'platform', status: 'active' });
    await expect(
      k.tenants.create({ type: 'platform', name: 'Shadow', slug: 'shadow' }),
    ).rejects.toMatchObject({ code: 'TENANT_PLATFORM_EXISTS' });
    // seeding again is idempotent: same tenant, not a second one
    expect((await k.tenants.platformTenant()).id).toBe(platform.id);
  });

  // F8. Mutation: seed the platform tenant under a generated id (the verifier and `can()` compare
  // against the fixed constant, so the two would disagree and no platform admin could act).
  it('INV-TEN-1 the platform tenant has the fixed id PLATFORM_TENANT_ID, and its admin token carries it', async () => {
    const k = await buildKernel();
    expect((await k.tenants.platformTenant()).id).toBe(PLATFORM_TENANT_ID);
    await k.staff.createPlatformAdmin({
      email: 'root@mio.test',
      password: 'correct horse battery',
    });
    const login = await k.sessions.login(PLATFORM_TENANT_ID, {
      email: 'root@mio.test',
      password: 'correct horse battery',
      audience: 'identity',
    });
    expect(await k.verify(login.access_token, 'identity')).toMatchObject({
      tid: PLATFORM_TENANT_ID,
      roles: ['platform_admin'],
    });
  });

  // Mutation: let operator signup read `type` from the request.
  it('INV-TEN-2 operator signup creates an operator tenant, never a platform one', async () => {
    const k = await buildKernel();
    const { tenant } = await k.staff.signUpOperator({
      tenant_name: 'Acme',
      slug: 'acme',
      email: 'boss@acme.test',
      password: 'correct horse battery',
    });
    expect(tenant).toMatchObject({ type: 'operator', status: 'active', slug: 'acme' });
  });

  // Mutation: write the tenant row outside the outbox transaction.
  it('INV-TEN-3 the tenant row and its identity.tenant.created event commit together or not at all', async () => {
    const ok = await buildKernel();
    const { tenant } = await ok.tenants.create({ type: 'operator', name: 'A', slug: 'aa' });
    expect(ok.outbox.events().filter((e) => e.type === 'identity.tenant.created')).toEqual([
      expect.objectContaining({ tenant_id: tenant.id, payload: { name: 'A', slug: 'aa' } }),
    ]);

    const broken = await buildKernel({ outboxFails: true });
    await expect(
      broken.tenants.create({ type: 'operator', name: 'B', slug: 'bb' }),
    ).rejects.toBeDefined();
    await expect(broken.tenants.resolveByHost('bb.mio.test')).rejects.toMatchObject({
      code: 'TENANT_UNRESOLVED',
    });
    expect(await broken.tenants.listOperatorSlugs()).toEqual([]);
  });

  // Mutation: allow duplicate slugs (drop the unique constraint handling).
  it('INV-TEN-4 a slug is unique and a clash is SLUG_TAKEN', async () => {
    const k = await buildKernel();
    await k.tenants.create({ type: 'operator', name: 'A', slug: 'dup' });
    await expect(
      k.tenants.create({ type: 'operator', name: 'B', slug: 'dup' }),
    ).rejects.toMatchObject({ code: 'SLUG_TAKEN' });
  });

  // Mutation: fall back to a default tenant when the host is unknown.
  it('INV-TEN-5 a host resolves to its tenant; an unknown host is TENANT_UNRESOLVED, never a default', async () => {
    const k = await buildKernel();
    const { tenant } = await k.tenants.create({ type: 'operator', name: 'A', slug: 'acme' });
    await expect(k.tenants.resolveByHost('acme.mio.test')).resolves.toMatchObject({
      id: tenant.id,
    });
    await expect(k.tenants.resolveByHost('ACME.mio.test')).resolves.toMatchObject({
      id: tenant.id,
    });
    for (const host of ['', 'nobody.mio.test', 'mio.test', 'acme.mio.test.evil.test']) {
      await expect(k.tenants.resolveByHost(host)).rejects.toMatchObject({
        code: 'TENANT_UNRESOLVED',
      });
    }
  });

  // Mutation: skip the status check at login / token issue.
  it('INV-TEN-6 a suspended tenant cannot sign in, and sign-in works again when reactivated', async () => {
    const k = await buildKernel();
    const { tenant } = await k.staff.signUpOperator({
      tenant_name: 'Acme',
      slug: 'acme',
      email: 'boss@acme.test',
      password: 'correct horse battery',
    });
    const login = () =>
      k.sessions.login(tenant.id, {
        email: 'boss@acme.test',
        password: 'correct horse battery',
        audience: 'web',
      });
    await expect(login()).resolves.toBeDefined();
    await k.tenants.setStatus(tenant.id, 'suspended');
    await expect(login()).rejects.toMatchObject({ code: 'TENANT_SUSPENDED' });
    await k.tenants.setStatus(tenant.id, 'active');
    await expect(login()).resolves.toBeDefined();
  });
});
