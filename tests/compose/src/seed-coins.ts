import { connect } from 'amqplib';
import { createEvent, uuidv7 } from '@ex-mio/contracts';
import { eventually, urls } from './env';

/*
 * Test-only coin seeding through the real D-1 path (reconciliation section 3). There is no credit
 * route in payments, so a test funds a player by publishing the `engagement.spin.completed` event
 * that a real spin would write. Payments' inbox handler credits it: same journal, same grants, same
 * reconciliation. Never imported by a service.
 *
 * The balance is read through the operator-facing `GET /v1/players/:player_id/balance` (payments
 * read API, tenant from the operator's token), never from the cache.
 *
 * `playerId` must be a real identity user id (a launched player, see `player-session.ts`): a
 * made-up uuid creates a wallet that no token can read.
 */

export interface SeedOptions {
  /** `true` credits the sandbox wallet (D-13): the envelope flag is set by this producer. */
  sandbox?: boolean;
  /** An operator access token of `tenantId` (aud=payments), used to read the balance back. */
  operatorToken: string;
  /**
   * int/all review: the operator route reads the PRODUCTION wallet only (X-2), so a sandbox credit
   * can never show there and the wait timed out. A sandbox seed reads the balance back as the
   * sandbox player itself (`GET /v1/me/balance`, wallet chosen by the token's `sbx` claim).
   */
  sandboxPlayerHeaders?: Record<string, string>;
  /** How long to wait for the credit to land. */
  timeoutMs?: number;
}

async function sandboxAvailableOf(headers: Record<string, string>): Promise<number | undefined> {
  const res = await fetch(`${urls.payments}/v1/me/balance`, { headers });
  if (res.status !== 200) return undefined;
  return ((await res.json()) as { available: number }).available;
}

/** Publishes one confirmed `engagement.spin.completed` for `playerId`; returns the spin id. */
export async function publishSpinCompleted(
  tenantId: string,
  playerId: string,
  coins: number,
  sandbox = false,
): Promise<string> {
  const spinId = uuidv7();
  const env = createEvent({
    type: 'engagement.spin.completed',
    tenantId,
    sandbox: sandbox || undefined,
    payload: { spin_id: spinId, player_id: playerId, reward_coins: coins, table_version: 1 },
  });
  const conn = await connect(urls.amqp);
  try {
    const ch = await conn.createConfirmChannel();
    ch.publish('mio.events', env.type, Buffer.from(JSON.stringify(env)), {
      persistent: true,
      contentType: 'application/json',
      messageId: env.event_id,
      type: env.type,
    });
    await ch.waitForConfirms();
  } finally {
    await conn.close();
  }
  return spinId;
}

async function availableOf(
  tenantId: string,
  playerId: string,
  operatorToken: string,
): Promise<number | undefined> {
  const res = await fetch(`${urls.payments}/v1/players/${playerId}/balance`, {
    headers: { authorization: `Bearer ${operatorToken}` },
  });
  if (res.status !== 200) return undefined;
  return ((await res.json()) as { available: number }).available;
}

/** Credits `coins` to `playerId` through a real `spin.completed` and waits until the balance shows it. */
export async function seedCoins(
  tenantId: string,
  playerId: string,
  coins: number,
  opts: SeedOptions,
): Promise<void> {
  if (opts.sandbox && !opts.sandboxPlayerHeaders) {
    throw new Error('a sandbox seed needs sandboxPlayerHeaders to read the sandbox wallet back');
  }
  const read = () =>
    opts.sandbox
      ? sandboxAvailableOf(opts.sandboxPlayerHeaders!)
      : availableOf(tenantId, playerId, opts.operatorToken);
  const before = (await read()) ?? 0;
  await publishSpinCompleted(tenantId, playerId, coins, opts.sandbox ?? false);
  await eventually(async () => {
    const now = await read();
    return now !== undefined && now >= before + coins ? now : undefined;
  }, opts.timeoutMs);
}

/** Seeds many players at once: publishes every event first, then waits once for all balances. */
export async function seedCoinsMany(
  tenantId: string,
  grants: Array<{ playerId: string; coins: number }>,
  opts: SeedOptions,
): Promise<void> {
  const before = await Promise.all(
    grants.map(async (g) => (await availableOf(tenantId, g.playerId, opts.operatorToken)) ?? 0),
  );
  for (const g of grants) {
    await publishSpinCompleted(tenantId, g.playerId, g.coins, opts.sandbox ?? false);
  }
  await eventually(async () => {
    for (const [i, g] of grants.entries()) {
      const now = await availableOf(tenantId, g.playerId, opts.operatorToken);
      if (now === undefined || now < (before[i] ?? 0) + g.coins) return undefined;
    }
    return true;
  }, opts.timeoutMs);
}
