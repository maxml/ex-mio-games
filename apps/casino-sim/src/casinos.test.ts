import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { buildServer, type DeliverFn } from './server';

/**
 * The two simulated casinos (MIO-051, MIO-052, MIO-053). Wire protocol: docs/specs/engagement-ingest.md
 * section 3. In-process via inject() with an injected `deliver` instead of real HTTP out; the
 * dropReply case needs a real socket and listens on port 0.
 *
 * Mutations:
 *  - sign with the wrong string / secret                         -> SIM-SIGNED-WEBHOOK-*.
 *  - `timeout` fault records no issuance                         -> SIM-FAULT-TIMEOUT-ISSUES.
 *  - faults not reset by /__reset                                -> SIM-FAULT-RESET.
 *  - fault routes served although faultsEnabled is false         -> SIM-FAULT-DISABLED.
 *  - B replay (same key) issues a second reward                  -> SIM-B-REPLAY.
 */

const hmac = (secret: string, msg: string) =>
  createHmac('sha256', secret).update(msg).digest('hex');
const SECRET = 'sim-secret';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function makeSim(opts: { faultsEnabled?: boolean } = {}) {
  const sent: Sent[] = [];
  const deliver: DeliverFn = async (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body });
    return { status: 200 };
  };
  const app = buildServer({ deliver, faultsEnabled: opts.faultsEnabled ?? true });
  return { app, sent };
}
const json = <T = unknown>(res: { json(): unknown }) => res.json() as T;

describe('casino simulators: deposit webhooks', () => {
  it('SIM-SIGNED-WEBHOOK-A: schema A, X-A-Signature = HMAC(secret, `${ts}.${rawBody}`), integer minor amount', async () => {
    const { app, sent } = makeSim();
    const res = await app.inject({
      method: 'POST',
      url: '/casino-a/__deposit',
      payload: {
        target_url: 'http://engagement/v1/integrations/acme/events',
        secret: SECRET,
        player_id: 'pl-1',
        amount_minor: 5000,
        currency: 'EUR',
        event_id: 'evt-1',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]!.body);
    expect(body).toMatchObject({
      eventId: 'evt-1',
      playerId: 'pl-1',
      amount: { value: 5000, currency: 'EUR' },
      status: 'SUCCESS',
    });
    expect(Number.isInteger(body.ts)).toBe(true);
    expect(sent[0]!.headers['x-a-timestamp']).toBe(String(body.ts));
    expect(sent[0]!.headers['x-a-signature']).toBe(hmac(SECRET, `${body.ts}.${sent[0]!.body}`));
    await app.close();
  });

  it('SIM-SIGNED-WEBHOOK-B: a different schema (snake_case, body-envelope signature, ISO sent_at, cents)', async () => {
    const { app, sent } = makeSim();
    await app.inject({
      method: 'POST',
      url: '/casino-b/__deposit',
      payload: {
        target_url: 'http://engagement/v1/integrations/bravo/events',
        secret: SECRET,
        player_id: 'pl-9',
        amount_minor: 750,
        currency: 'USD',
        event_id: 'txn-7',
      },
    });
    const body = JSON.parse(sent[0]!.body);
    expect(body).toMatchObject({
      type: 'payment.completed',
      data: { txn_id: 'txn-7', customer_ref: 'pl-9', amount_cents: 750, ccy: 'USD' },
    });
    expect(new Date(body.sent_at).toISOString()).toBe(body.sent_at);
    // F4: an injective encoding (JSON array of the fields), not a dotted string
    const signed = JSON.stringify([body.sent_at, 'payment.completed', 'txn-7', 'pl-9', 750, 'USD']);
    expect(body.signature).toBe(hmac(SECRET, signed));
    expect(sent[0]!.headers['x-a-signature']).toBeUndefined();
    await app.close();
  });

  // F5. The engagement adapter's default timeout is 5000 ms (casino-http.ts DEFAULT_TIMEOUT_MS). A
  // `timeout` fault with no delay_ms must outlast it, or L4's "timeout" is a slow success.
  // Mutation: restore `.default(1000)` on delay_ms for every kind.
  it('SIM-FAULT-TIMEOUT-DEFAULT: a timeout fault without delay_ms sleeps longer than the adapter default timeout', async () => {
    const { app } = makeSim();
    await app.inject({
      method: 'POST',
      url: '/__faults',
      payload: { casino: 'a', kind: 'timeout', times: 1 },
    });
    const real = globalThis.setTimeout;
    const delays: number[] = [];
    const spy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      delays.push(ms ?? 0);
      return real(fn, Math.min(ms ?? 0, 5), ...(rest as []));
    }) as typeof setTimeout);
    try {
      await app.inject({
        method: 'POST',
        url: '/casino-a/bonuses',
        payload: {
          idempotencyKey: 'redeem:t',
          playerId: 'pl-1',
          bonus: { type: 'bonus', amount: 500, currency: 'EUR' },
        },
      });
    } finally {
      spy.mockRestore();
    }
    expect(Math.max(0, ...delays)).toBeGreaterThan(5_000);
    await app.close();
  });

  it('SIM-FAULT-DUPLICATE: `duplicateDelivery` sends the same webhook N times', async () => {
    const { app, sent } = makeSim();
    await app.inject({
      method: 'POST',
      url: '/__faults',
      payload: { casino: 'a', kind: 'duplicateDelivery', times: 1, copies: 5 },
    });
    await app.inject({
      method: 'POST',
      url: '/casino-a/__deposit',
      payload: {
        target_url: 'http://e/x',
        secret: SECRET,
        player_id: 'p',
        amount_minor: 1000,
        event_id: 'dup-1',
      },
    });
    expect(sent).toHaveLength(5);
    expect(new Set(sent.map((s) => s.body)).size).toBe(1);
    await app.close();
  });

  it('SIM-FAULT-OUT-OF-ORDER: `outOfOrder` delivers the next two deposits in reverse order', async () => {
    const { app, sent } = makeSim();
    await app.inject({
      method: 'POST',
      url: '/__faults',
      payload: { casino: 'a', kind: 'outOfOrder', times: 1 },
    });
    for (const id of ['first', 'second']) {
      await app.inject({
        method: 'POST',
        url: '/casino-a/__deposit',
        payload: {
          target_url: 'http://e/x',
          secret: SECRET,
          player_id: 'p',
          amount_minor: 1000,
          event_id: id,
        },
      });
    }
    expect(sent.map((s) => JSON.parse(s.body).eventId)).toEqual(['second', 'first']);
    await app.close();
  });

  it('SIM-DEPOSIT-ABSENT-OPTIONS: an unsuccessful status can be sent for the ignore path', async () => {
    const { app, sent } = makeSim();
    await app.inject({
      method: 'POST',
      url: '/casino-a/__deposit',
      payload: {
        target_url: 'http://e/x',
        secret: SECRET,
        player_id: 'p',
        amount_minor: 1000,
        status: 'FAILED',
      },
    });
    expect(JSON.parse(sent[0]!.body).status).toBe('FAILED');
    await app.close();
  });
});

describe('casino A: synchronous reward API, native lookup by our key', () => {
  const issue = (app: ReturnType<typeof makeSim>['app'], key: string, player = 'pl-1') =>
    app.inject({
      method: 'POST',
      url: '/casino-a/bonuses',
      payload: {
        idempotencyKey: key,
        playerId: player,
        bonus: { type: 'bonus', amount: 500, currency: 'EUR' },
      },
    });

  it('SIM-A-ISSUE: returns the final state at once; the reward is in the issued list; the same key issues once', async () => {
    const { app } = makeSim();
    const a = await issue(app, 'redeem:1');
    expect(a.statusCode).toBe(200);
    expect(json<{ status: string; bonusId: string }>(a)).toMatchObject({
      status: 'ISSUED',
      bonusId: expect.any(String),
    });
    const b = await issue(app, 'redeem:1');
    expect(json<{ bonusId: string }>(b).bonusId).toBe(json<{ bonusId: string }>(a).bonusId);
    const list = json<Array<{ key: string }>>(
      await app.inject({ method: 'GET', url: '/__issued?casino=a' }),
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: 'redeem:1', player_id: 'pl-1' });
    await app.close();
  });

  it('SIM-A-LOOKUP: lookup by OUR key finds it; an unknown key is 404', async () => {
    const { app } = makeSim();
    await issue(app, 'redeem:2');
    const hit = await app.inject({
      method: 'GET',
      url: '/casino-a/bonuses?idempotencyKey=redeem%3A2',
    });
    expect(hit.statusCode).toBe(200);
    const miss = await app.inject({ method: 'GET', url: '/casino-a/bonuses?idempotencyKey=nope' });
    expect(miss.statusCode).toBe(404);
    await app.close();
  });

  it('SIM-FAULT-ERROR500: error500 answers 500 and issues nothing', async () => {
    const { app } = makeSim();
    await app.inject({
      method: 'POST',
      url: '/__faults',
      payload: { casino: 'a', kind: 'error500', times: 1 },
    });
    expect((await issue(app, 'redeem:3')).statusCode).toBe(500);
    expect(
      json<unknown[]>(await app.inject({ method: 'GET', url: '/__issued?casino=a' })),
    ).toHaveLength(0);
    expect((await issue(app, 'redeem:3')).statusCode).toBe(200); // the fault was for the next 1 call only
    await app.close();
  });

  it('SIM-FAULT-REJECT: reject is a final business rejection (422) and issues nothing', async () => {
    const { app } = makeSim();
    await app.inject({
      method: 'POST',
      url: '/__faults',
      payload: { casino: 'a', kind: 'reject', times: 1 },
    });
    const res = await issue(app, 'redeem:4');
    expect(res.statusCode).toBe(422);
    expect(json<{ error: string }>(res).error).toEqual(expect.any(String));
    expect(
      json<unknown[]>(await app.inject({ method: 'GET', url: '/__issued?casino=a' })),
    ).toHaveLength(0);
    await app.close();
  });

  it('SIM-FAULT-TIMEOUT-ISSUES: timeout hangs past the caller but the reward IS issued and recorded (ambiguous, not lost)', async () => {
    const { app } = makeSim();
    await app.inject({
      method: 'POST',
      url: '/__faults',
      payload: { casino: 'a', kind: 'timeout', times: 1, delay_ms: 150 },
    });
    const started = Date.now();
    await issue(app, 'redeem:5');
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    const list = json<unknown[]>(await app.inject({ method: 'GET', url: '/__issued?casino=a' }));
    expect(list).toHaveLength(1);
    await app.close();
  });

  it('SIM-FAULT-SLOW: slow delays then behaves normally', async () => {
    const { app } = makeSim();
    await app.inject({
      method: 'POST',
      url: '/__faults',
      payload: { casino: 'a', kind: 'slow', times: 1, delay_ms: 120 },
    });
    const started = Date.now();
    const res = await issue(app, 'redeem:6');
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('SIM-FAULT-PLAYER: a fault can target one player only', async () => {
    const { app } = makeSim();
    await app.inject({
      method: 'POST',
      url: '/__faults',
      payload: { casino: 'a', kind: 'error500', times: 5, player_id: 'victim' },
    });
    expect((await issue(app, 'redeem:7', 'someone-else')).statusCode).toBe(200);
    expect((await issue(app, 'redeem:8', 'victim')).statusCode).toBe(500);
    await app.close();
  });

  it('SIM-FAULT-DROP-REPLY: effect done, connection closed before the reply: the caller never sees the reference', async () => {
    const { app } = makeSim();
    await app.inject({
      method: 'POST',
      url: '/__faults',
      payload: { casino: 'a', kind: 'dropReply', times: 1 },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    await expect(
      fetch(`http://127.0.0.1:${port}/casino-a/bonuses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: 'redeem:9',
          playerId: 'p',
          bonus: { type: 'bonus', amount: 1, currency: 'EUR' },
        }),
      }),
    ).rejects.toThrow();
    const list = json<Array<{ key: string }>>(
      await app.inject({ method: 'GET', url: '/__issued?casino=a' }),
    );
    expect(list.map((i) => i.key)).toEqual(['redeem:9']);
    await app.close();
  });
});

describe('casino B: asynchronous ticket API, idempotent replay', () => {
  const issue = (app: ReturnType<typeof makeSim>['app'], key: string) =>
    app.inject({
      method: 'POST',
      url: '/casino-b/v2/rewards',
      payload: {
        idempotency_key: key,
        customer_ref: 'pl-1',
        reward: { type: 'bonus', amount_cents: 500, ccy: 'EUR' },
      },
    });

  it('SIM-B-ASYNC: 202 with a ticket; status is pending until settled, then done with a reference', async () => {
    const { app } = makeSim();
    const res = await issue(app, 'redeem:b1');
    expect(res.statusCode).toBe(202);
    const { ticket } = json<{ ticket: string }>(res);
    const pending = json<{ state: string }>(
      await app.inject({ method: 'GET', url: `/casino-b/v2/rewards/${ticket}` }),
    );
    expect(pending.state).toBe('PENDING');
    await app.inject({ method: 'POST', url: '/casino-b/__settle' });
    const done = json<{ state: string; reward_ref: string }>(
      await app.inject({ method: 'GET', url: `/casino-b/v2/rewards/${ticket}` }),
    );
    expect(done).toMatchObject({ state: 'DONE', reward_ref: expect.any(String) });
    await app.close();
  });

  it('SIM-B-REPLAY: re-sending the same key returns the original ticket and issues nothing new', async () => {
    const { app } = makeSim();
    const a = json<{ ticket: string }>(await issue(app, 'redeem:b2'));
    const b = json<{ ticket: string }>(await issue(app, 'redeem:b2'));
    expect(b.ticket).toBe(a.ticket);
    expect(
      json<unknown[]>(await app.inject({ method: 'GET', url: '/__issued?casino=b' })),
    ).toHaveLength(1);
    await app.close();
  });

  it('SIM-B-NO-LOOKUP: B has no lookup by our key (that is why it needs replay)', async () => {
    const { app } = makeSim();
    expect((await issue(app, 'redeem:b3')).statusCode).toBe(202);
    const res = await app.inject({
      method: 'GET',
      url: '/casino-b/v2/rewards?idempotency_key=redeem%3Ab3',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('SIM-FAULT-REJECT-B: reject makes the ticket FAILED with a code once settled', async () => {
    const { app } = makeSim();
    await app.inject({
      method: 'POST',
      url: '/__faults',
      payload: { casino: 'b', kind: 'reject', times: 1 },
    });
    const { ticket } = json<{ ticket: string }>(await issue(app, 'redeem:b4'));
    await app.inject({ method: 'POST', url: '/casino-b/__settle' });
    const st = json<{ state: string; code: string }>(
      await app.inject({ method: 'GET', url: `/casino-b/v2/rewards/${ticket}` }),
    );
    expect(st).toMatchObject({ state: 'FAILED', code: expect.any(String) });
    await app.close();
  });
});

describe('fault plan hygiene', () => {
  it('SIM-FAULT-RESET: /__reset clears fault plans and issued rewards between tests', async () => {
    const { app } = makeSim();
    await app.inject({
      method: 'POST',
      url: '/__faults',
      payload: { casino: 'a', kind: 'error500', times: 99 },
    });
    await app.inject({
      method: 'POST',
      url: '/casino-b/v2/rewards',
      payload: {
        idempotency_key: 'k',
        customer_ref: 'p',
        reward: { type: 'bonus', amount_cents: 1, ccy: 'EUR' },
      },
    });
    expect((await app.inject({ method: 'POST', url: '/__reset' })).statusCode).toBe(200);
    const res = await app.inject({
      method: 'POST',
      url: '/casino-a/bonuses',
      payload: {
        idempotencyKey: 'x',
        playerId: 'p',
        bonus: { type: 'bonus', amount: 1, currency: 'EUR' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(
      json<unknown[]>(await app.inject({ method: 'GET', url: '/__issued?casino=b' })),
    ).toHaveLength(0);
    await app.close();
  });

  it('SIM-FAULT-DISABLED: with faults disabled (the default outside the compose network) the control routes do not exist', async () => {
    const enabled = makeSim({ faultsEnabled: true }).app; // the same routes DO exist when enabled
    expect((await enabled.inject({ method: 'POST', url: '/__reset' })).statusCode).toBe(200);
    await enabled.close();
    const { app } = makeSim({ faultsEnabled: false });
    for (const [method, url] of [
      ['POST', '/__faults'],
      ['POST', '/__reset'],
      ['GET', '/__issued'],
    ] as const) {
      expect((await app.inject({ method, url, payload: {} })).statusCode).toBe(404);
    }
    await app.close();
  });
});
