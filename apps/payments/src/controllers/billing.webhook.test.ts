import 'reflect-metadata';
import { buildApp, type BuiltApp } from '../testing/app';

// Choke point: the billing webhook endpoint of the REAL application module with the REAL
// `BillingService` and the fake provider; only the database is a stub that fails on any use.
// So a request that must be refused provably never reaches the database (MIO-150-01, MIO-150-10),
// and one that passes verification is not answered 200 when processing fails (MIO-150-07).
// Spec: docs/specs/payments.md, section 9.

const BODY = JSON.stringify({
  eventId: 'evt_1',
  tenantId: '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b',
  subscriptionId: 'sub_1',
  status: 'active',
  version: 1,
  amountMinor: 4900,
  currency: 'USD',
  periodStart: '2026-11-01T00:00:00.000Z',
  periodEnd: '2026-12-01T00:00:00.000Z',
});

const post = (b: BuiltApp, signature: string | undefined, payload = BODY) =>
  b.app.inject({
    method: 'POST',
    url: '/v1/billing/webhooks',
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? {} : { 'x-webhook-signature': signature }),
    },
    payload,
  });

describe('INV-W3 a webhook is verified before anything else, in every environment', () => {
  let b: BuiltApp;
  beforeAll(async () => {
    b = await buildApp();
  });
  afterAll(() => b.app.close());

  // Mutation: parse or apply before verifying, or compare the signature in a way that lets a
  // wrong-length value through.
  it.each([
    ['no signature', undefined],
    ['an empty signature', ''],
    ['a wrong signature', 'deadbeef'],
    ['a signature of another body', 'a'.repeat(64)],
  ])(
    '%s: 401 invalid_signature and the database is never touched (MIO-150-01)',
    async (_n, sig) => {
      const res = await post(b, sig);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'invalid_signature' });
      expect(b.dbTouched).not.toHaveBeenCalled();
    },
  );

  it('a body changed after signing is refused', async () => {
    const res = await post(b, b.provider.sign(BODY), BODY.replace('"version":1', '"version":9'));
    expect(res.statusCode).toBe(401);
    expect(b.dbTouched).not.toHaveBeenCalled();
  });

  // Mutation: let a verified request whose processing failed answer 200 (the provider would never retry).
  it('a correctly signed request that fails while processing is a 500, not a 200 (MIO-150-07)', async () => {
    const res = await post(b, b.provider.sign(BODY));
    expect(b.dbTouched).toHaveBeenCalled(); // it passed verification and went on to the database
    expect(res.statusCode).toBe(500);
  });

  // Mutation: skip verification when an env flag or the environment says so (MIO-150-10).
  describe.each(['development', 'test', 'production'])(
    'NODE_ENV=%s with every bypass flag set',
    (nodeEnv) => {
      const flags = {
        SKIP_WEBHOOK_VERIFICATION: 'true',
        WEBHOOK_VERIFY: 'false',
        DISABLE_SIGNATURE_CHECK: '1',
        VERIFY_WEBHOOKS: '0',
        DEBUG: '*',
      };
      const saved: Record<string, string | undefined> = {};
      let flagged: BuiltApp;
      beforeAll(async () => {
        for (const [k, v] of Object.entries(flags)) {
          saved[k] = process.env[k];
          process.env[k] = v;
        }
        flagged = await buildApp({}, { NODE_ENV: nodeEnv, ...flags });
      });
      afterAll(async () => {
        await flagged.app.close();
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      });

      it('an unsigned request is still 401 and reaches no database', async () => {
        const res = await post(flagged, undefined);
        expect(res.statusCode).toBe(401);
        expect(flagged.dbTouched).not.toHaveBeenCalled();
      });
    },
  );
});
