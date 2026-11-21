import { INTEGRATION_ENVIRONMENTS, TenantIntegration } from '@ex-mio/contracts';
import { buildKernel } from './testing/kernel'; // RED: module does not exist yet

/*
 * Choke point: CredentialsService (services/credentials.service.ts): per-tenant API key + webhook
 * secret + player hash key, each integration either `production` or `sandbox`. D-15 Q-1: webhooks
 * carry the casino's own signature, verified by engagement; identity only HOLDS the secrets and
 * serves them to `svc:engagement` (`integration(tenantId)`, `integrationBySlug(slug)`). The MIO
 * `x-mio-*` scheme and `verifyWebhook` are gone. Backlog: MIO-031, MIO-044.
 */

const PW = 'correct horse battery';

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
  return { k, a, b, keyA, keyB, asAdmin };
}

describe('INV-CRED: integration credentials are per tenant, secret at rest, rotatable', () => {
  // X-7. Mutation: read the tenant from a caller input, or return another tenant's secrets.
  it("INV-CRED-1 the integration of a tenant is that tenant's own, in the TenantIntegration contract shape", async () => {
    const { k, a, b, keyA, keyB } = await world();
    const ia = await k.credentials.integration(a.tenant.id);
    expect(TenantIntegration.parse(ia)).toMatchObject({
      tenant_id: a.tenant.id,
      platform: 'sim-casino',
      status: 'active',
      environment: 'production',
    });
    expect(ia.webhook_secrets).toEqual([keyA.hmac_secret]);
    expect(ia.webhook_secrets).not.toContain(keyB.hmac_secret);
    expect((await k.credentials.integration(b.tenant.id)).webhook_secrets).toEqual([
      keyB.hmac_secret,
    ]);
    expect((await k.credentials.integrationBySlug('a'))?.tenant_id).toBe(a.tenant.id);
    expect(await k.credentials.integrationBySlug('no-such-slug')).toBeUndefined();
  });

  // X-3. Mutation: derive the environment from the platform name or a caller flag.
  it('INV-CRED-2 a credential is issued for exactly one environment; a launch through a sandbox key mints sbx, a production key mints none', async () => {
    const { k, a } = await world();
    expect([...INTEGRATION_ENVIRONMENTS]).toEqual(['production', 'sandbox']);
    const sbx = await k.credentials.issue(a.tenant.id, 'sim-casino', { environment: 'sandbox' });
    expect(await k.credentials.environmentOfKey(sbx.key_id)).toBe('sandbox');
    const player = await k.sessions.launchWithKey(sbx, { externalPlayerId: 'ext-1' });
    expect((await k.verify(player.access_token, 'engagement')).sbx).toBe(true);
    const prod = await k.credentials.issue(a.tenant.id, 'sim-casino-prod');
    const playerP = await k.sessions.launchWithKey(prod, { externalPlayerId: 'ext-2' });
    expect((await k.verify(playerP.access_token, 'engagement')).sbx).toBeUndefined();
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

  // Mutation: store the api key or secret in plaintext. The secret must stay recoverable for the
  // integration read, so it is stored ENCRYPTED, never as issued.
  it('INV-CRED-4 at rest neither the api key nor the secret is stored as issued', async () => {
    const { k, a, keyA } = await world();
    const stored = JSON.stringify(await k.credentials.storedRowsForTest(a.tenant.id));
    expect(stored).not.toContain(keyA.api_key);
    expect(stored).not.toContain(keyA.hmac_secret);
    expect(stored).toContain(keyA.key_id);
  });

  // Mutation: rotate keeps the old secret served forever (or drops it before the new one is served).
  it('INV-CRED-5 rotation: the integration serves the new secret; the old one stops at once, or after the grace period', async () => {
    const { k, a, keyA, asAdmin } = await world();
    const admin = await asAdmin(a.tenant.id, 'boss@a.test');
    const next = await k.credentials.rotate(admin, keyA.key_id, { graceSeconds: 0 });
    expect(next.key_id).not.toBe(keyA.key_id);
    expect((await k.credentials.integration(a.tenant.id)).webhook_secrets).toEqual([
      next.hmac_secret,
    ]);

    const graceful = await k.credentials.rotate(admin, next.key_id, { graceSeconds: 3600 });
    expect((await k.credentials.integration(a.tenant.id)).webhook_secrets).toEqual([
      graceful.hmac_secret,
      next.hmac_secret,
    ]);
    k.advance(3601);
    expect((await k.credentials.integration(a.tenant.id)).webhook_secrets).toEqual([
      graceful.hmac_secret,
    ]);
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
