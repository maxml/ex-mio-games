import 'reflect-metadata';
import { Controller, Get, Module, Post, UseGuards } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ACTIONS, PLATFORM_TENANT_ID } from '@ex-mio/contracts';
import { ServiceAuthModule } from '@ex-mio/service-kit';
import { accessClaims, generateRsaKey, signJwt } from '@ex-mio/service-kit/testing';
import { Public } from '@ex-mio/tenancy';
import { CreditsService } from './services/credits.service';
import { paymentsControllers } from './controllers'; // RED: module does not exist yet
import {
  ActingCoinGuard,
  COIN_ACTION_KEY,
  CoinAction,
  NO_COIN_EFFECT_KEY,
  NoCoinEffect,
} from './controllers/coin-action'; // RED

/*
 * Choke point (coordinator decision D-5, review finding F3): payments refuses any coin
 * operation when the caller's token carries `acting_tenant`. Coin commands run here, not
 * in identity, so the ban is tested here: ActingCoinGuard reads the `acting` claim from
 * the service-kit auth context (set by ServiceAuthModule) and denies the pinned coin
 * actions with 403 ACTING_FORBIDDEN before the handler runs. Only `coins.adjust` may be
 * called while acting; an unrelated read has no coin effect and is allowed.
 *
 * These tests only pin the shared service-kit entry point and payments' guard. They do
 * not boot the database or the bus.
 */

const NOW = 1_800_000_000;
const T_A = '0190a1b2-c3d4-7e5f-8a6b-0000000000aa';
const T_B = '0190a1b2-c3d4-7e5f-8a6b-0000000000bb';
const USER = '0190a1b2-c3d4-7e5f-8a6b-000000000001';
const PLAYER = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';
const key = generateRsaKey('k1');

// Pinned as a literal on purpose: a loop over COIN_VALUE_ACTIONS would shrink with the list.
const COIN_VALUE = ['coins.credit', 'coins.hold', 'coins.capture', 'coins.release', 'coins.refund'];

const credit = jest.fn();

// Controller-level guard: it always runs AFTER the global ServiceAuthModule guard, so the auth
// context is set when it reads `acting`. Order cannot depend on how modules are registered.
@UseGuards(ActingCoinGuard)
@Controller('probe')
class Probe {
  @CoinAction('coins.credit') @Post('credit') credit() {
    return { ran: 'coins.credit' };
  }
  @CoinAction('coins.hold') @Post('hold') hold() {
    return { ran: 'coins.hold' };
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
      jwks: async () => ({ keys: [key.publicJwk] }),
      tenantStatus: async () => 'active',
      nowSeconds: () => NOW,
    }),
  ],
  controllers: [Probe, ...paymentsControllers],
  providers: [{ provide: CreditsService, useValue: { credit, list: jest.fn(async () => []) } }],
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
    'INV-ACTBAN-1 an acting token on %s is 403 ACTING_FORBIDDEN and the handler does not run',
    async (action) => {
      const res = await call('POST', `/probe/${action.split('.')[1]}`, acting());
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'ACTING_FORBIDDEN' });
      expect(res.body).not.toContain('"ran"');
    },
  );

  // Mutation: the guard denies everything for everyone (over-blocks), or ignores the action list.
  it.each(COIN_VALUE)(
    'INV-ACTBAN-2 the same route with an ordinary operator token runs (%s)',
    async (action) => {
      const res = await call('POST', `/probe/${action.split('.')[1]}`, token());
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ ran: action });
    },
  );

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
    const forged = await call('POST', '/probe/credit', token(), { 'x-acting-tenant': T_B });
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
    for (const ctrl of paymentsControllers) {
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

  // Mutation: declare the credit route NoCoinEffect (the ban never fires for it).
  it('the credit route is declared coins.credit and the list route is NoCoinEffect', () => {
    const proto = paymentsControllers[0]?.prototype as Record<string, object>;
    expect(Reflect.getMetadata(COIN_ACTION_KEY, proto['create'] as object)).toBe('coins.credit');
    expect(Reflect.getMetadata(NO_COIN_EFFECT_KEY, proto['list'] as object)).toBe(true);
  });

  it('an acting token on the real POST /v1/credits is 403 ACTING_FORBIDDEN and CreditsService is not called', async () => {
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/credits',
        headers: { authorization: `Bearer ${acting()}`, 'idempotency-key': 'key-12345678' },
        payload: { player_id: PLAYER, amount: 5 },
      });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ACTING_FORBIDDEN' });
    expect(credit).not.toHaveBeenCalled();
  });
});
