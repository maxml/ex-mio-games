import { signLaunchToken } from '@ex-mio/service-kit/testing';
import { captureProductEvents, type ProductEventCapture } from '@ex-mio/logger/testing';
import { buildKernel } from './testing/kernel';

/*
 * Product analytics at the identity choke points (D-19): StaffService.signUpOperator,
 * CredentialsService.issue/rotate, LaunchService.exchange. Each test runs the real service method
 * and asserts exactly one line that conforms to the vendored Varta schema (the capture helper
 * validates every line with ajv and fails on a dropped event).
 *
 * Mutations that must turn these red:
 *  - emit before the transaction commits: the rollback tests below see a line for a request that
 *    left nothing behind;
 *  - put the email, or the casino-side player id, in props: the no-PII tests fail (and the schema
 *    check rejects an email-valued prop).
 */

const PW = 'correct horse battery';
const EMAIL = 'boss@a.test';

let cap: ProductEventCapture;
beforeEach(() => {
  cap = captureProductEvents();
});
afterEach(() => cap.stop());

const noLeak = (secrets: string[]): void => {
  const text = JSON.stringify(cap.events());
  for (const s of secrets) expect(text).not.toContain(s);
};

describe('identity product events', () => {
  it('signUpOperator emits exactly one identity.operator_signed_up, after the commit, with no email', async () => {
    const k = await buildKernel();
    const a = await k.staff.signUpOperator({
      tenant_name: 'A',
      slug: 'aa',
      email: EMAIL,
      password: PW,
    });
    const events = cap.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'identity.operator_signed_up',
      tenant_id: a.tenant.id,
      actor_type: 'operator',
      actor_id: a.user.id,
      props: { role: 'operator_admin' },
    });
    noLeak([EMAIL, 'boss', PW]);
  });

  it('a rolled-back signup emits nothing', async () => {
    const broken = await buildKernel({ outboxFails: true });
    cap.clear();
    await expect(
      broken.staff.signUpOperator({
        tenant_name: 'B',
        slug: 'bb',
        email: 'x@b.test',
        password: PW,
      }),
    ).rejects.toBeDefined();
    expect(cap.events()).toEqual([]);
  });

  it('a refused signup (slug taken) emits nothing', async () => {
    const k = await buildKernel();
    await k.staff.signUpOperator({ tenant_name: 'A', slug: 'aa', email: EMAIL, password: PW });
    cap.clear();
    await expect(
      k.staff.signUpOperator({ tenant_name: 'A2', slug: 'aa', email: 'o@a.test', password: PW }),
    ).rejects.toMatchObject({ code: 'SLUG_TAKEN' });
    expect(cap.events()).toEqual([]);
  });

  it('issueFor emits one identity.credential_issued for the acting admin, environment only', async () => {
    const k = await buildKernel();
    const a = await k.staff.signUpOperator({
      tenant_name: 'A',
      slug: 'aa',
      email: EMAIL,
      password: PW,
    });
    const admin = k.subjectOf(
      await k.verify(
        (await k.sessions.login(a.tenant.id, { email: EMAIL, password: PW, audience: 'identity' }))
          .access_token,
        'identity',
      ),
    );
    cap.clear();
    const key = await k.credentials.issueFor(admin, 'sim-casino', 'sandbox');
    const events = cap.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'identity.credential_issued',
      tenant_id: a.tenant.id,
      actor_type: 'operator',
      actor_id: admin.userId,
      props: { environment: 'sandbox', rotated: false },
    });
    noLeak([key.api_key, key.hmac_secret, key.key_id, EMAIL]);

    cap.clear();
    await k.credentials.rotate(admin, key.key_id, { graceSeconds: 0 });
    expect(cap.events()).toHaveLength(1);
    expect(cap.events()[0]).toMatchObject({ props: { environment: 'sandbox', rotated: true } });
  });

  it('a failed credential insert or rotation emits nothing', async () => {
    const k = await buildKernel();
    const a = await k.staff.signUpOperator({
      tenant_name: 'A',
      slug: 'aa',
      email: EMAIL,
      password: PW,
    });
    const admin = k.subjectOf(
      await k.verify(
        (await k.sessions.login(a.tenant.id, { email: EMAIL, password: PW, audience: 'identity' }))
          .access_token,
        'identity',
      ),
    );
    cap.clear();
    await expect(
      k.credentials.rotate(admin, 'key_unknown', { graceSeconds: 0 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(cap.events()).toEqual([]);
  });

  it('a launch emits exactly one identity.player_launched, without the casino player id', async () => {
    const k = await buildKernel();
    const a = await k.staff.signUpOperator({
      tenant_name: 'A',
      slug: 'aa',
      email: EMAIL,
      password: PW,
    });
    const key = await k.credentials.issue(a.tenant.id, 'sim-casino', { environment: 'production' });
    cap.clear();
    const token = signLaunchToken({
      keyId: key.key_id,
      secret: key.hmac_secret,
      now: k.now(),
      externalPlayerId: 'casino-player-4711',
    });
    const session = await k.launch.exchange({ token, audience: 'engagement' });
    const events = cap.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'identity.player_launched',
      tenant_id: a.tenant.id,
      actor_type: 'player',
      actor_id: session.user_id,
      props: { sandbox: false, new_player: true },
    });
    noLeak(['casino-player-4711', '4711', EMAIL]);

    // a replay of the single-use token is refused and emits nothing
    cap.clear();
    await expect(k.launch.exchange({ token, audience: 'engagement' })).rejects.toMatchObject({
      code: 'LAUNCH_TOKEN_REPLAYED',
    });
    expect(cap.events()).toEqual([]);
  });

  it('a bad launch token emits nothing', async () => {
    const k = await buildKernel();
    await expect(
      k.launch.exchange({ token: 'a.b.c', audience: 'engagement' }),
    ).rejects.toBeDefined();
    expect(cap.events()).toEqual([]);
  });
});
