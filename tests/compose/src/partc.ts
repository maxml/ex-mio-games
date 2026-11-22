import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { connect } from 'amqplib';
import { uuidv7 } from '@ex-mio/contracts';
import { eventually, pgAs, urls } from './env';
import { newTenant, type PlayerSession, type TestTenant } from './player-session';

/*
 * Shared setup of the Part C failure tests on the real stack (review/partc-compose). Written by the
 * reviewer, not the author of the saga. Everything goes through the real routes:
 *  - a tenant whose integration credential is for the `casino-a` adapter (native lookup by our key);
 *  - its operator registers casino-sim as the reward API (D-27,
 *    `PUT /v1/operator/integrations/casino-a/reward-api`), so issuance really reaches casino-sim;
 *  - a wheel with ONE segment (so every spin's reward is known) and a rule "deposit >= 20.00 EUR
 *    gives 1 spin", published with `PUT /v1/operator/wheel` and `PUT /v1/operator/rules`;
 *  - a store item whose casino reward is a 5.00 EUR bonus.
 * Casino-sim is driven through its control routes (`SIM_FAULTS=1` in docker-compose.yml):
 * `/__faults`, `/__issued`, `/__reset`, `/casino-a/__deposit`.
 */

/** Where the services reach each other INSIDE the compose network (casino-sim calls engagement there). */
export const internal = {
  casinoSim: process.env.CASINO_SIM_INTERNAL_URL ?? 'http://casino-sim:4004',
  engagement: process.env.ENGAGEMENT_INTERNAL_URL ?? 'http://engagement:4002',
};

export const PRICE = 50;
export const SEGMENT_COINS = 300;
export const DEPOSIT_MIN_MINOR = 2000;

const json = { 'content-type': 'application/json' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export { sleep };

export interface PartCTenant {
  tenant: TestTenant;
  operatorEngagement: Record<string, string>;
  operatorPayments: string;
  itemId: string;
}

/** A casino-a tenant with casino-sim as its reward API, a one-segment wheel, one rule and one item. */
export async function partCTenant(): Promise<PartCTenant> {
  const tenant = await newTenant({ platform: 'casino-a' });
  const identityOp = await tenant.operatorHeaders('identity');
  const put = await fetch(`${urls.identity}/v1/operator/integrations/casino-a/reward-api`, {
    method: 'PUT',
    headers: { ...json, ...identityOp },
    body: JSON.stringify({
      environment: 'production',
      base_url: internal.casinoSim,
      api_key: 'partc-reward-key',
    }),
  });
  if (put.status !== 200) throw new Error(`reward-api PUT failed: ${put.status}`);

  const operatorEngagement = await tenant.operatorHeaders('engagement');
  // engagement learns the tenant from identity's bus event; until then the PUTs can be refused.
  await eventually(async () => {
    const r = await fetch(`${urls.engagement}/v1/operator/wheel`, {
      method: 'PUT',
      headers: { ...json, ...operatorEngagement },
      body: JSON.stringify({
        name: 'Part C wheel',
        segments: [
          {
            label: `${SEGMENT_COINS} coins`,
            weight: 1,
            reward: { type: 'coins', amount: SEGMENT_COINS },
          },
        ],
      }),
    });
    return r.status === 200 ? true : undefined;
  }, 30_000);
  await eventually(async () => {
    const r = await fetch(`${urls.engagement}/v1/operator/rules`, {
      method: 'PUT',
      headers: { ...json, ...operatorEngagement },
      body: JSON.stringify({
        name: 'Deposit 20 EUR, 1 spin',
        min_amount_minor: DEPOSIT_MIN_MINOR,
        currency: 'EUR',
        spins: 1,
      }),
    });
    return r.status === 200 ? true : undefined;
  }, 30_000);

  const item = await fetch(`${urls.engagement}/v1/store/items`, {
    method: 'POST',
    headers: { ...json, ...operatorEngagement },
    body: JSON.stringify({
      name: '5 EUR bonus',
      price: PRICE,
      stock: 100,
      reward: { type: 'bonus', params: { amount_minor: 500, currency: 'EUR' } },
    }),
  });
  if (item.status !== 201) throw new Error(`store item create failed: ${item.status}`);
  const { id: itemId } = (await item.json()) as { id: string };
  return {
    tenant,
    operatorEngagement,
    operatorPayments: await tenant.operatorToken('payments'),
    itemId,
  };
}

// ---- casino-sim control ------------------------------------------------------------------------

export type FaultKind =
  | 'timeout'
  | 'dropReply'
  | 'error500'
  | 'reject'
  | 'slow'
  | 'duplicateDelivery'
  | 'outOfOrder';

export async function armFault(plan: {
  kind: FaultKind;
  player_id?: string;
  times?: number;
  delay_ms?: number;
  copies?: number;
}): Promise<void> {
  const r = await fetch(`${urls.casinoSim}/__faults`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ casino: 'a', times: 1, ...plan }),
  });
  if (r.status !== 200) throw new Error(`arming fault ${plan.kind} failed: ${r.status}`);
}

/** Global: clears every fault and every issued record of casino-sim (the suite runs in band). */
export async function resetCasino(): Promise<void> {
  const r = await fetch(`${urls.casinoSim}/__reset`, { method: 'POST' });
  if (r.status !== 200) throw new Error(`casino reset failed: ${r.status}`);
}

/**
 * How many rewards casino-sim (casino A) holds under OUR key for this PRODUCTION order. The key is
 * pinned as a LITERAL (D-30, F2 accepted): `redeem:<tenant id>:prd:<order id>`, the D-26 scoped key.
 * The old `redeem:<order id>` matched nothing after the change, so a `toBe(0)` here passed for any
 * behaviour. Mutation: drop the tenant or the environment from `orderKey` in redemption-saga.service
 * -> the casino holds a different key, every `issuedFor(...) === 1` below goes red.
 */
export async function issuedFor(t: PartCTenant, redemptionId: string): Promise<number> {
  const r = await fetch(`${urls.casinoSim}/__issued?casino=a`);
  const list = (await r.json()) as Array<{ key: string }>;
  const key = `redeem:${t.tenant.tenantId.toLowerCase()}:prd:${redemptionId.toLowerCase()}`;
  return list.filter((x) => x.key === key).length;
}

/** Casino A sends a signed deposit webhook to the tenant's ingest route (from inside the network). */
export async function casinoDeposit(
  t: PartCTenant,
  player: PlayerSession,
  eventId: string,
  amountMinor = 5000,
): Promise<number[]> {
  const r = await fetch(`${urls.casinoSim}/casino-a/__deposit`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      target_url: `${internal.engagement}/v1/integrations/${t.tenant.slug}/events`,
      secret: t.tenant.credential.hmac_secret,
      player_id: player.externalPlayerId,
      amount_minor: amountMinor,
      currency: 'EUR',
      event_id: eventId,
    }),
  });
  if (r.status !== 200) throw new Error(`casino deposit failed: ${r.status}`);
  return ((await r.json()) as { delivered: number[] }).delivered;
}

// ---- engagement ----------------------------------------------------------------------------------

export async function redeem(t: PartCTenant, player: PlayerSession): Promise<string> {
  const r = await fetch(`${urls.engagement}/v1/redemptions`, {
    method: 'POST',
    headers: { ...json, ...player.headers, 'idempotency-key': `partc-${uuidv7()}` },
    body: JSON.stringify({ item_id: t.itemId }),
  });
  if (r.status !== 202) throw new Error(`redeem failed: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { id: string }).id;
}

export interface OperatorRedemption {
  state: string;
  attempts: number;
  failure_reason: string | null;
  history: Array<{ from: string | null; to: string; cause: string }>;
}

export async function operatorRedemption(t: PartCTenant, id: string): Promise<OperatorRedemption> {
  const r = await fetch(`${urls.engagement}/v1/operator/redemptions/${id}`, {
    headers: t.operatorEngagement,
  });
  if (r.status !== 200) throw new Error(`operator redemption read failed: ${r.status}`);
  return (await r.json()) as OperatorRedemption;
}

/** Waits until the order is in one of `states`; on timeout says where it is stuck. */
export async function waitForState(
  t: PartCTenant,
  id: string,
  states: string[],
  timeoutMs = 90_000,
): Promise<OperatorRedemption> {
  try {
    return await eventually(async () => {
      const r = await operatorRedemption(t, id);
      return states.includes(r.state) ? r : undefined;
    }, timeoutMs);
  } catch {
    const r = await operatorRedemption(t, id);
    throw new Error(
      `order ${id} never reached ${states.join('|')}: it is ${r.state} (${r.failure_reason}); history ${transitions(r).join(', ')}`,
    );
  }
}

export const transitions = (r: OperatorRedemption): string[] =>
  r.history.map((h) => `${h.from}->${h.to}`);

/** `expected` appears in `actual` in this order (other entries may sit between them). */
export function inOrder(actual: string[], expected: string[]): boolean {
  let i = 0;
  for (const a of actual) if (a === expected[i]) i += 1;
  return i === expected.length;
}

export async function mySpins(player: PlayerSession): Promise<number | undefined> {
  const r = await fetch(`${urls.engagement}/v1/me/spins`, { headers: player.headers });
  if (r.status !== 200) return undefined;
  return ((await r.json()) as { available: number }).available;
}

export const spin = (player: PlayerSession, key = `spin-${uuidv7()}`) =>
  fetch(`${urls.engagement}/v1/spins`, {
    method: 'POST',
    headers: { ...json, ...player.headers, 'idempotency-key': key },
    body: JSON.stringify({}),
  });

// ---- payments --------------------------------------------------------------------------------------

export interface Balance {
  available: number;
  held: number;
}

export async function balanceOf(
  t: PartCTenant,
  player: PlayerSession,
): Promise<Balance | undefined> {
  const r = await fetch(`${urls.payments}/v1/players/${player.userId}/balance`, {
    headers: { authorization: `Bearer ${t.operatorPayments}` },
  });
  if (r.status !== 200) return undefined;
  const b = (await r.json()) as Balance;
  return { available: b.available, held: b.held };
}

/** Journal rows of one business operation (the reserve id is the order id), per operation type. */
export async function journalOf(
  tenantId: string,
  operationId: string,
): Promise<Record<string, number>> {
  const db = await pgAs('payments_app');
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const { rows } = await db.query(
      `SELECT operation_type, count(*)::int AS n FROM journal_transactions
        WHERE operation_id = $1 GROUP BY operation_type`,
      [operationId],
    );
    await db.query('COMMIT');
    return Object.fromEntries(
      rows.map((r: { operation_type: string; n: number }) => [r.operation_type, r.n]),
    );
  } finally {
    await db.end();
  }
}

/** The reserve row payments holds for the order. */
export async function reserveStateOf(
  tenantId: string,
  reserveId: string,
): Promise<string | undefined> {
  const db = await pgAs('payments_app');
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const { rows } = await db.query(`SELECT state FROM reserves WHERE id = $1`, [reserveId]);
    await db.query('COMMIT');
    return rows[0]?.state as string | undefined;
  } finally {
    await db.end();
  }
}

/**
 * Outbox envelopes engagement wrote for one event type whose payload field `field` equals `value`
 * (the outbox has no RLS: the relay works across tenants, the row still carries `tenant_id`).
 */
export async function engagementOutbox(
  tenantId: string,
  type: string,
  field: string,
  value: string,
): Promise<Array<Record<string, unknown>>> {
  const db = await pgAs('engagement_app');
  try {
    const { rows } = await db.query(
      `SELECT envelope FROM outbox
        WHERE tenant_id = $1 AND type = $2 AND envelope->'payload'->>$3 = $4
        ORDER BY created_at`,
      [tenantId, type, field, value],
    );
    return rows.map((r: { envelope: Record<string, unknown> }) => r.envelope);
  } finally {
    await db.end();
  }
}

/** Publishes an envelope to the events exchange as the relay would (persistent, confirmed). */
export async function republish(envelope: Record<string, unknown>): Promise<void> {
  const conn = await connect(urls.amqp);
  try {
    const ch = await conn.createConfirmChannel();
    const type = String(envelope.type);
    ch.publish('mio.events', type, Buffer.from(JSON.stringify(envelope)), {
      persistent: true,
      contentType: 'application/json',
      messageId: String(envelope.event_id),
      type,
    });
    await ch.waitForConfirms();
  } finally {
    await conn.close();
  }
}

// ---- the stack itself --------------------------------------------------------------------------

const sh = promisify(execFile);
const repoRoot = resolve(__dirname, '../../..');

/** `docker compose <args>` on the stack under test (same project as the other compose tests). */
export async function compose(...args: string[]): Promise<void> {
  await sh('docker', ['compose', ...args], { cwd: repoRoot, timeout: 120_000 });
}

const readiness = async (base: string): Promise<number> => {
  try {
    return (await fetch(`${base}/healthz/ready`)).status;
  } catch {
    return 0;
  }
};

/** Every service answers ready (its broker session is up again). */
export async function stackReady(timeoutMs = 120_000): Promise<void> {
  await eventually(async () => {
    const codes = await Promise.all([urls.identity, urls.engagement, urls.payments].map(readiness));
    return codes.every((c) => c === 200) ? true : undefined;
  }, timeoutMs);
}

/** Ingest rows of one casino event in the tenant (engagement's dedupe key). */
export async function inboundRowsOf(tenantId: string, externalEventId: string): Promise<number> {
  const db = await pgAs('engagement_app');
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM inbound_events WHERE source = 'casino-a' AND external_event_id = $1`,
      [externalEventId],
    );
    await db.query('COMMIT');
    return rows[0].n as number;
  } finally {
    await db.end();
  }
}
