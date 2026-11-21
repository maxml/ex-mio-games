import { createHmac, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppLogger } from '@ex-mio/logger';

/**
 * Two fake partner casinos with deliberately different integration styles, so
 * the integrations module has two real shapes to adapt:
 *
 *  - Casino A: JSON REST, API key in a header, whole-unit amounts, `balance` back.
 *  - Casino B: signed requests (HMAC-SHA256 of the raw body in `x-signature`),
 *    amounts in cents, a `result.code` envelope (0 = ok).
 *
 * Balances live in memory. A request header `x-fault` injects a failure:
 * `error` (HTTP 500), `timeout` (no answer within the caller's timeout),
 * `slow` (answers after 1.5 s). Both casinos are idempotent on `reference`.
 */
/** Outbound webhook delivery; injected so tests need no network. Default is `fetch` POST. */
export type DeliverFn = (
  url: string,
  init: { headers: Record<string, string>; body: string },
) => Promise<{ status: number }>;

export interface SimOptions {
  logger?: AppLogger;
  keyA?: string;
  secretB?: string;
  /** STAGE A STUB (type only): see docs/specs/engagement-ingest.md section 3. Not yet used. */
  deliver?: DeliverFn;
  /** Serves /__faults, /__reset and /__issued. Default false: the control routes then do not exist. */
  faultsEnabled?: boolean;
}

const CreditA = z.object({
  player: z.string().min(1),
  amount: z.number().int().positive(),
  reference: z.string().min(1),
});
const CreditB = z.object({
  player_id: z.string().min(1),
  amount_cents: z.number().int().positive(),
  reference: z.string().min(1),
});

export function buildServer(options: SimOptions = {}): FastifyInstance {
  const keyA = options.keyA ?? 'dev-casino-a-key';
  const secretB = options.secretB ?? 'dev-casino-b-secret';
  const app = Fastify(options.logger ? { loggerInstance: options.logger } : { logger: false });

  const balancesA = new Map<string, number>();
  const balancesB = new Map<string, number>();
  const seenA = new Map<string, number>();
  const seenB = new Map<string, number>();

  // Keep the raw body: Casino B signs it.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, body === '' ? {} : JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/healthz/live', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    version: process.env.APP_VERSION ?? '0.1.0',
    checks: {},
  }));
  app.get('/healthz/ready', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    version: process.env.APP_VERSION ?? '0.1.0',
    checks: {},
  }));

  async function injectFault(fault: string | string[] | undefined): Promise<'error' | undefined> {
    if (fault === 'error') return 'error';
    if (fault === 'timeout') await new Promise((r) => setTimeout(r, 30_000));
    if (fault === 'slow') await new Promise((r) => setTimeout(r, 1_500));
    return undefined;
  }

  app.post('/casino-a/v1/wallet/credit', async (req, reply) => {
    if (req.headers['x-api-key'] !== keyA)
      return reply.code(401).send({ status: 'ERROR', error: 'bad key' });
    if ((await injectFault(req.headers['x-fault'])) === 'error')
      return reply.code(500).send({ status: 'ERROR', error: 'simulated failure' });
    const parsed = CreditA.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ status: 'ERROR', error: 'invalid body' });
    const { player, amount, reference } = parsed.data;
    if (!seenA.has(reference)) {
      balancesA.set(player, (balancesA.get(player) ?? 0) + amount);
      seenA.set(reference, amount);
    }
    return { status: 'OK', balance: balancesA.get(player) ?? 0 };
  });

  app.post('/casino-b/api/transactions', async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const given = Buffer.from(String(req.headers['x-signature'] ?? ''), 'hex');
    const want = createHmac('sha256', secretB).update(raw).digest();
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      return reply.code(401).send({ result: { code: 401, message: 'bad signature' } });
    }
    if ((await injectFault(req.headers['x-fault'])) === 'error')
      return reply.code(500).send({ result: { code: 500, message: 'simulated failure' } });
    const parsed = CreditB.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ result: { code: 400, message: 'invalid body' } });
    const { player_id, amount_cents, reference } = parsed.data;
    if (!seenB.has(reference)) {
      balancesB.set(player_id, (balancesB.get(player_id) ?? 0) + amount_cents);
      seenB.set(reference, amount_cents);
    }
    return { result: { code: 0, balance_cents: balancesB.get(player_id) ?? 0 } };
  });

  // The instance may carry the app's pino logger type; callers only need the base type.
  return app as unknown as FastifyInstance;
}

/** Signature Casino B expects; exported so tests and the integrations module build valid requests. */
export function signBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}
