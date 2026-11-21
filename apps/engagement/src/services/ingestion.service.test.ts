import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { EventEnvelope } from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { createDefaultRegistry } from '../integrations/registry';
import {
  ADAPTER_REGISTRY,
  CLOCK,
  InboundEventsRepository,
  PLAYER_DIRECTORY,
  TENANT_INTEGRATIONS,
  type InboundEventRow,
  type TenantIntegration,
} from '../integrations/ports';
import { IngestionService } from './ingestion.service';

/**
 * L3 Stage B fix round (review F1, F3, F6). IngestionService is driven directly (no HTTP, no auth
 * module) with the real adapters and fake ports.
 *
 * Mutations (each turns the named tests red):
 *  - put `external_player_id` (or the raw id anywhere) into the deposit.confirmed payload
 *    -> INV-ING-NO-RAW-ID-EVENT (F1).
 *  - resolve the player inside the tenant transaction, or not at all -> INV-ING-PLAYER-RESOLVED-FIRST.
 *  - swallow a directory failure and write the row anyway -> INV-ING-DIRECTORY-DOWN.
 *  - omit `sandbox` on the envelope, or read it from a header / the body -> INV-ING-SANDBOX (F3, D-13).
 *  - drop the empty-secret refusal in verify() / the adapters -> INV-ING-EMPTY-SECRET (F6).
 */

const NOW = new Date('2026-11-21T12:00:00.000Z');
const T1 = '0190a1b2-c3d4-4e5f-8a6b-000000000001';
const T2 = '0190a1b2-c3d4-4e5f-8a6b-000000000002';
const INTERNAL = '0190a1b2-c3d4-4e5f-8a6b-0000000000a1';
const RAW = 'casino-raw-player-77';
const hmac = (secret: string, msg: string) =>
  createHmac('sha256', secret).update(msg).digest('hex');

function signedA(secret: string, player = RAW) {
  const ts = Math.floor(NOW.getTime() / 1000);
  const raw = JSON.stringify({
    eventId: 'evt-1',
    playerId: player,
    amount: { value: 5000, currency: 'EUR' },
    status: 'SUCCESS',
    ts,
  });
  return {
    raw,
    headers: { 'x-a-timestamp': String(ts), 'x-a-signature': hmac(secret, `${ts}.${raw}`) },
  };
}
/** Casino B signs an injective encoding of its fields (F4): a JSON array, never a dotted string. */
function signedB(secret: string, player = RAW) {
  const data = { txn_id: 'evt-1', customer_ref: player, amount_cents: 5000, ccy: 'EUR' };
  const sent_at = NOW.toISOString();
  const type = 'payment.completed';
  const signature = hmac(
    secret,
    JSON.stringify([sent_at, type, data.txn_id, data.customer_ref, data.amount_cents, data.ccy]),
  );
  return { raw: JSON.stringify({ type, data, sent_at, signature }), headers: {} };
}

const integration = (over: Record<string, unknown>): TenantIntegration =>
  ({
    tenant_id: T1,
    casino: 'casino-a',
    status: 'active',
    webhook_secrets: ['sec'],
    player_hash_key: 'hk',
    environment: 'production',
    ...over,
  }) as unknown as TenantIntegration;

describe('IngestionService (fix round)', () => {
  let integrations: Record<string, TenantIntegration>;
  let rows: InboundEventRow[];
  let published: EventEnvelope[];
  let order: string[];
  let directoryDown: boolean;
  const resolveOrCreate = jest.fn();
  let service: IngestionService;

  beforeEach(async () => {
    rows = [];
    published = [];
    order = [];
    directoryDown = false;
    resolveOrCreate.mockReset();
    resolveOrCreate.mockImplementation(async () => {
      order.push('resolve');
      if (directoryDown) throw new Error('identity unavailable');
      return INTERNAL;
    });
    integrations = {
      acme: integration({ webhook_secrets: ['sec-acme'] }),
      bravo: integration({ tenant_id: T2, casino: 'casino-b', webhook_secrets: ['sec-bravo'] }),
    };
    const inbound = {
      async insertIfAbsent(_tx: unknown, row: InboundEventRow) {
        order.push('insert');
        rows.push(row);
        return { inserted: true, id: '0190a1b2-c3d4-4e5f-8a6b-00000000000a' };
      },
    };
    const db = {
      async tenantTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        order.push('tx');
        const before = rows.length;
        const pub = published.length;
        try {
          return await fn({});
        } catch (err) {
          rows.length = before;
          published.length = pub;
          throw err;
        }
      },
      async publish(_tx: unknown, event: EventEnvelope) {
        published.push(event);
      },
    };
    const mod = await Test.createTestingModule({
      providers: [
        IngestionService,
        { provide: Db, useValue: db },
        { provide: InboundEventsRepository, useValue: inbound },
        {
          provide: TENANT_INTEGRATIONS,
          useValue: { lookup: async (s: string) => integrations[s] },
        },
        { provide: ADAPTER_REGISTRY, useValue: createDefaultRegistry() },
        { provide: CLOCK, useValue: { now: () => NOW } },
        { provide: PLAYER_DIRECTORY, useValue: { resolveOrCreate } },
      ],
    }).compile();
    service = mod.get(IngestionService);
  });

  const cases = [
    ['acme', 'sec-acme', signedA],
    ['bravo', 'sec-bravo', signedB],
  ] as const;

  describe.each(cases)('%s', (slug, secret, sign) => {
    it('INV-ING-NO-RAW-ID-EVENT: the outbox payload carries the internal player_id and no trace of the raw casino id (D-12, F1)', async () => {
      await service.ingest(
        slug,
        ...(Object.values(sign(secret)) as [string, Record<string, string>]),
      );
      expect(published).toHaveLength(1);
      const payload = published[0]!.payload as Record<string, unknown>;
      expect(payload.player_id).toBe(INTERNAL);
      expect(payload).not.toHaveProperty('external_player_id');
      // the grep: what the outbox row will hold, whole envelope, serialised
      expect(JSON.stringify(published[0])).not.toContain(RAW);
    });

    it('INV-ING-PLAYER-RESOLVED-FIRST: the player is resolved through identity before the tenant transaction opens', async () => {
      await service.ingest(
        slug,
        ...(Object.values(sign(secret)) as [string, Record<string, string>]),
      );
      expect(resolveOrCreate).toHaveBeenCalledTimes(1);
      expect(resolveOrCreate).toHaveBeenCalledWith(
        integrations[slug]!.tenant_id,
        expect.any(String),
        RAW,
      );
      expect(order.indexOf('resolve')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('resolve')).toBeLessThan(order.indexOf('tx'));
    });

    it('INV-ING-DIRECTORY-DOWN: identity down is 503 and nothing is written (the casino retries)', async () => {
      directoryDown = true;
      const err = await service
        .ingest(slug, ...(Object.values(sign(secret)) as [string, Record<string, string>]))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(503);
      expect(rows).toHaveLength(0);
      expect(published).toHaveLength(0);
    });

    it('INV-ING-SANDBOX: the envelope sandbox flag comes from the credential environment, never from the request (F3, D-13)', async () => {
      const sandboxOf = (e: EventEnvelope) => (e as { sandbox?: boolean }).sandbox;
      integrations[slug] = integration({ ...integrations[slug], environment: 'sandbox' });
      await service.ingest(
        slug,
        ...(Object.values(sign(secret)) as [string, Record<string, string>]),
      );
      expect(sandboxOf(published[0]!)).toBe(true);

      published.length = 0;
      // production credential: a client-supplied hint must not turn the flag on
      integrations[slug] = integration({ ...integrations[slug], environment: 'production' });
      const built = sign(secret);
      await service.ingest(slug, built.raw, { ...built.headers, 'x-sandbox': 'true' });
      expect(sandboxOf(published[0]!)).not.toBe(true);
    });
  });

  describe('INV-ING-EMPTY-SECRET: an empty secret never verifies (F6)', () => {
    it('a webhook forged with the empty key is refused, whatever the secret list holds', async () => {
      for (const secrets of [[''], ['', 'sec-acme']]) {
        integrations.acme = integration({ webhook_secrets: secrets });
        const forged = signedA('');
        const err = await service
          .ingest('acme', forged.raw, forged.headers)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(401);
        expect(rows).toHaveLength(0);
        expect(published).toHaveLength(0);
      }
      integrations.bravo = integration({
        tenant_id: T2,
        casino: 'casino-b',
        webhook_secrets: [''],
      });
      const forgedB = signedB('');
      const errB = await service
        .ingest('bravo', forgedB.raw, forgedB.headers)
        .catch((e: unknown) => e);
      expect((errB as HttpException).getStatus?.()).toBe(401);
      expect(rows).toHaveLength(0);
    });

    it('an empty secret list is refused as well', async () => {
      integrations.acme = integration({ webhook_secrets: [] });
      const forged = signedA('');
      await expect(service.ingest('acme', forged.raw, forged.headers)).rejects.toBeInstanceOf(
        HttpException,
      );
      expect(rows).toHaveLength(0);
    });

    it('the adapters themselves never return valid for an empty secret', () => {
      const reg = createDefaultRegistry();
      for (const [casino, sign] of [
        ['casino-a', signedA],
        ['casino-b', signedB],
      ] as const) {
        const adapter = reg.get(casino)!.create({
          baseUrl: '',
          transport: async () => {
            throw new Error('no network');
          },
        });
        const forged = sign('');
        expect(adapter.verifySignature(forged.raw, forged.headers, '', NOW)).not.toBe('valid');
      }
    });
  });
});
