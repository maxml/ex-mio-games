import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  TenantIntegration as TenantIntegrationContract,
  type EventEnvelope,
} from '@ex-mio/contracts';
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

/*
 * rc review (test owner), F5-2: the engagement side of identity's F5 shape
 * `{ environment, webhook_secrets, sandbox?: { webhook_secrets } }`.
 *
 * Property: with a sandbox credential issued beside production, a webhook signed with a PRODUCTION
 * key is a production deposit, and one signed with a SANDBOX key is a sandbox deposit. The envelope
 * flag comes from WHICH key verified, never from the integration's headline `environment` alone and
 * never from the request. The integration is built through the contract schema, so the test breaks
 * if the served shape drifts from what engagement reads.
 *
 * Mutations (each re-applied by the reviewer, see rc-review.md):
 *  - in `verify()`, the sandbox set gets `sandbox: false`            -> F5-2a red (sandbox-signed = production).
 *  - in `verify()`, drop the sandbox set                              -> F5-2a red (401 for sandbox-signed).
 *  - in `ingest()`, `sandbox = integration.environment === 'sandbox'` -> F5-2a red.
 */

const NOW = new Date('2026-11-22T12:00:00.000Z');
const T1 = '0190a1b2-c3d4-4e5f-8a6b-000000000001';
const INTERNAL = '0190a1b2-c3d4-4e5f-8a6b-0000000000a1';
const hmac = (secret: string, msg: string) =>
  createHmac('sha256', secret).update(msg).digest('hex');

function signedA(secret: string, eventId: string) {
  const ts = Math.floor(NOW.getTime() / 1000);
  const raw = JSON.stringify({
    eventId,
    playerId: 'casino-player-1',
    amount: { value: 5000, currency: 'EUR' },
    status: 'SUCCESS',
    ts,
  });
  return {
    raw,
    headers: { 'x-a-timestamp': String(ts), 'x-a-signature': hmac(secret, `${ts}.${raw}`) },
  };
}
function signedB(secret: string, eventId: string) {
  const data = { txn_id: eventId, customer_ref: 'casino-player-1', amount_cents: 5000, ccy: 'EUR' };
  const sent_at = NOW.toISOString();
  const type = 'payment.completed';
  const signature = hmac(
    secret,
    JSON.stringify([sent_at, type, data.txn_id, data.customer_ref, data.amount_cents, data.ccy]),
  );
  return { raw: JSON.stringify({ type, data, sent_at, signature }), headers: {} };
}

/** The served shape, validated by the contract identity and engagement share. */
const served = (over: Record<string, unknown>): TenantIntegration =>
  TenantIntegrationContract.parse({
    tenant_id: T1,
    platform: 'casino-a',
    status: 'active',
    environment: 'production',
    webhook_secrets: ['prod-key-new'],
    player_hash_key: 'player-hash-key-0001',
    ...over,
  }) as unknown as TenantIntegration;

const sandboxOf = (e: EventEnvelope) => (e as { sandbox?: boolean }).sandbox === true;

describe('rc review F5-2: engagement verifies each environment with its own keys', () => {
  let integration: TenantIntegration;
  let rows: InboundEventRow[];
  let published: EventEnvelope[];
  let service: IngestionService;

  beforeEach(async () => {
    rows = [];
    published = [];
    const db = {
      async tenantTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn({});
      },
      async publish(_tx: unknown, event: EventEnvelope) {
        published.push(event);
      },
    };
    const mod = await Test.createTestingModule({
      providers: [
        IngestionService,
        { provide: Db, useValue: db },
        {
          provide: InboundEventsRepository,
          useValue: {
            async insertIfAbsent(_tx: unknown, row: InboundEventRow) {
              rows.push(row);
              return {
                inserted: true,
                id: `0190a1b2-c3d4-4e5f-8a6b-${String(rows.length).padStart(12, '0')}`,
              };
            },
          },
        },
        { provide: TENANT_INTEGRATIONS, useValue: { lookup: async () => integration } },
        { provide: ADAPTER_REGISTRY, useValue: createDefaultRegistry() },
        { provide: CLOCK, useValue: { now: () => NOW } },
        { provide: PLAYER_DIRECTORY, useValue: { resolveOrCreate: async () => INTERNAL } },
      ],
    }).compile();
    service = mod.get(IngestionService);
  });

  describe.each([
    ['casino-a', signedA],
    ['casino-b', signedB],
  ] as const)('%s', (platform, sign) => {
    it('F5-2a production keys verify as production and sandbox keys as sandbox, on one integration', async () => {
      integration = served({
        platform,
        webhook_secrets: ['prod-key-new', 'prod-key-retiring'],
        sandbox: { webhook_secrets: ['sbx-key'] },
      });
      for (const [secret, id] of [
        ['prod-key-new', 'e-prod-1'],
        ['prod-key-retiring', 'e-prod-2'],
      ] as const) {
        const b = sign(secret, id);
        await service.ingest('acme', b.raw, b.headers);
      }
      const sbx = sign('sbx-key', 'e-sbx-1');
      // (a client hint is pinned by INV-ING-SANDBOX; the header scan keeps that the only such test)
      await service.ingest('acme', sbx.raw, sbx.headers);
      expect(published.map(sandboxOf)).toEqual([false, false, true]);
    });

    it('F5-2b a sandbox-only tenant (environment sandbox) is sandbox; a key of neither set is 401 and writes nothing', async () => {
      integration = served({ platform, environment: 'sandbox', webhook_secrets: ['sbx-only'] });
      const ok = sign('sbx-only', 'e-sbx-only');
      await service.ingest('acme', ok.raw, ok.headers);
      expect(published.map(sandboxOf)).toEqual([true]);

      integration = served({ platform, sandbox: { webhook_secrets: ['sbx-key'] } });
      const before = { rows: rows.length, published: published.length };
      const bad = sign('someone-else', 'e-forged');
      const err = await service.ingest('acme', bad.raw, bad.headers).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(401);
      expect({ rows: rows.length, published: published.length }).toEqual(before);
    });
  });
});
