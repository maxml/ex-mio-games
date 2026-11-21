import { signWebhook } from '@ex-mio/service-kit/testing';
import { buildKernel } from './testing/kernel'; // RED: module does not exist yet

/*
 * Choke point: CredentialsService (services/credentials.service.ts): per-tenant
 * API key + HMAC secret. The tenant of a casino webhook is the tenant of the key
 * that signed it. Backlog: MIO-031 (webhooks), MIO-044 (key per tenant).
 */

const PW = 'correct horse battery';
const body = JSON.stringify({ player: 'ext-1', amount: 10 });

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
  const asAdmin = async (tenantId: string, email: string) =>
    k.subjectOf(
      await k.verify(
        (await k.sessions.login(tenantId, { email, password: PW, audience: 'identity' }))
          .access_token,
        'identity',
      ),
    );
  const verify = (
    over: {
      apiKey?: string;
      secret?: string;
      ts?: number;
      body?: string;
      signedBody?: string;
    } = {},
  ) => {
    const ts = over.ts ?? k.now();
    return k.credentials.verifyWebhook({
      apiKey: over.apiKey ?? keyA.api_key,
      timestamp: ts,
      signature: signWebhook(
        over.secret ?? keyA.hmac_secret,
        ts,
        over.signedBody ?? over.body ?? body,
      ),
      rawBody: over.body ?? body,
    });
  };
  return { k, a, b, keyA, keyB, asAdmin, verify };
}

describe('INV-CRED: integration credentials are per tenant, secret at rest, rotatable', () => {
  // Mutation: accept a webhook whose key is valid but whose tenant is read from the body.
  it('INV-CRED-1 a signed webhook resolves to the tenant of its key (no tenant input exists)', async () => {
    const { a, keyA, verify } = await world();
    await expect(verify()).resolves.toEqual({ tenant_id: a.tenant.id, key_id: keyA.key_id });
  });

  // Mutation: compare signatures with === on strings, or skip the compare for a known key.
  it("INV-CRED-2 bad signature, other tenant's secret, unknown key, tampered body, skewed timestamp: all WEBHOOK_SIGNATURE_INVALID with one message", async () => {
    const { k, keyB, verify } = await world();
    const attempts = [
      verify({ secret: 'wrong-secret-wrong-secret-wrong' }),
      verify({ secret: keyB.hmac_secret }),
      verify({ apiKey: 'mio_live_does_not_exist' }),
      verify({ signedBody: '{"player":"ext-1","amount":1}' }), // signed one body, sent another
      verify({ ts: k.now() - 301 }),
      verify({ ts: k.now() + 301 }),
    ];
    const errors = await Promise.all(
      attempts.map((p) =>
        p.then(
          () => undefined,
          (e: unknown) => e,
        ),
      ),
    );
    for (const e of errors) expect(e).toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    expect(new Set(errors.map((e) => (e as Error).message)).size).toBe(1);
  });

  // Mutation: return the secret from list().
  it('INV-CRED-3 reading credentials never returns the api key or the secret again; only the issue call does', async () => {
    const { k, a, keyA, asAdmin } = await world();
    const listed = await k.credentials.list(await asAdmin(a.tenant.id, 'boss@a.test'));
    expect(listed).toEqual([
      expect.objectContaining({ key_id: keyA.key_id, platform: 'sim-casino', status: 'active' }),
    ]);
    const text = JSON.stringify(listed);
    expect(text).not.toContain(keyA.hmac_secret);
    expect(text).not.toContain(keyA.api_key);
  });

  // Mutation: store the api key or secret in plaintext.
  it('INV-CRED-4 at rest neither the api key nor the secret is stored as issued', async () => {
    const { k, a, keyA } = await world();
    const stored = JSON.stringify(await k.credentials.storedRowsForTest(a.tenant.id));
    expect(stored).not.toContain(keyA.api_key);
    expect(stored).not.toContain(keyA.hmac_secret);
    expect(stored).toContain(keyA.key_id);
  });

  // Mutation: rotate keeps the old key active forever (or revokes before issuing the new one).
  it('INV-CRED-5 rotation: the new key works; the old key stops at once, or after the grace period when one is asked for', async () => {
    const { k, a, keyA, asAdmin, verify } = await world();
    const admin = await asAdmin(a.tenant.id, 'boss@a.test');
    const next = await k.credentials.rotate(admin, keyA.key_id, { graceSeconds: 0 });
    expect(next.key_id).not.toBe(keyA.key_id);
    await expect(verify()).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    await expect(verify({ apiKey: next.api_key, secret: next.hmac_secret })).resolves.toMatchObject(
      { tenant_id: a.tenant.id, key_id: next.key_id },
    );

    const graceful = await k.credentials.rotate(admin, next.key_id, { graceSeconds: 3600 });
    await expect(verify({ apiKey: next.api_key, secret: next.hmac_secret })).resolves.toBeDefined();
    await expect(
      verify({ apiKey: graceful.api_key, secret: graceful.hmac_secret }),
    ).resolves.toBeDefined();
    k.advance(3601);
    await expect(verify({ apiKey: next.api_key, secret: next.hmac_secret })).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });
  });

  // Mutation: skip access.authorize in rotate / look the key up without the tenant filter.
  it("INV-CRED-6 only operator_admin of the owning tenant rotates; staff is FORBIDDEN; another tenant's key id is NOT_FOUND", async () => {
    const { k, a, b, keyA, keyB, asAdmin } = await world();
    const adminA = await asAdmin(a.tenant.id, 'boss@a.test');
    await k.staff.invite(adminA, { email: 'staff@a.test', password: PW, role: 'operator_staff' });
    const staffA = await asAdmin(a.tenant.id, 'staff@a.test');
    await expect(
      k.credentials.rotate(staffA, keyA.key_id, { graceSeconds: 0 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      k.credentials.rotate(adminA, keyB.key_id, { graceSeconds: 0 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (await k.credentials.list(await asAdmin(b.tenant.id, 'boss@b.test'))).map((c) => c.status),
    ).toEqual(['active']);
  });
});
