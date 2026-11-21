import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redemption } from '@ex-mio/contracts';
import { TenancyModule } from '@ex-mio/tenancy';
import { StoreRejection, type RedemptionRecord } from '../redemptions/ports';
import { RedemptionsController } from './redemptions.controller';
import { StoreItemsController } from './store-items.controller';
import { RedemptionsService } from '../services/redemptions.service';
import { StoreItemsService } from '../services/store-items.service';

/*
 * HTTP layer of the store and the redemption API (spec §5). Services are mocked: these tests
 * pin what the controller itself must guarantee (validation before the service, role checks,
 * the caller's identity taken from context and never from the URL or body, error mapping,
 * the player/operator view of a redemption). Missing modules today = RED for the right reason.
 */

const TENANT = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const ITEM = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';
const RID = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2d';

const as = (role: string, extra: Record<string, string> = {}) => ({
  'x-tenant-id': TENANT,
  'x-principal-id': role === 'player' ? 'p1' : 'op-1',
  'x-principal-role': role,
  ...extra,
});

const record = (over: Partial<RedemptionRecord> = {}): RedemptionRecord => ({
  id: RID,
  tenantId: TENANT,
  playerId: 'p1',
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
    listForOperator: jest.fn(),
    resolveReview: jest.fn(),
  };
  const items = { create: jest.fn(), update: jest.fn(), listActive: jest.fn(), listAll: jest.fn() };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [TenancyModule.forRoot()],
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
  // Mutation: remove the role check on item creation -> the analyst/player cases go red.
  it('I-API-1 only owner and admin create or edit items; analyst and player get 403 before the service', async () => {
    for (const role of ['analyst', 'player'])
      expect((await req('POST', '/v1/store/items', as(role), newItem)).statusCode).toBe(403);
    expect(
      (await req('PATCH', `/v1/store/items/${ITEM}`, as('analyst'), { name: 'x' })).statusCode,
    ).toBe(403);
    expect(items.create).not.toHaveBeenCalled();
    expect(items.update).not.toHaveBeenCalled();
    items.create.mockResolvedValueOnce({ id: ITEM });
    expect((await req('POST', '/v1/store/items', as('admin'), newItem)).statusCode).toBe(201);
  });

  // Mutation: accept price <= 0 or non-integer in the controller.
  it('I-API-2 a non-positive or non-integer price is 422 item_price_invalid; a wrong type is 400', async () => {
    for (const price of [0, -5, 1.5]) {
      const res = await req('POST', '/v1/store/items', as('owner'), { ...newItem, price });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('item_price_invalid');
    }
    expect(
      (await req('POST', '/v1/store/items', as('owner'), { ...newItem, price: 'ten' })).statusCode,
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

  it('I-API-4 POST /v1/redemptions needs a tenant, an Idempotency-Key and a valid body, before the service', async () => {
    const { 'x-tenant-id': _t, ...noTenant } = { ...as('player'), ...key };
    expect((await req('POST', '/v1/redemptions', noTenant, { item_id: ITEM })).statusCode).toBe(
      401,
    );
    expect((await req('POST', '/v1/redemptions', as('player'), { item_id: ITEM })).statusCode).toBe(
      400,
    );
    expect(
      (await req('POST', '/v1/redemptions', { ...as('player'), ...key }, { item_id: 'x' }))
        .statusCode,
    ).toBe(400);
    expect(redemptions.redeem).not.toHaveBeenCalled();
  });

  // Mutation: read sandbox/price/player from the body; or take the scope from the URL.
  it('I-API-5 identity and sandbox come from context only: a body carrying them is refused', async () => {
    const h = { ...as('player'), ...key };
    for (const extra of [{ sandbox: true }, { sandbox: false }, { price: 1 }, { player_id: 'p2' }])
      expect(
        (await req('POST', '/v1/redemptions', h, { item_id: ITEM, ...extra })).statusCode,
      ).toBe(400);
    expect(redemptions.redeem).not.toHaveBeenCalled();
    redemptions.redeem.mockResolvedValue({ redemption: record(), created: true });
    const res = await req('POST', '/v1/redemptions', { ...h, 'x-sandbox': '1' }, { item_id: ITEM });
    expect(res.statusCode).toBe(202);
    expect(redemptions.redeem).toHaveBeenCalledWith(
      { tenantId: TENANT, playerId: 'p1', sandbox: true },
      'key-12345678',
      ITEM,
    );
  });

  it('I-API-6 only a player redeems; a replay says so', async () => {
    expect(
      (await req('POST', '/v1/redemptions', { ...as('admin'), ...key }, { item_id: ITEM }))
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

  // Mutation: look the redemption up by id alone (drop the player scope) -> B reads A's.
  it("I-OWN-1 player B cannot read player A's redemption: the lookup is scoped by the caller and answers 404", async () => {
    redemptions.getOwn.mockResolvedValueOnce(null);
    const res = await req('GET', `/v1/redemptions/${RID}`, {
      ...as('player'),
      'x-principal-id': 'p2',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('redemption_not_found');
    expect(redemptions.getOwn).toHaveBeenCalledWith(
      { tenantId: TENANT, playerId: 'p2', sandbox: false },
      RID,
    );
    expect((await req('GET', '/v1/redemptions/not-a-uuid', as('player'))).statusCode).toBe(400);
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
    const op = await req('GET', '/v1/operator/redemptions?status=NEEDS_REVIEW', as('analyst'));
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

  it('I-OPS-1 operator list: players are refused, an unknown status filter is 400', async () => {
    expect((await req('GET', '/v1/operator/redemptions', as('player'))).statusCode).toBe(403);
    expect(
      (await req('GET', '/v1/operator/redemptions?status=BOGUS', as('admin'))).statusCode,
    ).toBe(400);
  });

  // Mutation: drop the role check on resolve.
  it('I-OPS-2 resolving a review needs owner/admin and a reason; the analyst is 403', async () => {
    const url = `/v1/operator/redemptions/${RID}/resolve`;
    const body = { outcome: 'issued', reason: 'verified in back office' };
    expect((await req('POST', url, as('analyst'), body)).statusCode).toBe(403);
    expect(
      (await req('POST', url, as('admin'), { outcome: 'issued', reason: '' })).statusCode,
    ).toBe(400);
    expect(redemptions.resolveReview).not.toHaveBeenCalled();
    redemptions.resolveReview.mockResolvedValueOnce(record({ state: 'ISSUED' }));
    expect((await req('POST', url, as('admin'), body)).statusCode).toBe(200);
    expect(redemptions.resolveReview).toHaveBeenCalledWith(TENANT, RID, body, {
      id: 'op-1',
      role: 'admin',
    });
  });
});
