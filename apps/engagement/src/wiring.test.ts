import 'reflect-metadata';
import type { DynamicModule } from '@nestjs/common';
import { SERVICE_AUTH_OPTIONS, ServiceAuthModule } from '@ex-mio/service-kit';
import * as tenancy from '@ex-mio/tenancy';
import { createAppModule } from './app.module';
import type { Config } from './config';

/*
 * Choke point (review finding F2): the wiring every service passes through. Engagement gets its
 * tenant ONLY from the shared service-kit entry point, for audience `engagement`, reading keys
 * and tenant status from identity. The player-facing tokens it serves are verified there.
 *
 * Mutation: restore `TenancyModule.forRoot(...)` (or any resolver) in app.module.ts, change the
 * audience, or hard-code the JWKS instead of reading it from identity.
 */

const config = {
  PORT: 4002,
  AMQP_URL: 'amqp://u:p@bus.test:5672',
  IDENTITY_URL: 'http://identity.test:4001',
  NODE_ENV: 'test',
} as unknown as Config;

const isDynamic = (m: unknown): m is DynamicModule =>
  typeof m === 'object' && m !== null && 'module' in m;

describe('INV-WIRE engagement', () => {
  const mod = createAppModule(config);
  const authModules = (mod.imports ?? []).filter(
    (m): m is DynamicModule => isDynamic(m) && m.module === ServiceAuthModule,
  );

  it('INV-WIRE-1 imports ServiceAuthModule exactly once, for audience engagement, reading identity', () => {
    expect(authModules).toHaveLength(1);
    const opts = authModules[0]?.providers?.find(
      (p) =>
        typeof p === 'object' && p !== null && 'provide' in p && p.provide === SERVICE_AUTH_OPTIONS,
    ) as { useValue: Record<string, unknown> } | undefined;
    expect(opts?.useValue).toMatchObject({
      audience: 'engagement',
      identityUrl: 'http://identity.test:4001',
    });
    expect(Object.keys(opts?.useValue ?? {})).not.toEqual(expect.arrayContaining(['resolver']));
  });

  // D-11 item 7 / D-14. Same rule as payments: no audit port, allow-list or key source of its own.
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

  it('INV-WIRE-2 does not import any tenancy module of its own', () => {
    expect('TenancyModule' in tenancy).toBe(false);
    const all = JSON.stringify(
      (mod.imports ?? []).map((m) =>
        isDynamic(m) ? m.module.name : (m as { name?: string }).name,
      ),
    );
    expect(all).not.toMatch(/Tenancy/);
  });
});
