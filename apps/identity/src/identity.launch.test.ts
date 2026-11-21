import {
  signJwt,
  signLaunchToken,
  tamperPayload,
  decodePayload,
} from '@ex-mio/service-kit/testing';
import { buildKernel } from './testing/kernel'; // RED: module does not exist yet

/*
 * Choke point: LaunchService.exchange (services/launch.service.ts) and
 * PlayersService.resolveOrCreate (services/players.service.ts); DB twins in
 * tests/compose/src/identity.compose.test.ts.
 * Backlog: MIO-044 (all acceptance criteria), MIO-040 note (verify before the provider).
 */

const PW = 'correct horse battery';
type K = Awaited<ReturnType<typeof buildKernel>>;

async function world() {
  const k = await buildKernel();
  const a = await k.staff.signUpOperator({
    tenant_name: 'A',
    slug: 'a',
    email: 'boss@a.test',
    password: PW,
  });
  const b = await k.staff.signUpOperator({
    tenant_name: 'B',
    slug: 'b',
    email: 'boss@b.test',
    password: PW,
  });
  const keyA = await k.credentials.issue(a.tenant.id, 'sim-casino');
  const keyB = await k.credentials.issue(b.tenant.id, 'sim-casino');
  const sign = (over: Partial<Parameters<typeof signLaunchToken>[0]> = {}) =>
    signLaunchToken({
      keyId: keyA.key_id,
      secret: keyA.hmac_secret,
      now: k.now(),
      externalPlayerId: 'ext-1',
      ...over,
    });
  const exchange = (token: string, audience: 'engagement' | 'web' = 'engagement') =>
    k.launch.exchange({ token, audience });
  return { k, a, b, keyA, keyB, sign, exchange };
}

/** Staff-side provider calls the tests make themselves (signup, login); anything else came from a launch. */
const STAFF_METHODS = ['createTenant', 'createUser', 'verifyCredentials'];
const launchProviderCalls = (k: K) =>
  k.provider.calls.filter((c) => !STAFF_METHODS.includes(c.method));

const untouched = async (k: K, tenantId: string) => {
  expect(await k.players.links(tenantId)).toEqual([]);
  expect(launchProviderCalls(k)).toEqual([]);
};

describe('INV-LAUNCH: a launch token becomes a player session only when every check passes', () => {
  // Mutation: build the session from the claims without verifying (skip verify, keep the rest).
  // Reviewer amendment (identity epic review, D-21 B2): players do not use the identity provider.
  // The frozen version pinned "one provider call", which passed only because the launch still
  // called a provider method that had become a no-op; it pinned the opposite of D-21.
  // Mutation (B2): the launch calls ANY provider method, or stores a provider link for the player.
  it("INV-LAUNCH-1 a valid token yields a player session pinned to the key's tenant, one link, no provider call and no provider link (D-21)", async () => {
    const { k, a, sign, exchange } = await world();
    const before = k.provider.calls.length;
    const res = await exchange(sign());
    const claims = await k.verify(res.access_token, 'engagement');
    expect(claims).toMatchObject({ tid: a.tenant.id, roles: ['player'], sub: res.user_id });
    expect(res.tenant_id).toBe(a.tenant.id);
    expect(await k.players.links(a.tenant.id)).toEqual([
      { user_id: res.user_id, platform: 'sim-casino', external_player_id: 'ext-1' },
    ]);
    expect(k.provider.calls.slice(before)).toEqual([]);
    expect(k.store.providerLinks.filter((l) => l.user_id === res.user_id)).toEqual([]);
  });

  // Mutation (one per row): remove the corresponding check in LaunchService.verify.
  const rows: Array<[string, (w: Awaited<ReturnType<typeof world>>) => string, string]> = [
    ['bad signature', (w) => w.sign({ secret: 'x'.repeat(40) }), 'LAUNCH_TOKEN_INVALID'],
    ['alg none', (w) => w.sign({ alg: 'none' }), 'LAUNCH_TOKEN_INVALID'],
    ['alg HS512 (not on the allow-list)', (w) => w.sign({ alg: 'HS512' }), 'LAUNCH_TOKEN_INVALID'],
    [
      "signed with another tenant's secret under this tenant's key id",
      (w) => w.sign({ secret: w.keyB.hmac_secret }),
      'LAUNCH_TOKEN_INVALID',
    ],
    ['unknown key id', (w) => w.sign({ keyId: 'key_does_not_exist' }), 'LAUNCH_TOKEN_INVALID'],
    ['expired', (w) => w.sign({ iat: w.k.now() - 600, ttl: 120 }), 'LAUNCH_TOKEN_EXPIRED'],
    ['iat in the future', (w) => w.sign({ iat: w.k.now() + 120 }), 'LAUNCH_TOKEN_INVALID'],
    ['lifetime above 300 s', (w) => w.sign({ ttl: 301 }), 'LAUNCH_TOKEN_INVALID'],
    ['wrong audience', (w) => w.sign({ aud: 'engagement' }), 'LAUNCH_TOKEN_INVALID'],
    ['no jti', (w) => w.sign({ extra: { jti: undefined } }), 'LAUNCH_TOKEN_INVALID'],
    [
      'external player id changed after signing',
      (w) => tamperPayload(w.sign(), { pid: 'ext-2' }),
      'LAUNCH_TOKEN_INVALID',
    ],
    ['empty external player id', (w) => w.sign({ externalPlayerId: '' }), 'LAUNCH_TOKEN_INVALID'],
    [
      'external player id of 300 chars',
      (w) => w.sign({ externalPlayerId: 'p'.repeat(300) }),
      'LAUNCH_TOKEN_INVALID',
    ],
    ['not a token at all', () => 'garbage.garbage.garbage', 'LAUNCH_TOKEN_INVALID'],
  ];

  it.each(rows)(
    'INV-LAUNCH-2 rejects %s: no session, no link, no provider call',
    async (_name, make, code) => {
      const w = await world();
      await expect(w.exchange(make(w))).rejects.toMatchObject({ code });
      await untouched(w.k, w.a.tenant.id);
      await untouched(w.k, w.b.tenant.id);
    },
  );

  // Mutation: remove the jti single-use check (backlog MIO-044 named mutation).
  it('INV-LAUNCH-3 a replayed token is LAUNCH_TOKEN_REPLAYED and creates nothing new', async () => {
    const { k, a, sign, exchange } = await world();
    const token = sign();
    const first = await exchange(token);
    await expect(exchange(token)).rejects.toMatchObject({ code: 'LAUNCH_TOKEN_REPLAYED' });
    expect(await k.players.links(a.tenant.id)).toHaveLength(1);
    expect(first.user_id).toBeDefined();
  });

  // Mutation: record the jti before verifying the signature.
  it('INV-LAUNCH-4 a forged token cannot burn a nonce: the genuine token with the same jti still works', async () => {
    const { sign, exchange } = await world();
    await expect(
      exchange(sign({ secret: 'x'.repeat(40), jti: 'nonce-shared-1' })),
    ).rejects.toMatchObject({ code: 'LAUNCH_TOKEN_INVALID' });
    await expect(exchange(sign({ jti: 'nonce-shared-1' }))).resolves.toBeDefined();
  });

  // Mutation: make the jti check read-then-write without a unique constraint.
  it('INV-LAUNCH-5 five concurrent exchanges of one token: exactly one succeeds', async () => {
    const { sign, exchange } = await world();
    const token = sign();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => exchange(token)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'LAUNCH_TOKEN_REPLAYED' });
    }
  });

  // Mutation: take the tenant from a claim in the token (backlog MIO-044 named mutation).
  it('INV-LAUNCH-6 the tenant comes from the verifying key, never from a claim in the token', async () => {
    const { k, a, b, sign, exchange } = await world();
    const res = await exchange(
      sign({ extra: { tid: b.tenant.id, tenant_id: b.tenant.id, tenant: b.tenant.id } }),
    );
    expect(res.tenant_id).toBe(a.tenant.id);
    expect((await k.verify(res.access_token, 'engagement')).tid).toBe(a.tenant.id);
    expect(await k.players.links(b.tenant.id)).toEqual([]);
  });

  // Mutation: skip the tenant status check in LaunchService.
  it("INV-LAUNCH-7 a suspended tenant's launch token is TENANT_SUSPENDED and creates nothing", async () => {
    const { k, a, sign, exchange } = await world();
    await k.tenants.setStatus(a.tenant.id, 'suspended');
    await expect(exchange(sign())).rejects.toMatchObject({ code: 'TENANT_SUSPENDED' });
    await untouched(k, a.tenant.id);
  });

  // Mutation: the player's session roles include anything but `player`.
  // Reviewer amendment (D-22, coordinator): one single-use exchange gives ONE player session valid
  // for every audience the player needs (closes G-8). Mutation: the session carries only the
  // requested audience, or the verifiers compare `aud` as a single string.
  it('INV-LAUNCH-8 D-22 one launch yields one player session whose aud array covers engagement, payments and realtime; roles are exactly [player]', async () => {
    const { k, sign, exchange } = await world();
    for (const requested of ['engagement', 'web'] as const) {
      const res = await exchange(sign(), requested);
      const payload = decodePayload(res.access_token) as { aud: unknown; roles: unknown };
      expect(payload.roles).toEqual(['player']);
      expect(Array.isArray(payload.aud)).toBe(true);
      expect(payload.aud).toEqual(expect.arrayContaining(['engagement', 'payments', 'realtime']));
      for (const audience of ['engagement', 'payments', 'realtime']) {
        await expect(k.verify(res.access_token, audience)).resolves.toMatchObject({
          sub: res.user_id,
          roles: ['player'],
        });
      }
    }
  });

  // Mutation: verify with HS256 secret derived from the token's own header.
  it('INV-LAUNCH-9 a token signed with a secret chosen by the attacker is rejected even if the header says alg=HS256', async () => {
    const { keyA, exchange, k } = await world();
    const forged = signJwt({
      alg: 'HS256',
      key: 'attacker-chosen-secret',
      kid: keyA.key_id,
      claims: {
        pid: 'ext-1',
        plat: 'sim-casino',
        aud: 'mio-launch',
        iat: k.now(),
        exp: k.now() + 60,
        jti: 'nonce-attacker-1',
      },
    });
    await expect(exchange(forged)).rejects.toMatchObject({ code: 'LAUNCH_TOKEN_INVALID' });
  });

  // F6. Mutation: LaunchService looks the key up without the status filter (a revoked or
  // grace-expired key still verifies launches, although CredentialsService refuses it for webhooks).
  it('INV-LAUNCH-10 a revoked key launches nothing; a retiring key launches until its grace ends', async () => {
    const { k, a, keyA, sign, exchange } = await world();
    const admin = k.subjectOf(
      await k.verify(
        (
          await k.sessions.login(a.tenant.id, {
            email: 'boss@a.test',
            password: PW,
            audience: 'identity',
          })
        ).access_token,
        'identity',
      ),
    );
    // grace 0: the old key is revoked at once
    const next = await k.credentials.rotate(admin, keyA.key_id, { graceSeconds: 0 });
    await expect(exchange(sign())).rejects.toMatchObject({ code: 'LAUNCH_TOKEN_INVALID' });
    await untouched(k, a.tenant.id);
    await expect(
      exchange(sign({ keyId: next.key_id, secret: next.hmac_secret })),
    ).resolves.toBeDefined();

    // grace 3600: the old key (now `next`) still launches, then stops
    const graceful = await k.credentials.rotate(admin, next.key_id, { graceSeconds: 3600 });
    await expect(
      exchange(sign({ keyId: next.key_id, secret: next.hmac_secret, externalPlayerId: 'ext-2' })),
    ).resolves.toBeDefined();
    await expect(
      exchange(
        sign({ keyId: graceful.key_id, secret: graceful.hmac_secret, externalPlayerId: 'ext-3' }),
      ),
    ).resolves.toBeDefined();
    k.advance(3601);
    await expect(
      exchange(sign({ keyId: next.key_id, secret: next.hmac_secret, externalPlayerId: 'ext-4' })),
    ).rejects.toMatchObject({ code: 'LAUNCH_TOKEN_INVALID' });
    expect((await k.players.links(a.tenant.id)).map((l) => l.external_player_id).sort()).toEqual([
      'ext-1',
      'ext-2',
      'ext-3',
    ]);
  });

  // F7. The platform comes from the key (credentials are per tenant AND platform), like the
  // tenant does. Mutation: take `platform` from the `plat` claim of the token.
  it("INV-LAUNCH-11 a token whose plat claim disagrees with its key's platform is LAUNCH_TOKEN_INVALID and links nothing", async () => {
    const { k, a, sign, exchange } = await world();
    await expect(exchange(sign({ platform: 'other-casino' }))).rejects.toMatchObject({
      code: 'LAUNCH_TOKEN_INVALID',
    });
    await untouched(k, a.tenant.id);
    const ok = await exchange(sign({ platform: 'sim-casino' }));
    expect(await k.players.links(a.tenant.id)).toEqual([
      { user_id: ok.user_id, platform: 'sim-casino', external_player_id: 'ext-1' },
    ]);
  });

  // F7, second half. Mutation: same, with a second key for another platform in the same tenant.
  it('INV-LAUNCH-11 each platform key links only under its own platform, in the same tenant', async () => {
    const { k, a, exchange } = await world();
    const other = await k.credentials.issue(a.tenant.id, 'other-casino');
    const viaOther = await exchange(
      signLaunchToken({
        keyId: other.key_id,
        secret: other.hmac_secret,
        now: k.now(),
        externalPlayerId: 'ext-1',
        platform: 'other-casino',
      }),
    );
    await expect(
      exchange(
        signLaunchToken({
          keyId: other.key_id,
          secret: other.hmac_secret,
          now: k.now(),
          externalPlayerId: 'ext-2',
          platform: 'sim-casino',
        }),
      ),
    ).rejects.toMatchObject({ code: 'LAUNCH_TOKEN_INVALID' });
    expect(await k.players.links(a.tenant.id)).toEqual([
      { user_id: viaOther.user_id, platform: 'other-casino', external_player_id: 'ext-1' },
    ]);
  });
});

describe('INV-PLAYER: (tenant, platform, external_player_id) -> exactly one player user', () => {
  // Mutation: drop tenant (or platform) from the lookup key.
  it('INV-PLAYER-1 same external id: same triple = same user; other tenant = other user; other platform = other user', async () => {
    const { k, a, b } = await world();
    const one = await k.players.resolveOrCreate(a.tenant.id, 'sim-casino', 'ext-1');
    const again = await k.players.resolveOrCreate(a.tenant.id, 'sim-casino', 'ext-1');
    const otherTenant = await k.players.resolveOrCreate(b.tenant.id, 'sim-casino', 'ext-1');
    const otherPlatform = await k.players.resolveOrCreate(a.tenant.id, 'other-casino', 'ext-1');
    expect(again).toEqual({ user_id: one.user_id, created: false });
    expect(one.created).toBe(true);
    expect(new Set([one.user_id, otherTenant.user_id, otherPlatform.user_id]).size).toBe(3);
  });

  // Mutation: check-then-insert without the UNIQUE constraint / lock (backlog MIO-044).
  it('INV-PLAYER-2 20 concurrent first resolutions create exactly one link and one user', async () => {
    const { k, a } = await world();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        k.players.resolveOrCreate(a.tenant.id, 'sim-casino', 'ext-9'),
      ),
    );
    expect(new Set(results.map((r) => r.user_id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await k.players.links(a.tenant.id)).toHaveLength(1);
  });

  // Mutation: launch creates its own mapping instead of calling resolveOrCreate.
  it('INV-PLAYER-3 a deposit before the first launch maps to the same user the launch later resolves', async () => {
    const { k, a, sign, exchange } = await world();
    const deposit = await k.players.resolveOrCreate(a.tenant.id, 'sim-casino', 'ext-1');
    const launch = await exchange(sign({ externalPlayerId: 'ext-1' }));
    expect(launch.user_id).toBe(deposit.user_id);
    expect(await k.players.links(a.tenant.id)).toHaveLength(1);
  });

  // Mutation: lookup returns the link row unfiltered, or describes the wrong external id.
  it("INV-PLAYER-4 reader: the operator's lookup shows our id and the external id; another tenant's operator gets NOT_FOUND", async () => {
    const { k, a, b } = await world();
    const { user_id } = await k.players.resolveOrCreate(a.tenant.id, 'sim-casino', 'ext-77');
    const adminA = k.subjectOf(
      await k.verify(
        (
          await k.sessions.login(a.tenant.id, {
            email: 'boss@a.test',
            password: PW,
            audience: 'identity',
          })
        ).access_token,
        'identity',
      ),
    );
    const adminB = k.subjectOf(
      await k.verify(
        (
          await k.sessions.login(b.tenant.id, {
            email: 'boss@b.test',
            password: PW,
            audience: 'identity',
          })
        ).access_token,
        'identity',
      ),
    );
    await expect(k.players.lookup(adminA, user_id)).resolves.toEqual({
      user_id,
      platform: 'sim-casino',
      external_player_id: 'ext-77',
    });
    await expect(k.players.lookup(adminB, user_id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // Mutation: let a player look up another player (same tenant).
  it('INV-PLAYER-5 a player cannot look up another player of the same tenant (NOT_FOUND)', async () => {
    const { k, a, sign, exchange } = await world();
    const p1 = await exchange(sign({ externalPlayerId: 'ext-1' }));
    const p2 = await exchange(sign({ externalPlayerId: 'ext-2' }));
    const subject1 = k.subjectOf(await k.verify(p1.access_token, 'engagement'));
    await expect(k.players.lookup(subject1, p2.user_id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(a.tenant.id).toBe(subject1.tenantId);
  });

  // Mutation: accept an empty or oversized external id in resolveOrCreate.
  it('INV-PLAYER-6 an empty or oversized external player id is VALIDATION_FAILED and creates nothing', async () => {
    const { k, a } = await world();
    for (const id of ['', ' ', 'p'.repeat(129)]) {
      await expect(k.players.resolveOrCreate(a.tenant.id, 'sim-casino', id)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    expect(await k.players.links(a.tenant.id)).toEqual([]);
  });
});
