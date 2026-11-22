import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redemption } from '@ex-mio/contracts';
import { StoreRejection, type RedemptionRecord } from '../redemptions/ports';
import { RedemptionsController } from './redemptions.controller';
import { StoreItemsController } from './store-items.controller';
import { RedemptionsService } from '../services/redemptions.service';
import { StoreItemsService } from '../services/store-items.service';
import {
  actingToken,
  auditEvents,
  authModule,
  bearer,
  operatorToken,
  playerToken,
} from '../testing/auth.fixture';

/*
 * HTTP layer of the store and the redemption API (spec §5). Services are mocked: these tests
 * pin what the controller itself must guarantee (validation before the service, role checks,
 * the caller's identity taken from the VERIFIED TOKEN and never from the URL, body or a header,
 * error mapping, the player/operator view of a redemption). Roles are identity's vocabulary
 * (X-15): player, operator_admin, operator_staff. There are no `x-principal-*`, `x-sandbox` or
 * `x-tenant-id` headers anywhere (X-9, D-12): the entry point is the real ServiceAuthModule with
 * fixture keys. Missing modules were the red state when the tests were written.
 */

const TENANT = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const ITEM = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';
const RID = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2d';
// Player ids are UUIDs: the payments service validates `player_id` as one.
const P1 = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f0001';
const P2 = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f0002';
const OP = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f00a1';

type Role = 'player' | 'operator_admin' | 'operator_staff';
/** Headers of a verified token for `role` (the player is P1, an operator is OP). */
const as = (role: Role, extra: Record<string, string> = {}) => ({
  ...bearer(
    role === 'player'
      ? playerToken(TENANT, P1)
      : operatorToken(TENANT, OP, role === 'operator_admin' ? 'operator_admin' : 'operator_staff'),
  ),
  ...extra,
});

const record = (over: Partial<RedemptionRecord> = {}): RedemptionRecord => ({
  id: RID,
  tenantId: TENANT,
  playerId: P1,
  sandbox: false,
  itemId: ITEM,
  itemVersion: 1,
  price: 10,
  reward: { type: 'free_spins', params: {} },
  operationKey: 'k',
  state: 'REQUESTED',
  attempts: 0,
  nextAttemptAt: null,
  unknownSince: null,
  casinoReference: null,
  failureReason: null,
  rewardRequest: null,
  firstIssuingAt: null,
  reservation: 'reserved',
  history: [{ from: null, to: 'REQUESTED', cause: 'order_placed', at: new Date() }],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe('store HTTP layer', () => {
  let app: NestFastifyApplication;
  const redemptions = {
    redeem: jest.fn(),
    getOwn: jest.fn(),
    listOwn: jest.fn(),
    getForOperator: jest.fn(),
    listForOperator: jest.fn(),
    resolveReview: jest.fn(),
  };
  const items = { create: jest.fn(), update: jest.fn(), listActive: jest.fn(), listAll: jest.fn() };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [authModule()], // the one entry point (D-4); tokens come from service-kit/testing
      controllers: [RedemptionsController, StoreItemsController],
      providers: [
        { provide: RedemptionsService, useValue: redemptions },
        { provide: StoreItemsService, useValue: items },
      ],
    }).compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(() => app.close());

  const req = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) => app.inject({ method, url, headers, payload: payload as never });

  const newItem = {
    name: 'Spins',
    price: 10,
    reward: { type: 'free_spins', params: { count: 10 } },
  };

  // ---- catalog -------------------------------------------------------------------------------
  // Mutation: remove the role check on item creation -> the staff/player cases go red.
  it('I-API-1 only operator_admin creates or edits items; operator_staff and player get 403 before the service', async () => {
    for (const role of ['operator_staff', 'player'] as const)
      expect((await req('POST', '/v1/store/items', as(role), newItem)).statusCode).toBe(403);
    expect(
      (await req('PATCH', `/v1/store/items/${ITEM}`, as('operator_staff'), { name: 'x' }))
        .statusCode,
    ).toBe(403);
    expect(items.create).not.toHaveBeenCalled();
    expect(items.update).not.toHaveBeenCalled();
    items.create.mockResolvedValueOnce({ id: ITEM });
    expect((await req('POST', '/v1/store/items', as('operator_admin'), newItem)).statusCode).toBe(
      201,
    );
  });

  // Mutation: accept price <= 0 or non-integer in the controller.
  it('I-API-2 a non-positive or non-integer price is 422 item_price_invalid; a wrong type is 400', async () => {
    for (const price of [0, -5, 1.5]) {
      const res = await req('POST', '/v1/store/items', as('operator_admin'), {
        ...newItem,
        price,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('item_price_invalid');
    }
    expect(
      (await req('POST', '/v1/store/items', as('operator_admin'), { ...newItem, price: 'ten' }))
        .statusCode,
    ).toBe(400);
    expect(items.create).not.toHaveBeenCalled();
  });

  // Mutation: list through listAll for players.
  it('I-API-3 players list active items only', async () => {
    items.listActive.mockResolvedValueOnce([]);
    expect((await req('GET', '/v1/store/items', as('player'))).statusCode).toBe(200);
    expect(items.listActive).toHaveBeenCalledTimes(1);
    expect(items.listAll).not.toHaveBeenCalled();
  });

  // ---- redemptions -----------------------------------------------------------------------------
  const key = { 'idempotency-key': 'key-12345678' };

  it('I-API-4 POST /v1/redemptions needs a token, an Idempotency-Key and a valid body, before the service', async () => {
    expect((await req('POST', '/v1/redemptions', key, { item_id: ITEM })).statusCode).toBe(401);
    expect((await req('POST', '/v1/redemptions', as('player'), { item_id: ITEM })).statusCode).toBe(
      400,
    );
    expect(
      (await req('POST', '/v1/redemptions', { ...as('player'), ...key }, { item_id: 'x' }))
        .statusCode,
    ).toBe(400);
    // a token for another service is not a token for engagement
    const other = bearer(playerToken(TENANT, P1, { aud: 'payments' }));
    expect(
      (await req('POST', '/v1/redemptions', { ...other, ...key }, { item_id: ITEM })).statusCode,
    ).toBe(401);
    expect(redemptions.redeem).not.toHaveBeenCalled();
  });

  // X-3/X-9, D-13. Mutation: read sandbox/price/player from the body or a header (`x-sandbox`,
  // `x-principal-id`, `x-tenant-id`), or ignore the `sbx` claim. The scope is the verified token.
  it('I-API-5 identity and sandbox come from the verified token only: a body or header carrying them is refused or ignored', async () => {
    const h = { ...as('player'), ...key };
    for (const extra of [{ sandbox: true }, { sandbox: false }, { price: 1 }, { player_id: 'p2' }])
      expect(
        (await req('POST', '/v1/redemptions', h, { item_id: ITEM, ...extra })).statusCode,
      ).toBe(400);
    expect(redemptions.redeem).not.toHaveBeenCalled();
    redemptions.redeem.mockResolvedValue({ redemption: record(), created: true });
    // headers that used to be the placeholder: ignored, the token decides (production player here)
    const forged = {
      ...h,
      'x-sandbox': '1',
      'x-principal-id': P2,
      'x-tenant-id': '0190a1b2-c3d4-7e5f-8a6b-00000000ffff',
    };
    const res = await req('POST', '/v1/redemptions', forged, { item_id: ITEM });
    expect(res.statusCode).toBe(202);
    expect(redemptions.redeem).toHaveBeenLastCalledWith(
      { tenantId: TENANT, playerId: P1, sandbox: false },
      'key-12345678',
      ITEM,
    );
    // a player launched through a sandbox credential carries `sbx: true`
    const sbx = { ...bearer(playerToken(TENANT, P1, { sbx: true })), ...key };
    expect((await req('POST', '/v1/redemptions', sbx, { item_id: ITEM })).statusCode).toBe(202);
    expect(redemptions.redeem).toHaveBeenLastCalledWith(
      { tenantId: TENANT, playerId: P1, sandbox: true },
      'key-12345678',
      ITEM,
    );
  });

  it('I-API-6 only a player redeems; a replay says so', async () => {
    expect(
      (await req('POST', '/v1/redemptions', { ...as('operator_admin'), ...key }, { item_id: ITEM }))
        .statusCode,
    ).toBe(403);
    redemptions.redeem.mockResolvedValue({ redemption: record(), created: false });
    const res = await req(
      'POST',
      '/v1/redemptions',
      { ...as('player'), ...key },
      { item_id: ITEM },
    );
    expect(res.statusCode).toBe(202);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(Redemption.safeParse(res.json()).success).toBe(true);
  });

  // Mutation: let StoreRejection escape as a 500, or change a status in the table.
  it.each([
    ['out_of_stock', 409],
    ['limit_reached', 409],
    ['item_inactive', 409],
    ['item_not_found', 404],
    ['idempotency_key_reused', 422],
  ] as const)('I-API-7 %s maps to HTTP %i with a stable code', async (code, status) => {
    redemptions.redeem.mockRejectedValueOnce(new StoreRejection(code));
    const res = await req(
      'POST',
      '/v1/redemptions',
      { ...as('player'), ...key },
      { item_id: ITEM },
    );
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
  });

  // D-8 / F9: the coin reserve is synchronous, so the player is told at once. Mutation: answer 202
  // and park the reason on GET, map insufficient_funds to a 500, or leave it out of the error table.
  it('I-API-8 insufficient funds -> the POST answers 409 insufficient_funds, with a message and no redemption body', async () => {
    redemptions.redeem.mockRejectedValueOnce(new StoreRejection('insufficient_funds'));
    const res = await req(
      'POST',
      '/v1/redemptions',
      { ...as('player'), ...key },
      { item_id: ITEM },
    );
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe('insufficient_funds');
    expect(typeof body.message).toBe('string');
    expect(body.id).toBeUndefined();
  });

  // Mutation: look the redemption up by id alone (drop the player scope) -> B reads A's.
  it("I-OWN-1 player B cannot read player A's redemption: the lookup is scoped by the token and answers 404", async () => {
    redemptions.getOwn.mockResolvedValueOnce(null);
    const res = await req('GET', `/v1/redemptions/${RID}`, bearer(playerToken(TENANT, P2)));
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('redemption_not_found');
    expect(redemptions.getOwn).toHaveBeenCalledWith(
      { tenantId: TENANT, playerId: P2, sandbox: false },
      RID,
    );
    expect((await req('GET', '/v1/redemptions/not-a-uuid', as('player'))).statusCode).toBe(400);
  });

  // W-5. The widget lists its own redemptions to poll them. Mutation: list by tenant (drop the
  // player scope), take the player from a query parameter, or answer another vocabulary than the
  // store's `PublicRedemptionStatus` (`pending|issuing|issued|failed_refunded`).
  it('W-5 GET /v1/me/redemptions lists the token player own redemptions, with the public status words', async () => {
    redemptions.listOwn.mockResolvedValueOnce([
      record({ state: 'COMPLETED' }),
      record({ id: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2e', state: 'RELEASED' }),
    ]);
    const res = await req('GET', `/v1/me/redemptions?player_id=${P2}`, as('player'));
    expect(res.statusCode).toBe(200);
    expect(res.json().map((r: { status: string }) => r.status)).toEqual([
      'issued',
      'failed_refunded',
    ]);
    expect(redemptions.listOwn).toHaveBeenCalledWith({
      tenantId: TENANT,
      playerId: P1,
      sandbox: false,
    });
    expect((await req('GET', '/v1/me/redemptions', as('operator_admin'))).statusCode).toBe(403);
  });

  // Mutation: show failure_reason of a NEEDS_REVIEW redemption to the player.
  it('I-VIEW-1 the player sees "pending" for NEEDS_REVIEW and no reason; the operator sees both', async () => {
    const r = record({ state: 'NEEDS_REVIEW', failureReason: 'attempts_exhausted', attempts: 8 });
    redemptions.getOwn.mockResolvedValueOnce(r);
    const player = (await req('GET', `/v1/redemptions/${RID}`, as('player'))).json();
    expect(player.status).toBe('pending');
    expect(player.state).toBe('NEEDS_REVIEW');
    expect(player.failure_reason).toBeNull();
    redemptions.listForOperator.mockResolvedValueOnce([r]);
    const op = await req(
      'GET',
      '/v1/operator/redemptions?status=NEEDS_REVIEW',
      as('operator_staff'),
    );
    expect(op.statusCode).toBe(200);
    expect(op.json()[0].failure_reason).toBe('attempts_exhausted');
    expect(redemptions.listForOperator).toHaveBeenCalledWith(TENANT, 'NEEDS_REVIEW');
  });

  it('I-VIEW-2 final states map to the four public words', async () => {
    const cases: [RedemptionRecord['state'], string][] = [
      ['ISSUING', 'issuing'],
      ['COMPLETED', 'issued'],
      ['RELEASED', 'failed_refunded'],
      ['REJECTED_FUNDS', 'failed_refunded'],
    ];
    for (const [state, pub] of cases) {
      redemptions.getOwn.mockResolvedValueOnce(record({ state }));
      expect((await req('GET', `/v1/redemptions/${RID}`, as('player'))).json().status).toBe(pub);
    }
  });

  // F9: the reader test. A mapper that hides every reason from players would pass I-VIEW-1/2.
  // Mutation: null the failure_reason for every state in the player view.
  it('I-VIEW-3 the player sees why a redemption failed for funds: failure_reason insufficient_funds on GET', async () => {
    redemptions.getOwn.mockResolvedValueOnce(
      record({ state: 'REJECTED_FUNDS', failureReason: 'insufficient_funds' }),
    );
    const body = (await req('GET', `/v1/redemptions/${RID}`, as('player'))).json();
    expect(body.status).toBe('failed_refunded');
    expect(body.failure_reason).toBe('insufficient_funds');
  });

  // F13: MIO-067 "operator: own tenant". Mutation: look it up by id alone, or open it to players.
  it('I-OPS-3 operator reads one redemption of ITS tenant, with the reason and history; players are refused; unknown id is 404', async () => {
    const r = record({ state: 'NEEDS_REVIEW', failureReason: 'attempts_exhausted' });
    redemptions.getForOperator.mockResolvedValueOnce(r);
    const res = await req('GET', `/v1/operator/redemptions/${RID}`, as('operator_staff'));
    expect(res.statusCode).toBe(200);
    expect(res.json().failure_reason).toBe('attempts_exhausted');
    expect(res.json().history).toHaveLength(1);
    expect(redemptions.getForOperator).toHaveBeenCalledWith(TENANT, RID);
    expect((await req('GET', `/v1/operator/redemptions/${RID}`, as('player'))).statusCode).toBe(
      403,
    );
    redemptions.getForOperator.mockResolvedValueOnce(null);
    const missing = await req('GET', `/v1/operator/redemptions/${RID}`, as('operator_admin'));
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('redemption_not_found');
    expect(
      (await req('GET', '/v1/operator/redemptions/not-a-uuid', as('operator_admin'))).statusCode,
    ).toBe(400);
  });

  it('I-OPS-1 operator list: players are refused, an unknown status filter is 400', async () => {
    expect((await req('GET', '/v1/operator/redemptions', as('player'))).statusCode).toBe(403);
    expect(
      (await req('GET', '/v1/operator/redemptions?status=BOGUS', as('operator_admin'))).statusCode,
    ).toBe(400);
  });

  // Mutation: drop the role check on resolve.
  it('I-OPS-2 resolving a review needs operator_admin and a reason; operator_staff is 403', async () => {
    const url = `/v1/operator/redemptions/${RID}/resolve`;
    const body = { outcome: 'issued', reason: 'verified in back office' };
    expect((await req('POST', url, as('operator_staff'), body)).statusCode).toBe(403);
    expect(
      (await req('POST', url, as('operator_admin'), { outcome: 'issued', reason: '' })).statusCode,
    ).toBe(400);
    expect(redemptions.resolveReview).not.toHaveBeenCalled();
    redemptions.resolveReview.mockResolvedValueOnce(record({ state: 'ISSUED' }));
    expect((await req('POST', url, as('operator_admin'), body)).statusCode).toBe(200);
    expect(redemptions.resolveReview).toHaveBeenCalledWith(TENANT, RID, body, {
      id: OP,
      role: 'operator_admin',
    });
  });

  // X-11, D-5, D-15 Q-2 (a). Resolving a review moves coins one hop away (not_issued releases,
  // issued captures), through engagement's own service token, which payments cannot tie to the
  // acting user. So the refusal sits HERE: a token carrying `act` is 403 ACTING_FORBIDDEN before the
  // service is called, and the refusal is audited (D-11). Mutation: drop the acting check on resolve,
  // or run it after the service call.
  it('I-OPS-5 an acting platform_admin token on resolve is 403 ACTING_FORBIDDEN: no service call, no coin call, one refused audit event', async () => {
    auditEvents.length = 0;
    redemptions.resolveReview.mockClear();
    const res = await req(
      'POST',
      `/v1/operator/redemptions/${RID}/resolve`,
      bearer(actingToken(TENANT, OP)),
      { outcome: 'not_issued', reason: 'acting must not move coins' },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ACTING_FORBIDDEN' });
    expect(redemptions.resolveReview).not.toHaveBeenCalled();
    const refused = auditEvents.filter((e) => e.type === 'audit.acting_request');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.payload).toMatchObject({
      service: 'engagement',
      route: 'POST /v1/operator/redemptions/:id/resolve',
      decision: 'refused',
    });
  });

  // D-2 gate: the saga refuses an unbacked not_issued; the API must say so, not answer 500.
  // Mutation: leave `release_not_allowed` or `illegal_transition` out of the controller's error table.
  it.each([
    ['release_not_allowed', 409],
    ['illegal_transition', 409],
    ['forbidden', 403],
  ] as const)('I-OPS-4 a saga refusal %s is HTTP %i with its code', async (code, status) => {
    redemptions.resolveReview.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    const res = await req('POST', `/v1/operator/redemptions/${RID}/resolve`, as('operator_admin'), {
      outcome: 'not_issued',
      reason: 'casino says no',
    });
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
  });
});
