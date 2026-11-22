import 'reflect-metadata';
import { Controller, Get, Module, Post, UseGuards } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  ACTIONS,
  ActingRequestAuditedV1,
  type EventEnvelope,
  PLATFORM_TENANT_ID,
  type ServiceCallPolicy,
} from '@ex-mio/contracts';
import { ServiceAuthModule } from '@ex-mio/service-kit';
import { accessClaims, generateRsaKey, serviceClaims, signJwt } from '@ex-mio/service-kit/testing';
import { Public } from '@ex-mio/tenancy';
import { createAppModule } from './app.module';
import type { Config } from './config';
import { paymentsControllers } from './controllers';
import { coinRuleViolations, collectControllers } from './testing/controller-walk';
import {
  ActingCoinGuard,
  COIN_ACTION_KEY,
  CoinAction,
  NO_COIN_EFFECT_KEY,
  NoCoinEffect,
} from './controllers/coin-action';

/*
 * Choke point (coordinator decision D-5, review finding F3): payments refuses any coin
 * operation when the caller's token carries `acting_tenant`. Coin commands run here, not
 * in identity, so the ban is tested here: ActingCoinGuard reads the `acting` claim from
 * the service-kit auth context (set by ServiceAuthModule) and denies the pinned coin
 * actions with 403 `acting_forbidden` (payments' own code, X-10) before the handler runs. Only `coins.adjust` may be
 * called while acting; an unrelated read has no coin effect and is allowed.
 *
 * These tests only pin the shared service-kit entry point and payments' guard. They do
 * not boot the database or the bus.
 */

const NOW = 1_800_000_000;
const T_A = '0190a1b2-c3d4-7e5f-8a6b-0000000000aa';
const T_B = '0190a1b2-c3d4-7e5f-8a6b-0000000000bb';
const USER = '0190a1b2-c3d4-7e5f-8a6b-000000000001';
const key = generateRsaKey('k1');

// Pinned as a literal on purpose: a loop over COIN_VALUE_ACTIONS would shrink with the list.
const COIN_VALUE = [
  'coins.credit',
  'coins.reserve',
  'coins.capture',
  'coins.release',
  'coins.refund',
];

const audited: EventEnvelope[] = [];
const appConfig = {
  PORT: 4003,
  AMQP_URL: 'amqp://u:p@bus.test:5672',
  IDENTITY_URL: 'http://identity.test:4001',
  NODE_ENV: 'test',
} as unknown as Config;

// D-14: engagement reaches payments only through these (test) internal routes; the callee checks it.
const POLICY: ServiceCallPolicy = {
  identity: {},
  engagement: {
    payments: [
      'POST /internal/v1/tenants/:tenantId/probe/reserve',
      'POST /internal/v1/tenants/:tenantId/probe/capture',
      'POST /internal/v1/tenants/:tenantId/probe/release',
      'POST /internal/v1/tenants/:tenantId/probe/refund',
    ],
  },
  payments: {},
};

/** Value actions a SERVICE (engagement, over an internal route) legitimately runs; none is credit. */
@UseGuards(ActingCoinGuard)
@Controller('internal/v1/tenants/:tenantId/probe')
class InternalProbe {
  @CoinAction('coins.reserve') @Post('reserve') reserve() {
    return { ran: 'coins.reserve' };
  }
  @CoinAction('coins.capture') @Post('capture') capture() {
    return { ran: 'coins.capture' };
  }
  @CoinAction('coins.release') @Post('release') release() {
    return { ran: 'coins.release' };
  }
  @CoinAction('coins.refund') @Post('refund') refund() {
    return { ran: 'coins.refund' };
  }
}

// Controller-level guard: it always runs AFTER the global ServiceAuthModule guard, so the auth
// context is set when it reads `acting`. Order cannot depend on how modules are registered.
@UseGuards(ActingCoinGuard)
@Controller('probe')
class Probe {
  @CoinAction('coins.credit') @Post('credit') credit() {
    return { ran: 'coins.credit' };
  }
  @CoinAction('coins.reserve') @Post('reserve') reserve() {
    return { ran: 'coins.reserve' };
  }
  @CoinAction('coins.capture') @Post('capture') capture() {
    return { ran: 'coins.capture' };
  }
  @CoinAction('coins.release') @Post('release') release() {
    return { ran: 'coins.release' };
  }
  @CoinAction('coins.refund') @Post('refund') refund() {
    return { ran: 'coins.refund' };
  }
  @CoinAction('coins.adjust') @Post('adjust') adjust() {
    return { ran: 'coins.adjust' };
  }
  @NoCoinEffect() @Get('read') read() {
    return { ran: 'read' };
  }
  @Public() @Get('open') open() {
    return { ran: 'open' };
  }
  @Get('undeclared') undeclared() {
    return { ran: 'LEAK' };
  }
}

@Module({
  imports: [
    ServiceAuthModule.forService({
      audience: 'payments',
      serviceCalls: POLICY,
      auditPort: async (event: EventEnvelope) => {
        audited.push(event);
      },
      jwks: async () => ({ keys: [key.publicJwk] }),
      tenantStatus: async () => 'active',
      nowSeconds: () => NOW,
    }),
  ],
  // The real controllers are NOT booted here (they need the ledger, balance and billing services, which
  // this probe app does not provide, so Nest would abort on dependency resolution). Their wiring is
  // pinned below by the module-tree scan (INV-ACTBAN-7/8) and in wiring.test.ts.
  controllers: [Probe, InternalProbe],
})
class TestApp {}

let app: NestFastifyApplication;
beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(TestApp, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(() => app.close());

const token = (over: Partial<Parameters<typeof accessClaims>[0]> = {}) =>
  signJwt({
    alg: 'RS256',
    key: key.privateKey,
    kid: 'k1',
    claims: accessClaims({ now: NOW, sub: USER, tid: T_A, aud: 'payments', ttl: 900, ...over }),
  });
const acting = () =>
  token({
    tid: PLATFORM_TENANT_ID,
    roles: ['platform_admin'],
    act: { tenant_id: T_A, reason: 'ticket 42' },
  });
const call = (
  method: 'GET' | 'POST',
  url: string,
  t?: string,
  extra: Record<string, string> = {},
) =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url,
      headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...extra },
    });

describe('INV-ACTBAN: payments refuses coin operations to an acting token', () => {
  // Mutation: ActingCoinGuard does not read `acting` from the auth context (or is not registered).
  it.each(COIN_VALUE)(
    'INV-ACTBAN-1 an acting token on %s is 403 acting_forbidden and the handler does not run',
    async (action) => {
      const res = await call('POST', `/probe/${action.split('.')[1]}`, acting());
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'acting_forbidden' }); // X-10: payments' own lower-case code
      expect(res.body).not.toContain('"ran"');
    },
  );

  // D-14 / N4 (replaces the old test that pinned an operator minting coins): the legitimate caller of
  // a value action is a SERVICE (engagement: reserve, capture, release, refund) over an internal
  // route, which carries no acting claim. The guard must not over-block it.
  // Mutation: the guard denies everything for everyone (over-blocks), or ignores the action list.
  it.each(['coins.reserve', 'coins.capture', 'coins.release', 'coins.refund'])(
    'INV-ACTBAN-2 an engagement service token on the internal route of %s runs, with no acting claim',
    async (action) => {
      const svc = signJwt({
        alg: 'RS256',
        key: key.privateKey,
        kid: 'k1',
        claims: serviceClaims({ now: NOW, service: 'engagement', aud: 'payments' }),
      });
      const res = await call(
        'POST',
        `/internal/v1/tenants/${T_A}/probe/${action.split('.')[1]}`,
        svc,
      );
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ ran: action });
    },
  );

  // D-14 / N4, D-1 (inverts the old INV-ACTBAN-2 that expected 201 for an operator on /v1/credits).
  // Operators can never mint coins (RBAC matrix: coins.credit is "no" for every role, D-1: credits
  // come from the inbox only), so the real app has NO credit route at all. Mutation: serve a credit
  // route again, for any token.
  it('INV-ACTBAN-2 an ordinary operator_admin token on POST /v1/credits is 404: the real app has no credit route', async () => {
    for (const url of ['/v1/credits', `/internal/v1/tenants/${T_A}/credits`]) {
      const res = await call('POST', url, token(), { 'idempotency-key': 'key-12345678' });
      expect([url, res.statusCode]).toEqual([url, 404]);
    }
  });

  // D-11 item 3: refused by a LATER guard (ActingCoinGuard), so an interceptor-only audit misses it.
  // Mutation: emit the audit event from an interceptor only (interceptors do not run when a guard refuses).
  it('INV-AUTH-9 an acting coin-value request refused by the guard writes exactly one refused event for service payments', async () => {
    audited.length = 0;
    const res = await call('POST', '/probe/credit', acting(), {
      'idempotency-key': 'key-12345678',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'acting_forbidden' });
    const events = audited.filter((e) => e.type === 'audit.acting_request');
    expect(events).toHaveLength(1);
    expect(ActingRequestAuditedV1.parse(events[0]?.payload)).toMatchObject({
      service: 'payments',
      route: 'POST /probe/credit',
      decision: 'refused',
      status: 403,
    });
    expect(events[0]?.tenant_id).toBe(T_A);
  });

  // Mutation: add coins.adjust to the banned list (the audited exception stops working).
  it('INV-ACTBAN-3 coins.adjust is the one coin action an acting token may call', async () => {
    const res = await call('POST', '/probe/adjust', acting());
    expect(res.statusCode).toBe(201);
  });

  // Mutation: ban every route for acting tokens, including reads with no coin effect.
  it('INV-ACTBAN-4 an acting token may call a read route declared NoCoinEffect', async () => {
    expect((await call('GET', '/probe/read', acting())).statusCode).toBe(200);
  });

  // Mutation: allow a handler that declares neither a coin action nor NoCoinEffect, or let a request
  // through when the auth context is missing (the guard must fail closed, not open).
  it('INV-ACTBAN-5 a payments route that declares nothing is denied by default (403), for everyone', async () => {
    expect((await call('GET', '/probe/undeclared', token())).statusCode).toBe(403);
    expect((await call('GET', '/probe/undeclared', acting())).statusCode).toBe(403);
  });

  // Mutation: read the acting tenant from a header or the body instead of the verified claim.
  it('INV-ACTBAN-6 a header or body that merely says "acting" changes nothing; the claim decides', async () => {
    const svc = signJwt({
      alg: 'RS256',
      key: key.privateKey,
      kid: 'k1',
      claims: serviceClaims({ now: NOW, service: 'engagement', aud: 'payments' }),
    });
    const forged = await call('POST', `/internal/v1/tenants/${T_A}/probe/reserve`, svc, {
      'x-acting-tenant': T_B,
    });
    expect(forged.statusCode).toBe(201);
    const tampered = acting().split('.');
    tampered[1] = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(tampered[1] ?? '', 'base64url').toString()),
        act: undefined,
      }),
    ).toString('base64url');
    expect((await call('POST', '/probe/credit', tampered.join('.'))).statusCode).toBe(401); // stripping act breaks the signature
  });
});

describe('INV-ACTBAN-7 every payments handler declares its coin effect', () => {
  const methodsOf = (ctrl: new (...a: never[]) => unknown) =>
    Object.getOwnPropertyNames(ctrl.prototype)
      .filter((n) => n !== 'constructor')
      .map((n) => ({
        name: n,
        handler: ctrl.prototype[n as keyof typeof ctrl.prototype] as unknown as object,
      }))
      .filter(
        ({ handler }) => typeof handler === 'function' && Reflect.hasMetadata('path', handler),
      );

  // Mutation: add a payments route without @CoinAction / @NoCoinEffect / @Public.
  it('every route of every payments controller declares a known action, NoCoinEffect or Public', () => {
    const undeclared: string[] = [];
    const unknown: string[] = [];
    let seen = 0;
    // D-14 / N3: every controller of the app module TREE, child modules included.
    for (const ctrl of collectControllers(createAppModule(appConfig))) {
      for (const { name, handler } of methodsOf(ctrl)) {
        seen++;
        const action = Reflect.getMetadata(COIN_ACTION_KEY, handler);
        const noEffect = Reflect.getMetadata(NO_COIN_EFFECT_KEY, handler) === true;
        const isPublic = Reflect.getMetadata('ex-mio:public', handler) === true;
        if (action === undefined && !noEffect && !isPublic) undeclared.push(`${ctrl.name}.${name}`);
        if (action !== undefined && !(ACTIONS as readonly string[]).includes(action))
          unknown.push(`${ctrl.name}.${name}`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(undeclared).toEqual([]);
    expect(unknown).toEqual([]);
  });

  // Mutation: a payments controller without @UseGuards(ActingCoinGuard) (its routes escape the ban).
  it('every payments controller is guarded by ActingCoinGuard', () => {
    for (const ctrl of paymentsControllers) {
      expect(Reflect.getMetadata('__guards__', ctrl)).toContain(ActingCoinGuard);
    }
  });

  // D-14 / N3, the route scan: the booted-app shape, not a list. Walks every module reachable from
  // createAppModule (imports, dynamic modules) and asserts the guard and a declaration on every
  // registered coin route. Mutation: register an unguarded controller in an imported child module.
  it('INV-ACTBAN-8 the route scan of the real app module finds the coins controller, no credits controller and no violation', () => {
    const controllers = collectControllers(createAppModule(appConfig));
    expect(controllers.map((c) => c.name)).toContain('CoinsController');
    expect(controllers.map((c) => c.name)).not.toContain('CreditsController');
    expect(coinRuleViolations(createAppModule(appConfig))).toEqual([]);
  });

  // The scan must be able to see a controller in a child module (the mutation that escaped the list check).
  it('INV-ACTBAN-8 the scan itself catches an unguarded controller and an undeclared route in an imported child module', () => {
    @Controller('v1/reserves')
    class EscapedReserves {
      @Post('hold') hold() {
        return { ran: 'LEAK' };
      }
    }
    @Module({ controllers: [EscapedReserves] })
    class EscapedReservesModule {}
    @Module({ imports: [EscapedReservesModule] })
    class Parent {}
    const root = { module: Parent, imports: [EscapedReservesModule] };
    expect(collectControllers(root).map((c) => c.name)).toEqual(['EscapedReserves']);
    expect(coinRuleViolations(root)).toEqual([
      'EscapedReserves: no ActingCoinGuard',
      'EscapedReserves.hold: undeclared',
    ]);
  });

  // D-1: no handler of the real app is a credit, and every coin command it serves declares exactly
  // one of the four service actions. Mutation: re-add a handler declared coins.credit, or declare a
  // coin command NoCoinEffect (the ban never fires for it).
  it('no real handler is declared coins.credit; the coin commands are reserve, capture, release, refund', () => {
    const declared: string[] = [];
    for (const ctrl of collectControllers(createAppModule(appConfig))) {
      for (const { handler } of methodsOf(ctrl)) {
        const action = Reflect.getMetadata(COIN_ACTION_KEY, handler);
        if (action !== undefined) declared.push(action);
      }
    }
    expect(declared.sort()).toEqual(
      ['coins.capture', 'coins.refund', 'coins.release', 'coins.reserve'].sort(),
    );
  });
});

describe('INV-ACTBAN-9 the guard fails closed when the entry point is missing (N5)', () => {
  // Mutation: ActingCoinGuard returns true when there is no auth context.
  it('a controller guarded by ActingCoinGuard in an app WITHOUT ServiceAuthModule answers 401 on a coin route', async () => {
    const ran = jest.fn();
    @UseGuards(ActingCoinGuard)
    @Controller('bare')
    class Bare {
      @CoinAction('coins.credit') @Post('credit') credit() {
        ran();
        return { ran: 'LEAK' };
      }
      @NoCoinEffect() @Get('read') read() {
        ran();
        return { ran: 'LEAK' };
      }
    }
    @Module({ controllers: [Bare] })
    class BareApp {}
    const bare = await NestFactory.create<NestFastifyApplication>(BareApp, new FastifyAdapter(), {
      logger: false,
    });
    await bare.init();
    await bare.getHttpAdapter().getInstance().ready();
    try {
      for (const [method, url] of [
        ['POST', '/bare/credit'],
        ['GET', '/bare/read'],
      ] as const) {
        const res = await bare.getHttpAdapter().getInstance().inject({ method, url });
        expect([url, res.statusCode]).toEqual([url, 401]);
      }
      expect(ran).not.toHaveBeenCalled();
    } finally {
      await bare.close();
    }
  });
});
