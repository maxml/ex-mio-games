import type { Action, Role } from '@ex-mio/contracts';
import { COIN_VALUE_ACTIONS } from '@ex-mio/contracts';
import { buildKernel } from './testing/kernel'; // RED: module does not exist yet
import type { Subject } from './services/access.service'; // RED: module does not exist yet

/*
 * Choke point: AccessService.can / authorize (services/access.service.ts).
 * Every protected action asks it. Backlog: MIO-045, MIO-034, MIO-154 (same-tenant
 * player A vs B), cross-tenant 404.
 */

const PW = 'correct horse battery';
const TA = '0190a1b2-c3d4-7e5f-8a6b-0000000000aa';
const TB = '0190a1b2-c3d4-7e5f-8a6b-0000000000bb';
const PLATFORM = '0190a1b2-c3d4-7e5f-8a6b-0000000000cc';
const U1 = '0190a1b2-c3d4-7e5f-8a6b-000000000001';
const U2 = '0190a1b2-c3d4-7e5f-8a6b-000000000002';

const subject = (roles: Role[], tenantId: string, over: Partial<Subject> = {}): Subject => ({
  userId: U1,
  tenantId,
  roles,
  ...over,
});

describe('INV-RBAC: can(subject, action, object) is default-deny and tenant-bound', () => {
  const k = buildKernel();

  // Mutation: flip any single cell (e.g. let operator_staff invite) -> that row goes red.
  const matrix: Array<[Role, Action, boolean]> = [
    ['operator_admin', 'staff.invite', true],
    ['operator_admin', 'staff.list', true],
    ['operator_admin', 'credentials.rotate', true],
    ['operator_admin', 'credentials.read', true],
    ['operator_admin', 'audit.read', true],
    ['operator_admin', 'players.read', true],
    ['operator_admin', 'acting.start', false],
    ['operator_admin', 'tenant.suspend', false],
    ['operator_staff', 'players.read', true],
    ['operator_staff', 'staff.list', true],
    ['operator_staff', 'staff.invite', false],
    ['operator_staff', 'credentials.rotate', false],
    ['operator_staff', 'credentials.read', false],
    ['operator_staff', 'audit.read', false],
    ['operator_staff', 'acting.start', false],
    ['player', 'player.self.read', true],
    ['player', 'players.read', false],
    ['player', 'staff.list', false],
    ['player', 'credentials.read', false],
    ['player', 'acting.start', false],
    ['player', 'coins.credit', false],
  ];

  it.each(matrix)('INV-RBAC-1 %s / %s -> %s (own tenant)', async (role, action, allowed) => {
    const kernel = await k;
    expect(kernel.access.can(subject([role], TA), action, { tenant_id: TA, user_id: U1 })).toBe(
      allowed,
    );
  });

  // Mutation: allow unknown actions (default-allow).
  it('INV-RBAC-2 an action that is not in the vocabulary is denied for every role', async () => {
    const kernel = await k;
    for (const role of ['platform_admin', 'operator_admin', 'operator_staff', 'player'] as Role[]) {
      expect(kernel.access.can(subject([role], TA), 'rm.rf' as Action, { tenant_id: TA })).toBe(
        false,
      );
    }
  });

  // Mutation: compare object.tenant_id only when present ("null tenant means all tenants").
  it('INV-RBAC-3 there is no "no tenant means all tenants" shortcut', async () => {
    const kernel = await k;
    const admin = subject(['operator_admin'], TA);
    expect(
      kernel.access.can(admin, 'staff.list', { tenant_id: undefined as unknown as string }),
    ).toBe(false);
    expect(
      kernel.access.can({ ...admin, tenantId: undefined as unknown as string }, 'staff.list', {
        tenant_id: TA,
      }),
    ).toBe(false);
    expect(
      kernel.access.can(subject(['platform_admin'], PLATFORM), 'staff.list', {
        tenant_id: undefined as unknown as string,
      }),
    ).toBe(false);
  });

  // Mutation: remove the platform tenant check on tenant.suspend.
  it('INV-RBAC-4 only platform_admin may suspend a tenant, and only a platform_admin may start acting', async () => {
    const kernel = await k;
    const root = subject(['platform_admin'], PLATFORM);
    expect(kernel.access.can(root, 'acting.start', { tenant_id: PLATFORM })).toBe(true);
    expect(kernel.access.can(root, 'tenant.suspend', { tenant_id: TA })).toBe(true);
    expect(
      kernel.access.can(subject(['operator_admin'], TA), 'tenant.suspend', { tenant_id: TA }),
    ).toBe(false);
  });

  // Mutation: a player's roles array containing operator_admin is trusted without the tenant check (n/a) —
  // concretely: let `roles` of a subject from tenant A apply to an object in tenant B.
  it('INV-RBAC-5 a role in tenant A grants nothing on an object of tenant B', async () => {
    const kernel = await k;
    for (const role of ['operator_admin', 'operator_staff', 'player'] as Role[]) {
      expect(kernel.access.can(subject([role], TA), 'players.read', { tenant_id: TB })).toBe(false);
      expect(
        kernel.access.can(subject([role], TA), 'player.self.read', { tenant_id: TB, user_id: U1 }),
      ).toBe(false);
    }
  });
});

describe('INV-OWN: authorize() answers 404 for what the caller must not know exists, 403 for what it may not do', () => {
  // Mutation: return FORBIDDEN instead of NOT_FOUND for a cross-tenant object.
  it('INV-OWN-1 cross-tenant: an operator admin of A reading an object of B gets NOT_FOUND, not FORBIDDEN', async () => {
    const k = await buildKernel();
    await expect(
      k.access.authorize(subject(['operator_admin'], TA), 'players.read', {
        tenant_id: TB,
        user_id: U2,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // Mutation: authorize player.self.read on role only, without comparing user_id.
  it('INV-OWN-2 same tenant, player A reading player B gets NOT_FOUND; reading self is allowed', async () => {
    const k = await buildKernel();
    const playerA = subject(['player'], TA, { userId: U1 });
    await expect(
      k.access.authorize(playerA, 'player.self.read', { tenant_id: TA, user_id: U2 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      k.access.authorize(playerA, 'player.self.read', { tenant_id: TA, user_id: U1 }),
    ).resolves.toBeUndefined();
  });

  // Mutation: return NOT_FOUND for same-tenant role failures too (or allow them).
  it('INV-OWN-3 same tenant, role too weak: FORBIDDEN', async () => {
    const k = await buildKernel();
    await expect(
      k.access.authorize(subject(['operator_staff'], TA), 'staff.invite', { tenant_id: TA }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('INV-ACTAUTH: acting_tenant is the only way across, and it is audited', () => {
  const acting = (tenantId: string, over: Partial<Subject> = {}) =>
    subject(['platform_admin'], PLATFORM, {
      userId: U2,
      acting: { tenantId, reason: 'ticket 42' },
      ...over,
    });

  // Mutation: let platform_admin through on operator objects without acting.
  it('INV-ACTAUTH-1 platform_admin without acting on an operator-tenant object is ACTING_REQUIRED (403)', async () => {
    const k = await buildKernel();
    await expect(
      k.access.authorize(subject(['platform_admin'], PLATFORM), 'staff.list', { tenant_id: TA }),
    ).rejects.toMatchObject({ code: 'ACTING_REQUIRED' });
  });

  // Mutation: let a path/body tenant override the acting tenant (backlog MIO-034 named mutation).
  it('INV-ACTAUTH-2 an acting session for A used on an object of B is ACTING_TENANT_MISMATCH and is not audited as success', async () => {
    const k = await buildKernel();
    await expect(
      k.access.authorize(acting(TA), 'staff.list', { tenant_id: TB }),
    ).rejects.toMatchObject({ code: 'ACTING_TENANT_MISMATCH' });
    expect(await k.audit.list(TB)).toEqual([]);
    expect(await k.audit.list(TA)).toEqual([]);
  });

  // Mutation: skip audit.record inside authorize for acting subjects.
  it('INV-ACTAUTH-3 each acting request writes one audit entry naming both identities; the operator reads it back correctly', async () => {
    const k = await buildKernel();
    await k.access.authorize(acting(TA), 'staff.list', { tenant_id: TA });
    await k.access.authorize(acting(TA), 'players.read', { tenant_id: TA, user_id: U1 });
    const entries = await k.audit.list(TA);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.action)).toEqual(['staff.list', 'players.read']);
    for (const e of entries) {
      expect(e).toMatchObject({
        actor_user_id: U2,
        actor_tenant_id: PLATFORM,
        acting_tenant_id: TA,
        reason: 'ticket 42',
      });
    }
    expect(await k.audit.list(TB)).toEqual([]);
  });

  // Mutation: write an audit row for every authorize, acting or not (noise) — or never write one.
  it('INV-ACTAUTH-4 an ordinary (non-acting) operator request writes no acting-audit entry', async () => {
    const k = await buildKernel();
    await k.access.authorize(subject(['operator_admin'], TA), 'staff.list', { tenant_id: TA });
    expect(await k.audit.list(TA)).toEqual([]);
  });

  // Mutation: drop the COIN_VALUE_ACTIONS deny for acting subjects.
  it('INV-ACTAUTH-5 an acting session cannot call coin commands that move value; coins.adjust is the audited exception', async () => {
    const k = await buildKernel();
    for (const action of COIN_VALUE_ACTIONS) {
      expect(k.access.can(acting(TA), action, { tenant_id: TA })).toBe(false);
      await expect(k.access.authorize(acting(TA), action, { tenant_id: TA })).rejects.toMatchObject(
        { code: 'ACTING_FORBIDDEN' },
      );
    }
    await expect(
      k.access.authorize(acting(TA), 'coins.adjust', { tenant_id: TA }),
    ).resolves.toBeUndefined();
    expect((await k.audit.list(TA)).map((e) => e.action)).toEqual(['coins.adjust']);
  });

  // Mutation: let an operator-role subject carry an acting claim through can().
  it('INV-ACTAUTH-6 an acting claim on a subject without platform_admin grants nothing', async () => {
    const k = await buildKernel();
    const forged = subject(['operator_admin'], TA, { acting: { tenantId: TB, reason: 'x' } });
    expect(k.access.can(forged, 'staff.list', { tenant_id: TB })).toBe(false);
    await expect(k.access.authorize(forged, 'staff.list', { tenant_id: TB })).rejects.toBeDefined();
    expect(await k.audit.list(TB)).toEqual([]);
  });

  // Mutation: startActing forgets audit.record.
  it('INV-ACTAUTH-7 starting a session is itself audited (acting.start) in the target tenant', async () => {
    const k = await buildKernel();
    const a = await k.staff.signUpOperator({
      tenant_name: 'A',
      slug: 'a',
      email: 'boss@a.test',
      password: PW,
    });
    const root = await k.staff.createPlatformAdmin({ email: 'root@mio.test', password: PW });
    const platform = await k.tenants.platformTenant();
    const rootSubject = k.subjectOf(
      await k.verify(
        (
          await k.sessions.login(platform.id, {
            email: 'root@mio.test',
            password: PW,
            audience: 'identity',
          })
        ).access_token,
        'identity',
      ),
    );
    await k.sessions.startActing(rootSubject, { tenant_id: a.tenant.id, reason: 'ticket 42' });
    expect(await k.audit.list(a.tenant.id)).toEqual([
      expect.objectContaining({
        action: 'acting.start',
        actor_user_id: root.id,
        acting_tenant_id: a.tenant.id,
        reason: 'ticket 42',
      }),
    ]);
  });
});
