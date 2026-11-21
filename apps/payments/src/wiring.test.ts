import 'reflect-metadata';
import type { DynamicModule } from '@nestjs/common';
import { SERVICE_AUTH_OPTIONS, ServiceAuthModule } from '@ex-mio/service-kit';
import * as tenancy from '@ex-mio/tenancy';
import { createAppModule } from './app.module';
import { paymentsControllers } from './controllers'; // RED: module does not exist yet
import { ActingCoinGuard } from './controllers/coin-action'; // RED: module does not exist yet
import type { Config } from './config';
import { coinRuleViolations, collectControllers } from './testing/controller-walk';

/*
 * Choke point (review finding F2): the wiring every service passes through. The unit tests of
 * the verifier cannot see how payments builds its own app, so this pins it: payments gets its
 * tenant ONLY from the shared service-kit entry point, for audience `payments`, reading keys and
 * tenant status from identity, and serves only controllers guarded by the acting-coin guard (D-5).
 *
 * Mutation: restore `TenancyModule.forRoot(...)` (or any resolver) in app.module.ts, change the
 * audience, hard-code the JWKS, or serve a controller that is not in `paymentsControllers`.
 */

const config = {
  PORT: 4003,
  AMQP_URL: 'amqp://u:p@bus.test:5672',
  IDENTITY_URL: 'http://identity.test:4001',
  NODE_ENV: 'test',
} as unknown as Config;

const isDynamic = (m: unknown): m is DynamicModule =>
  typeof m === 'object' && m !== null && 'module' in m;

describe('INV-WIRE payments', () => {
  const mod = createAppModule(config);
  const authModules = (mod.imports ?? []).filter(
    (m): m is DynamicModule => isDynamic(m) && m.module === ServiceAuthModule,
  );

  it('INV-WIRE-1 imports ServiceAuthModule exactly once, for audience payments, reading identity', () => {
    expect(authModules).toHaveLength(1);
    const opts = authModules[0]?.providers?.find(
      (p) =>
        typeof p === 'object' && p !== null && 'provide' in p && p.provide === SERVICE_AUTH_OPTIONS,
    ) as { useValue: Record<string, unknown> } | undefined;
    expect(opts?.useValue).toMatchObject({
      audience: 'payments',
      identityUrl: 'http://identity.test:4001',
    });
    expect(Object.keys(opts?.useValue ?? {})).not.toEqual(expect.arrayContaining(['resolver']));
  });

  it('INV-WIRE-2 does not import any tenancy module of its own', () => {
    expect('TenancyModule' in tenancy).toBe(false);
    const all = JSON.stringify(
      (mod.imports ?? []).map((m) =>
        isDynamic(m) ? m.module.name : (m as { name?: string }).name,
      ),
    );
    expect(all).not.toMatch(/Tenancy/);
  });

  it('INV-WIRE-3 serves exactly the guarded payments controllers (so the acting-coin guard covers every route)', () => {
    expect(mod.controllers).toEqual(paymentsControllers);
    for (const ctrl of paymentsControllers) {
      expect(Reflect.getMetadata('__guards__', ctrl)).toContain(ActingCoinGuard);
    }
  });

  // D-14 / N3: the check above only sees the top-level list. This walks the whole module tree, so a
  // controller added in an imported child module (the escape found in review) fails here too.
  // Mutation: add an unguarded controller to a module imported by createAppModule.
  it('INV-WIRE-3 every controller reachable from the app module tree, child modules included, is guarded and declared', () => {
    const all = collectControllers(mod);
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.map((c) => c.name)).toEqual(
      expect.arrayContaining(paymentsControllers.map((c) => c.name)),
    );
    expect(coinRuleViolations(mod)).toEqual([]);
  });

  // D-11 item 7. The production wiring passes no audit port of its own: the default is the
  // service's outbox (INV-STACK-8 proves the events arrive). A no-op port, or a test-only
  // override of the allow-list or key source, in the production options would silently unaudit
  // or unprotect the service.
  // Mutation: pass `auditPort: async () => undefined` or `serviceCalls: {...}` in app.module.ts.
  it('INV-WIRE-4 the entry point is wired with the default outbox audit and the contract allow-list, no overrides', () => {
    const opts = authModules[0]?.providers?.find(
      (p) =>
        typeof p === 'object' && p !== null && 'provide' in p && p.provide === SERVICE_AUTH_OPTIONS,
    ) as { useValue: Record<string, unknown> } | undefined;
    const keys = Object.keys(opts?.useValue ?? {});
    expect(keys).toEqual(expect.arrayContaining(['audience', 'identityUrl']));
    for (const forbidden of ['auditPort', 'serviceCalls', 'jwks', 'tenantStatus']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
