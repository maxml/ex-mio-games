import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import {
  createEvent,
  parseEvent,
  type EventEnvelope,
  type RuleDefinition,
} from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { PLAYER_DIRECTORY } from '../integrations/ports';
import {
  RulesRepository,
  SpinCreditsRepository,
  type NewCredit,
  type StoredRule,
} from '../model/repositories';
import { SpinCreditsService } from './spin-credits.service'; // RED: module missing

/**
 * Spin credits granted from engagement.deposit.confirmed (MIO-061). Consumer entry point:
 *   SpinCreditsService.onDepositConfirmed(tx, event)   (runs inside the inbox transaction)
 *
 * Mutations:
 *  - key rows by a random seq / fresh uuid instead of (source_event_id, rule_id, seq) -> INV-CRED-ONCE.
 *  - publish spin.granted for rows the repository did NOT insert -> INV-CRED-ONCE.
 *  - take user_id from anything but the event's `player_id`, or consult the directory -> INV-CRED-PLAYER-MAPPED.
 *  - publish with a second transaction -> INV-CRED-ATOMIC.
 *  - pass `{}` (or another player's counts) to evaluateRules instead of priorGrantCounts(tx, user)
 *    -> INV-CRED-CAP-WIRED. The cap is best effort under concurrency (two deposits of one player
 *    processed in parallel can both pass it; spec section 6): only the sequential case is pinned.
 */

const T = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const W = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';
const USER = '0190a1b2-c3d4-4e5f-8a6b-0000000000aa';
const INBOUND = '0190a1b2-c3d4-4e5f-8a6b-0000000000bb';
const TX = { marker: 'the-tx' };

const rule = (spins: number, min = 1000): StoredRule => ({
  rule_id: 'rule-1',
  version: 4,
  definition: {
    name: 'r',
    trigger: 'deposit.succeeded',
    conditions: { min_amount_minor: min },
    action: { type: 'grant_spins', spins, wheel_id: W },
    active_from: '2026-11-01T00:00:00.000Z',
    active_to: null,
    max_grants_per_player: null,
  } satisfies RuleDefinition,
});

// D-12 / F1: the event carries only the internal player id; the raw casino id never reaches here.
const depositEvent = (amount = 5000, sandbox = false) =>
  createEvent({
    type: 'engagement.deposit.confirmed',
    tenantId: T,
    ...(sandbox ? { sandbox: true } : {}),
    payload: {
      inbound_event_id: INBOUND,
      source: 'casino-a',
      external_event_id: 'evt-1',
      player_id: USER, // X-1: resolved by ingest through identity; the event never carries the raw casino id
      amount_minor: amount,
      currency: 'EUR',
      occurred_at: '2026-11-15T10:00:00.000Z',
    },
  } as never);

describe('SpinCreditsService.onDepositConfirmed', () => {
  let service: SpinCreditsService;
  const stored = new Map<string, NewCredit>();
  const grantTx: unknown[] = [];
  const published: Array<{ tx: unknown; event: EventEnvelope }> = [];
  // F1: the consumer no longer resolves anything; if it still asks the directory this throws.
  const resolveOrCreate = jest.fn(async (): Promise<string> => {
    throw new Error('the consumer must not resolve players: the event carries player_id');
  });
  let priorCounts: Record<string, number>;
  const priorGrantCounts = jest.fn(async (_tx: unknown, _userId: string) => priorCounts);
  let rules: StoredRule[];

  beforeEach(async () => {
    priorCounts = {};
    stored.clear();
    grantTx.length = 0;
    published.length = 0;
    rules = [rule(3)];
    const credits = {
      // models UNIQUE (tenant_id, source_event_id, rule_id, seq) ON CONFLICT DO NOTHING
      async grant(tx: unknown, rows: NewCredit[]) {
        grantTx.push(tx);
        const inserted: NewCredit[] = [];
        for (const r of rows) {
          const key = `${r.tenantId}|${r.sourceEventId}|${r.ruleId}|${r.seq}`;
          if (!stored.has(key)) {
            stored.set(key, r);
            inserted.push(r);
          }
        }
        return inserted;
      },
    };
    const mod = await Test.createTestingModule({
      providers: [
        SpinCreditsService,
        {
          provide: Db,
          useValue: {
            publish: async (tx: unknown, event: EventEnvelope) =>
              void published.push({ tx, event }),
          },
        },
        {
          provide: RulesRepository,
          useValue: { listRules: async () => rules, priorGrantCounts },
        },
        { provide: SpinCreditsRepository, useValue: credits },
        { provide: PLAYER_DIRECTORY, useValue: { resolveOrCreate } },
      ],
    }).compile();
    service = mod.get(SpinCreditsService);
  });

  it('INV-CRED-ONCE: one deposit delivered three times creates exactly N credits and N spin.granted', async () => {
    const ev = depositEvent();
    for (let i = 0; i < 3; i++) await service.onDepositConfirmed(TX as never, ev);
    expect(stored.size).toBe(3);
    expect(published.filter((p) => p.event.type === 'engagement.spin.granted')).toHaveLength(3);
    const rows = [...stored.values()];
    expect(rows.map((r) => r.seq).sort()).toEqual([0, 1, 2]);
    expect(new Set(rows.map((r) => r.sourceEventId))).toEqual(new Set([INBOUND]));
    expect(rows.every((r) => r.ruleId === 'rule-1' && r.ruleVersion === 4)).toBe(true);
  });

  it('INV-CRED-SANDBOX: a credit granted from a sandbox deposit is a sandbox credit, and so is its spin.granted (F3, D-13)', async () => {
    await service.onDepositConfirmed(TX as never, depositEvent(5000, true));
    const rows = [...stored.values()] as Array<NewCredit & { sandbox?: boolean }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.sandbox === true)).toBe(true);
    expect(published.every((p) => (p.event as { sandbox?: boolean }).sandbox === true)).toBe(true);
    stored.clear();
    published.length = 0;
    await service.onDepositConfirmed(TX as never, depositEvent());
    const prod = [...stored.values()] as Array<NewCredit & { sandbox?: boolean }>;
    expect(prod.every((r) => r.sandbox !== true)).toBe(true);
    expect(published.every((p) => (p.event as { sandbox?: boolean }).sandbox !== true)).toBe(true);
  });

  // X-1: the player is resolved ONCE, in ingest, before the outbox write. The consumer takes the
  // internal `player_id` from the event and never consults the directory again.
  // Mutation: resolve at the consumer (call the directory), or take the user id from anything but the event's player_id.
  it('INV-CRED-PLAYER-MAPPED: the credit belongs to the event player_id (resolved at ingest); the directory is not consulted', async () => {
    await service.onDepositConfirmed(TX as never, depositEvent());
    expect(resolveOrCreate).not.toHaveBeenCalled();
    const rows = [...stored.values()];
    expect(rows.every((r) => r.userId === USER && r.tenantId === T)).toBe(true);
    const granted = parseEvent(published[0]!.event);
    expect(granted.payload).toMatchObject({
      player_id: USER,
      wheel_id: W,
      source_event_id: INBOUND,
    });
  });

  it('INV-CRED-THRESHOLD: a deposit below the rule threshold creates no credit and no event', async () => {
    await service.onDepositConfirmed(TX as never, depositEvent(999));
    expect(stored.size).toBe(0);
    expect(published).toHaveLength(0);
  });

  it('INV-CRED-CAP-WIRED: the per-player grant counts of the resolved player reach the rules engine, so a capped rule grants nothing', async () => {
    rules = [
      {
        ...rule(3),
        definition: { ...rule(3).definition, max_grants_per_player: 1 },
      },
    ];
    priorCounts = { 'rule-1': 1 }; // the player already got this rule once
    await service.onDepositConfirmed(TX as never, depositEvent());
    expect(priorGrantCounts).toHaveBeenCalledWith(TX, USER); // keyed by the identity-resolved player
    expect(stored.size).toBe(0);
    expect(published).toHaveLength(0);
    priorCounts = {};
    await service.onDepositConfirmed(TX as never, depositEvent());
    expect(stored.size).toBe(3); // below the cap it grants
  });

  it('INV-CRED-ATOMIC: credits and spin.granted are written with the same transaction handle', async () => {
    await service.onDepositConfirmed(TX as never, depositEvent());
    expect(grantTx.every((t) => t === TX)).toBe(true);
    expect(published.every((p) => p.tx === TX)).toBe(true);
    expect(published.length).toBeGreaterThan(0);
  });

  it('INV-CRED-POISON: an event that is not a valid deposit.confirmed throws (inbox sends it to the DLQ)', async () => {
    const bad = { ...depositEvent(), payload: {} };
    await expect(service.onDepositConfirmed(TX as never, bad)).rejects.toThrow();
    expect(stored.size).toBe(0);
  });
});
