import { decodePayload } from '@ex-mio/service-kit/testing';
import { buildKernel } from './testing/kernel'; // RED: module does not exist yet

/*
 * Choke point: StaffService + SessionsService over the users repository and the
 * IdentityProvider port (FakeIdentityProvider in-process; Firebase Auth Emulator
 * adapter is covered by the provider contract suite in Stage B).
 * Backlog: MIO-040, MIO-042, MIO-043.
 */

const PW = 'correct horse battery';
const signup = (k: Awaited<ReturnType<typeof buildKernel>>, slug: string, email: string) =>
  k.staff.signUpOperator({ tenant_name: slug, slug, email, password: PW });

/** Sign in and return the verified Subject, exactly as a controller would build it. */
const actor = async (k: Awaited<ReturnType<typeof buildKernel>>, tenantId: string, email: string) =>
  k.subjectOf(
    await k.verify(
      (await k.sessions.login(tenantId, { email, password: PW, audience: 'identity' }))
        .access_token,
      'identity',
    ),
  );

describe('INV-STAFF: accounts are keyed (tenant_id, user_id); email is unique per tenant only', () => {
  // Mutation: make the email unique globally.
  it('INV-STAFF-1 the same email in two tenants is two accounts with two user ids', async () => {
    const k = await buildKernel();
    const a = await signup(k, 'tenant-a', 'dup@x.test');
    const b = await signup(k, 'tenant-b', 'dup@x.test');
    expect(a.user.id).not.toBe(b.user.id);
    expect(a.user.tenant_id).toBe(a.tenant.id);
    expect(b.user.tenant_id).toBe(b.tenant.id);
    // and each signs in only to its own tenant, as its own user
    const ta = await k.sessions.login(a.tenant.id, {
      email: 'dup@x.test',
      password: PW,
      audience: 'web',
    });
    const tb = await k.sessions.login(b.tenant.id, {
      email: 'dup@x.test',
      password: PW,
      audience: 'web',
    });
    expect(decodePayload(ta.access_token)).toMatchObject({ sub: a.user.id, tid: a.tenant.id });
    expect(decodePayload(tb.access_token)).toMatchObject({ sub: b.user.id, tid: b.tenant.id });
  });

  // Mutation: drop the (tenant_id, lower(email)) uniqueness check.
  it('INV-STAFF-2 the same email twice in one tenant is EMAIL_TAKEN, case-insensitively', async () => {
    const k = await buildKernel();
    const a = await signup(k, 'tenant-a', 'boss@x.test');
    const admin = await actor(k, a.tenant.id, 'boss@x.test');
    await expect(
      k.staff.invite(admin, { email: 'BOSS@x.test', password: PW, role: 'operator_staff' }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
  });

  // Mutation: let invite take the tenant from the request instead of the actor's token.
  it("INV-STAFF-3 an invited member lands in the inviter's tenant with the requested role only", async () => {
    const k = await buildKernel();
    const a = await signup(k, 'tenant-a', 'boss@x.test');
    const b = await signup(k, 'tenant-b', 'boss@y.test');
    const admin = await actor(k, a.tenant.id, 'boss@x.test');
    const member = await k.staff.invite(admin, {
      email: 'new@x.test',
      password: PW,
      role: 'operator_staff',
    });
    expect(member).toMatchObject({ tenant_id: a.tenant.id, roles: ['operator_staff'] });
    expect((await k.staff.list(admin)).map((u) => u.email).sort()).toEqual([
      'boss@x.test',
      'new@x.test',
    ]);
    expect(await k.staff.listUnsafeForTest(b.tenant.id)).toHaveLength(1);
  });

  // Mutation: let a non-admin invite (drop the access.authorize call).
  it('INV-STAFF-4 operator_staff cannot invite; the attempt creates no account', async () => {
    const k = await buildKernel();
    const a = await signup(k, 'tenant-a', 'boss@x.test');
    const adminSubject = await actor(k, a.tenant.id, 'boss@x.test');
    await k.staff.invite(adminSubject, {
      email: 'staff@x.test',
      password: PW,
      role: 'operator_staff',
    });
    const staff = await actor(k, a.tenant.id, 'staff@x.test');
    await expect(
      k.staff.invite(staff, { email: 'x@x.test', password: PW, role: 'operator_staff' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await k.staff.listUnsafeForTest(a.tenant.id)).toHaveLength(2);
  });

  // Mutation: return a distinct error for an unknown email, or skip the password check.
  it('INV-STAFF-5 wrong password and unknown email are the same INVALID_CREDENTIALS', async () => {
    const k = await buildKernel();
    const a = await signup(k, 'tenant-a', 'boss@x.test');
    const attempt = (email: string, password: string) =>
      k.sessions.login(a.tenant.id, { email, password, audience: 'web' }).catch((e) => e);
    const wrong = await attempt('boss@x.test', 'not the password');
    const unknown = await attempt('ghost@x.test', PW);
    expect(wrong).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(unknown).toMatchObject({ code: 'INVALID_CREDENTIALS', message: wrong.message });
  });

  // Mutation: persist the tenant before the provider call and keep it on failure.
  it('INV-STAFF-6 if the provider is down, signup leaves no tenant and no user', async () => {
    const k = await buildKernel({ providerDown: true });
    await expect(signup(k, 'tenant-a', 'boss@x.test')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(await k.tenants.listOperatorSlugs()).toEqual([]);
    expect(k.outbox.events().filter((e) => e.type === 'identity.tenant.created')).toEqual([]);
  });

  // Mutation: copy roles from the provider's custom claims into the token.
  it('INV-STAFF-7 roles come from our database, never from provider claims', async () => {
    const k = await buildKernel({ providerClaims: { roles: ['platform_admin'], tid: 'x' } });
    const a = await signup(k, 'tenant-a', 'boss@x.test');
    const { access_token } = await k.sessions.login(a.tenant.id, {
      email: 'boss@x.test',
      password: PW,
      audience: 'web',
    });
    expect(decodePayload(access_token)).toMatchObject({
      roles: ['operator_admin'],
      tid: a.tenant.id,
    });
  });

  // Mutation: let the provider's user id leak into `sub`.
  it('INV-STAFF-8 sub is our uuidv7 user id; the provider subject never appears in a token', async () => {
    const k = await buildKernel();
    const a = await signup(k, 'tenant-a', 'boss@x.test');
    const { access_token } = await k.sessions.login(a.tenant.id, {
      email: 'boss@x.test',
      password: PW,
      audience: 'web',
    });
    const payload = decodePayload(access_token);
    expect(payload.sub).toBe(a.user.id);
    expect(payload.sub).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(access_token).not.toContain(k.provider.subjectFor(a.user.id));
  });
});
