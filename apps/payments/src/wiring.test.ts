import 'reflect-metadata';
import type { DynamicModule } from '@nestjs/common';
import { SERVICE_AUTH_OPTIONS, ServiceAuthModule } from '@ex-mio/service-kit';
import * as tenancy from '@ex-mio/tenancy';
import { createAppModule } from './app.module';
import { paymentsControllers } from './controllers'; // RED: module does not exist yet
import { ActingCoinGuard } from './controllers/coin-action'; // RED: module does not exist yet
import type { Config } from './config';

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
});
