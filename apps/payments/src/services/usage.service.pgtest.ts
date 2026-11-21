import { createEvent, uuidv7, type EventEnvelope } from '@ex-mio/contracts';
import { newPlayer, newTenant, openHarness, type Harness } from '../testing/harness';

// Choke point: `UsageService.handle` (the bus handler that meters spins and monthly active players)
// and `UsageService.report`. Spec: docs/specs/payments.md, section 8.

let h: Harness;
beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => h.close());

function spin(tenant: string, player: string, at: string, eventId?: string): EventEnvelope {
  const e = createEvent({
    type: 'engagement.spin.completed',
    tenantId: tenant,
    payload: { spin_id: uuidv7(), player_id: player, reward_coins: 5 },
  });
  return { ...e, event_id: eventId ?? e.event_id, occurred_at: at };
}

const deliver = (t: string, e: EventEnvelope) => h.deliver(t, (m) => h.usage.handle(m, e));
const report = (t: string, period: string) => h.as(t, () => h.usage.report(period));

describe('INV-M1 a redelivered event is counted once', () => {
  // Mutation: drop the (tenant_id, event_id) primary key on usage_events, or count before the dedupe check.
  it('the same event delivered twice, also in parallel, adds one spin', async () => {
    const t = newTenant();
    const e = spin(t, newPlayer(), '2026-11-05T10:00:00.000Z');
    await Promise.allSettled([deliver(t, e), deliver(t, e)]);
    await deliver(t, e);
    expect(await report(t, '2026-11')).toEqual({
      period: '2026-11',
      spins: 1,
      monthly_active_players: 1,
    });
  });
});

describe('INV-M2 a player active on many days is one monthly active player', () => {
  // Mutation: count MAU as the number of events instead of distinct players.
  it('ten days, one player: 10 spins, 1 MAU; a second player makes 2', async () => {
    const t = newTenant();
    const p = newPlayer();
    for (let day = 1; day <= 10; day++) {
      await deliver(t, spin(t, p, `2026-11-${String(day).padStart(2, '0')}T09:00:00.000Z`));
    }
    expect(await report(t, '2026-11')).toMatchObject({ spins: 10, monthly_active_players: 1 });
    await deliver(t, spin(t, newPlayer(), '2026-11-11T09:00:00.000Z'));
    expect(await report(t, '2026-11')).toMatchObject({ spins: 11, monthly_active_players: 2 });
  });
});

describe('INV-M3 meters are per tenant and per period', () => {
  // Mutation: key the meter by period only, or sum across tenants.
  it('another tenant and another month are separate', async () => {
    const a = newTenant();
    const b = newTenant();
    const p = newPlayer();
    await deliver(a, spin(a, p, '2026-11-05T10:00:00.000Z'));
    await deliver(a, spin(a, p, '2026-12-01T00:00:00.000Z'));
    await deliver(b, spin(b, p, '2026-11-06T10:00:00.000Z'));
    expect(await report(a, '2026-11')).toMatchObject({ spins: 1, monthly_active_players: 1 });
    expect(await report(a, '2026-12')).toMatchObject({ spins: 1, monthly_active_players: 1 });
    expect(await report(b, '2026-11')).toMatchObject({ spins: 1, monthly_active_players: 1 });
    expect(await report(b, '2026-12')).toMatchObject({ spins: 0, monthly_active_players: 0 });
  });
});

describe('INV-M4 the usage report sent to the provider twice is billed once', () => {
  // Mutation: send the report without its idempotency key (period + tenant + meter).
  it('reportToProvider twice for one period: the fake provider records one billing', async () => {
    const t = newTenant();
    await deliver(t, spin(t, newPlayer(), '2026-11-05T10:00:00.000Z'));
    await h.as(t, () => h.usage.reportToProvider('2026-11'));
    await h.as(t, () => h.usage.reportToProvider('2026-11'));
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM usage_reports WHERE tenant_id = $1 AND period = '2026-11'`,
      [t],
    );
    expect(rows[0].n).toBe(1);
  });
});
