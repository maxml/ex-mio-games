import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/**
 * The two simulated casinos' deposit webhooks, reward APIs and fault injection.
 * Wire protocol: docs/specs/engagement-ingest.md section 3.
 */

export type DeliverFn = (
  url: string,
  init: { headers: Record<string, string>; body: string },
) => Promise<{ status: number }>;

type Casino = 'a' | 'b';

export const FAULT_KINDS = [
  'timeout',
  'dropReply',
  'error500',
  'reject',
  'slow',
  'duplicateDelivery',
  'outOfOrder',
] as const;
type FaultKind = (typeof FAULT_KINDS)[number];

const FaultPlan = z
  .object({
    casino: z.enum(['a', 'b']),
    kind: z.enum(FAULT_KINDS),
    times: z.number().int().positive().default(1),
    player_id: z.string().min(1).optional(),
    delay_ms: z.number().int().min(0).max(120_000).default(1000),
    copies: z.number().int().min(1).max(100).default(2),
  })
  .strict();

interface Fault {
  casino: Casino;
  kind: FaultKind;
  remaining: number;
  player_id?: string;
  delay_ms: number;
  copies: number;
}

interface Issued {
  key: string;
  player_id: string;
  reference: string;
  reward: unknown;
}

const hmac = (secret: string, msg: string): string =>
  createHmac('sha256', secret).update(msg).digest('hex');

const Deposit = z
  .object({
    target_url: z.string().min(1),
    secret: z.string().min(1),
    player_id: z.string().min(1),
    amount_minor: z.number().int().positive(),
    currency: z.string().min(1).default('EUR'),
    event_id: z.string().min(1).optional(),
    status: z.string().min(1).default('SUCCESS'),
  })
  .strict();
type Deposit = z.infer<typeof Deposit>;

const BonusA = z.object({
  idempotencyKey: z.string().min(1),
  playerId: z.string().min(1),
  bonus: z.object({
    type: z.string().min(1),
    amount: z.number().int().positive(),
    currency: z.string().min(1),
  }),
});
const RewardB = z.object({
  idempotency_key: z.string().min(1),
  customer_ref: z.string().min(1),
  reward: z.object({
    type: z.string().min(1),
    amount_cents: z.number().int().positive(),
    ccy: z.string().min(1),
  }),
});

interface Ticket {
  ticket: string;
  state: 'PENDING' | 'DONE' | 'FAILED';
  willFail: boolean;
  reward_ref?: string;
  code?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const defaultDeliver: DeliverFn = async (url, init) => {
  const res = await fetch(url, { method: 'POST', headers: init.headers, body: init.body });
  return { status: res.status };
};

export function registerCasinos(
  app: FastifyInstance,
  opts: { deliver?: DeliverFn; faultsEnabled?: boolean },
): void {
  const deliver = opts.deliver ?? defaultDeliver;
  let faults: Fault[] = [];
  const issued: Record<Casino, Map<string, Issued>> = { a: new Map(), b: new Map() };
  const tickets = new Map<string, Ticket>();
  const ticketByKey = new Map<string, string>();
  /** Deposits held back by an active `outOfOrder` fault, per casino. */
  const held: Record<Casino, Array<() => Promise<unknown>>> = { a: [], b: [] };

  /** Consumes one use of the first matching fault of the given kinds. */
  function take(casino: Casino, kinds: FaultKind[], player?: string): Fault | undefined {
    const f = faults.find(
      (x) =>
        x.casino === casino &&
        x.remaining > 0 &&
        kinds.includes(x.kind) &&
        (x.player_id === undefined || x.player_id === player),
    );
    if (f) f.remaining -= 1;
    return f;
  }

  // ---- deposit webhooks ----------------------------------------------------------------------

  function buildWebhook(
    casino: Casino,
    d: Deposit,
  ): { headers: Record<string, string>; body: string } {
    const eventId = d.event_id ?? randomUUID();
    if (casino === 'a') {
      const ts = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({
        eventId,
        playerId: d.player_id,
        amount: { value: d.amount_minor, currency: d.currency },
        status: d.status,
        ts,
      });
      return {
        headers: {
          'content-type': 'application/json',
          'x-a-timestamp': String(ts),
          'x-a-signature': hmac(d.secret, `${ts}.${body}`),
        },
        body,
      };
    }
    const type = 'payment.completed';
    const sentAt = new Date().toISOString();
    const signature = hmac(
      d.secret,
      `${sentAt}.${type}.${eventId}.${d.player_id}.${d.amount_minor}.${d.currency}`,
    );
    const body = JSON.stringify({
      type,
      data: {
        txn_id: eventId,
        customer_ref: d.player_id,
        amount_cents: d.amount_minor,
        ccy: d.currency,
      },
      sent_at: sentAt,
      signature,
    });
    return { headers: { 'content-type': 'application/json' }, body };
  }

  for (const casino of ['a', 'b'] as const) {
    app.post(`/casino-${casino}/__deposit`, async (req, reply) => {
      const parsed = Deposit.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
      const d = parsed.data;
      // An armed outOfOrder fault holds this deposit; the next one is delivered before it.
      if (take(casino, ['outOfOrder'])) {
        const hook = buildWebhook(casino, d);
        held[casino].push(() => deliver(d.target_url, hook));
        return { held: true };
      }
      const dup = take(casino, ['duplicateDelivery'], d.player_id);
      let statuses: number[];
      if (dup) {
        // Identical webhooks: build once, deliver N times.
        const hook = buildWebhook(casino, d);
        statuses = [];
        for (let i = 0; i < dup.copies; i += 1)
          statuses.push((await deliver(d.target_url, hook)).status);
      } else {
        statuses = [(await deliver(d.target_url, buildWebhook(casino, d))).status];
      }
      // Deliver anything held back by outOfOrder after the deposit that overtook it.
      const pending = held[casino].splice(0);
      for (const run of pending) await run();
      return { delivered: statuses };
    });
  }

  // ---- reward APIs ---------------------------------------------------------------------------

  /** Applies a connection-level fault. Returns true when the reply was already handled. */
  async function applyTransportFault(
    f: Fault | undefined,
    req: FastifyRequest,
    reply: FastifyReply,
    record: () => void,
  ): Promise<'handled' | 'continue'> {
    if (!f) {
      record();
      return 'continue';
    }
    if (f.kind === 'error500') {
      await reply.code(500).send({ error: 'simulated failure' });
      return 'handled';
    }
    if (f.kind === 'slow') {
      await sleep(f.delay_ms);
      record();
      return 'continue';
    }
    if (f.kind === 'timeout') {
      record();
      await sleep(f.delay_ms);
      return 'continue';
    }
    if (f.kind === 'dropReply') {
      record();
      reply.hijack();
      req.raw.socket.destroy();
      return 'handled';
    }
    record();
    return 'continue';
  }

  const REWARD_KINDS: FaultKind[] = ['timeout', 'dropReply', 'error500', 'reject', 'slow'];

  app.post('/casino-a/bonuses', async (req, reply) => {
    const parsed = BonusA.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const { idempotencyKey, playerId, bonus } = parsed.data;
    const f = take('a', REWARD_KINDS, playerId);
    if (f?.kind === 'reject') return reply.code(422).send({ error: 'bonus rejected' });
    const record = (): void => {
      if (!issued.a.has(idempotencyKey)) {
        issued.a.set(idempotencyKey, {
          key: idempotencyKey,
          player_id: playerId,
          reference: `bonus-${randomUUID()}`,
          reward: bonus,
        });
      }
    };
    if ((await applyTransportFault(f, req, reply, record)) === 'handled') return reply;
    const rec = issued.a.get(idempotencyKey)!;
    return { bonusId: rec.reference, status: 'ISSUED' };
  });

  app.get('/casino-a/bonuses', async (req, reply) => {
    const key = (req.query as { idempotencyKey?: string }).idempotencyKey ?? '';
    const rec = issued.a.get(key);
    if (!rec) return reply.code(404).send({ error: 'not found' });
    return { bonusId: rec.reference, status: 'ISSUED' };
  });

  app.post('/casino-b/v2/rewards', async (req, reply) => {
    const parsed = RewardB.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const { idempotency_key: key, customer_ref: player, reward } = parsed.data;
    const f = take('b', REWARD_KINDS, player);
    const record = (): void => {
      if (ticketByKey.has(key)) return;
      const ticket = `tkt-${randomUUID()}`;
      const willFail = f?.kind === 'reject';
      ticketByKey.set(key, ticket);
      tickets.set(ticket, { ticket, state: 'PENDING', willFail });
      if (!willFail) {
        issued.b.set(key, { key, player_id: player, reference: ticket, reward });
      }
    };
    if (f?.kind === 'error500') return reply.code(500).send({ error: 'simulated failure' });
    // A `reject` fault is a final rejection that shows up once the ticket is settled.
    const transport = f?.kind === 'reject' ? undefined : f;
    if ((await applyTransportFault(transport, req, reply, record)) === 'handled') return reply;
    return reply.code(202).send({ ticket: ticketByKey.get(key) });
  });

  app.get('/casino-b/v2/rewards/:ticket', async (req, reply) => {
    const t = tickets.get((req.params as { ticket: string }).ticket);
    if (!t) return reply.code(404).send({ error: 'not found' });
    if (t.state === 'DONE') return { state: 'DONE', reward_ref: t.reward_ref };
    if (t.state === 'FAILED') return { state: 'FAILED', code: t.code };
    return { state: 'PENDING' };
  });

  // ---- control routes: only when faults are enabled ------------------------------------------

  if (!opts.faultsEnabled) return;

  app.post('/casino-b/__settle', async () => {
    let settled = 0;
    for (const t of tickets.values()) {
      if (t.state !== 'PENDING') continue;
      settled += 1;
      if (t.willFail) {
        t.state = 'FAILED';
        t.code = 'rejected';
      } else {
        t.state = 'DONE';
        t.reward_ref = `ref-${randomUUID()}`;
      }
    }
    return { settled };
  });

  app.post('/__faults', async (req, reply) => {
    const parsed = FaultPlan.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid fault plan' });
    const p = parsed.data;
    faults.push({
      casino: p.casino,
      kind: p.kind,
      remaining: p.times,
      ...(p.player_id !== undefined ? { player_id: p.player_id } : {}),
      delay_ms: p.delay_ms,
      copies: p.copies,
    });
    return { ok: true };
  });

  app.post('/__reset', async () => {
    faults = [];
    issued.a.clear();
    issued.b.clear();
    tickets.clear();
    ticketByKey.clear();
    held.a = [];
    held.b = [];
    return { ok: true };
  });

  app.get('/__issued', async (req) => {
    const casino = (req.query as { casino?: string }).casino;
    const list = (c: Casino): Issued[] => [...issued[c].values()];
    if (casino === 'a' || casino === 'b') return list(casino);
    return [...list('a'), ...list('b')];
  });
}
