import { createHmac } from 'node:crypto';
import type {
  AdapterConfig,
  AdapterEntry,
  CasinoAdapter,
  RewardRequest,
  Transport,
  TransportRequest,
} from './adapter';
import { createAdapterRegistry, createDefaultRegistry } from './registry'; // RED: module missing

/**
 * Shared adapter contract suite (MIO-050, MIO-057). One parameterised body runs against EVERY entry
 * of the default registry; a registered adapter with no profile here fails. The signers and the
 * fake casinos below are an independent oracle of each casino's wire protocol (docs/specs section 3).
 *
 * Mutations (each turns the named tests red):
 *  - verifySignature: replace the constant-time compare with `return 'valid'` -> INV-ADAPTER-SIG-*.
 *  - drop the `now - ts > 300 s` check -> INV-ADAPTER-WINDOW.
 *  - parseEvent: `Math.round(amount)` instead of rejecting a float -> INV-ADAPTER-INT-MINOR.
 *  - issueReward: classify a timeout as `rejected` -> INV-ADAPTER-TIMEOUT-UNKNOWN.
 *  - getRewardStatus: look up by the casino reference, not our key -> INV-ADAPTER-LOST-REPLY.
 *  - register(): skip the recoveryMode check -> INV-REGISTRY-RECOVERY-MODE.
 */

const NOW = new Date('2026-11-21T12:00:00.000Z');
const SECRET = 'whsec-test';
const hmac = (secret: string, msg: string) =>
  createHmac('sha256', secret).update(msg).digest('hex');

interface WebhookOpts {
  id?: string;
  player?: string;
  amount?: number;
  currency?: string;
  secret?: string;
  at?: Date;
  success?: boolean;
  signature?: string; // override
  omitSignature?: boolean;
}
interface Built {
  raw: string;
  headers: Record<string, string>;
}
interface FakeCasino {
  transport: Transport;
  issuedCount(): number;
}
interface FakeOpts {
  dropReply?: boolean;
  reject?: boolean;
}
interface Profile {
  webhook(o: WebhookOpts): Built;
  rawBody(raw: string, secret: string, at: Date): Built; // arbitrary body, validly signed
  expectedCanonical(o: { id: string; player: string; amount: number; at: Date }): object;
  fake(o?: FakeOpts): FakeCasino;
}

const PROFILES: Record<string, Profile> = {
  'casino-a': {
    webhook: (o) => {
      const at = o.at ?? NOW;
      const ts = Math.floor(at.getTime() / 1000);
      const raw = JSON.stringify({
        eventId: o.id ?? 'evt-1',
        playerId: o.player ?? 'pl-1',
        amount: { value: o.amount ?? 5000, currency: o.currency ?? 'EUR' },
        status: o.success === false ? 'FAILED' : 'SUCCESS',
        ts,
      });
      const headers: Record<string, string> = { 'x-a-timestamp': String(ts) };
      if (!o.omitSignature)
        headers['x-a-signature'] = o.signature ?? hmac(o.secret ?? SECRET, `${ts}.${raw}`);
      return { raw, headers };
    },
    rawBody: (raw, secret, at) => {
      const ts = Math.floor(at.getTime() / 1000);
      return {
        raw,
        headers: { 'x-a-timestamp': String(ts), 'x-a-signature': hmac(secret, `${ts}.${raw}`) },
      };
    },
    expectedCanonical: (o) => ({
      source: 'casino-a',
      external_event_id: o.id,
      type: 'deposit.succeeded',
      external_player_id: o.player,
      amount_minor: o.amount,
      currency: 'EUR',
      occurred_at: new Date(Math.floor(o.at.getTime() / 1000) * 1000).toISOString(),
    }),
    fake: (o = {}) => {
      const issued = new Map<string, string>();
      const transport: Transport = async (req: TransportRequest) => {
        if (req.method === 'POST' && req.url.endsWith('/casino-a/bonuses')) {
          const key = (req.body as { idempotencyKey: string }).idempotencyKey;
          if (o.reject) return { status: 422, body: { error: 'LIMIT_REACHED' } };
          if (!issued.has(key)) issued.set(key, `A-${issued.size + 1}`);
          if (o.dropReply) throw new Error('socket hang up'); // effect done, reply lost
          return { status: 200, body: { bonusId: issued.get(key), status: 'ISSUED' } };
        }
        if (req.method === 'GET' && req.url.includes('/casino-a/bonuses?idempotencyKey=')) {
          const key = decodeURIComponent(req.url.split('idempotencyKey=')[1] ?? '');
          return issued.has(key)
            ? { status: 200, body: { bonusId: issued.get(key), status: 'ISSUED' } }
            : { status: 404, body: { error: 'NOT_FOUND' } };
        }
        return { status: 404, body: {} };
      };
      return { transport, issuedCount: () => issued.size };
    },
  },
  'casino-b': {
    webhook: (o) => {
      const at = o.at ?? NOW;
      const data = {
        txn_id: o.id ?? 'evt-1',
        customer_ref: o.player ?? 'pl-1',
        amount_cents: o.amount ?? 5000,
        ccy: o.currency ?? 'EUR',
      };
      const type = o.success === false ? 'payment.refunded' : 'payment.completed';
      const sent_at = at.toISOString();
      const signed = `${sent_at}.${type}.${data.txn_id}.${data.customer_ref}.${data.amount_cents}.${data.ccy}`;
      const body: Record<string, unknown> = { type, data, sent_at };
      if (!o.omitSignature) body.signature = o.signature ?? hmac(o.secret ?? SECRET, signed);
      return { raw: JSON.stringify(body), headers: {} };
    },
    rawBody: (raw, secret, at) => {
      // Re-sign a hand-made data block: raw is the JSON of `data`.
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return { raw, headers: {} }; // malformed on purpose: nothing to wrap
      }
      const sent_at = at.toISOString();
      const signed = `${sent_at}.payment.completed.${data.txn_id}.${data.customer_ref}.${data.amount_cents}.${data.ccy}`;
      return {
        raw: JSON.stringify({
          type: 'payment.completed',
          data,
          sent_at,
          signature: hmac(secret, signed),
        }),
        headers: {},
      };
    },
    expectedCanonical: (o) => ({
      source: 'casino-b',
      external_event_id: o.id,
      type: 'deposit.succeeded',
      external_player_id: o.player,
      amount_minor: o.amount,
      currency: 'EUR',
      occurred_at: o.at.toISOString(),
    }),
    fake: (o = {}) => {
      const tickets = new Map<string, string>(); // idempotency key -> ticket
      const dropped = new Set<string>();
      const transport: Transport = async (req: TransportRequest) => {
        if (req.method === 'POST' && req.url.endsWith('/casino-b/v2/rewards')) {
          const key = (req.body as { idempotency_key: string }).idempotency_key;
          if (!tickets.has(key)) tickets.set(key, `T-${tickets.size + 1}`);
          if (o.dropReply && !dropped.has(key)) {
            // first POST of a key: effect done, reply lost. A later replay is a normal request.
            dropped.add(key);
            throw new Error('socket hang up');
          }
          return { status: 202, body: { ticket: tickets.get(key) } };
        }
        const m = /\/casino-b\/v2\/rewards\/(T-\d+)$/.exec(req.url);
        if (req.method === 'GET' && m)
          return o.reject
            ? { status: 200, body: { state: 'FAILED', code: 'LIMIT_REACHED' } }
            : { status: 200, body: { state: 'DONE', reward_ref: `R-${m[1]}` } };
        return { status: 404, body: {} };
      };
      return { transport, issuedCount: () => tickets.size };
    },
  },
};

const REQUEST: RewardRequest = {
  external_player_id: 'pl-1',
  reward: { type: 'bonus', amount_minor: 500, currency: 'EUR' },
};
const cfg = (transport: Transport, extra: Partial<AdapterConfig> = {}): AdapterConfig => ({
  baseUrl: 'http://casino.test',
  transport,
  timeoutMs: 50,
  ...extra,
});

describe('adapter registry', () => {
  const noop: AdapterEntry['create'] = () => ({}) as CasinoAdapter;

  it('INV-REGISTRY-RECOVERY-MODE: an adapter without a declared recovery mode is not registrable', () => {
    const reg = createAdapterRegistry();
    expect(() => reg.register({ type: 'x', create: noop } as unknown as AdapterEntry)).toThrow();
    expect(() =>
      reg.register({ type: 'x', recoveryMode: 'magic', create: noop } as unknown as AdapterEntry),
    ).toThrow();
    expect(reg.list()).toHaveLength(0);
    reg.register({ type: 'x', recoveryMode: 'native_lookup', create: noop });
    expect(reg.get('x')?.recoveryMode).toBe('native_lookup');
    expect(() =>
      reg.register({ type: 'x', recoveryMode: 'native_lookup', create: noop }),
    ).toThrow(); // duplicate type
  });

  it('INV-REGISTRY-DEFAULTS: casino-a is native lookup, casino-b is idempotent replay', () => {
    const reg = createDefaultRegistry();
    expect(reg.get('casino-a')?.recoveryMode).toBe('native_lookup');
    expect(reg.get('casino-b')?.recoveryMode).toBe('idempotent_replay');
  });
});

describe.each(
  createDefaultRegistry()
    .list()
    .map((e) => [e.type, e] as const),
)('adapter contract: %s', (type, entry) => {
  const profile = PROFILES[type];
  const adapter = () => entry.create(cfg(profile!.fake().transport));

  it('has a contract profile (a registered adapter must be exercised by this suite)', () => {
    expect(profile).toBeDefined();
  });

  it('INV-ADAPTER-SIG-ACCEPT: a correctly signed fresh event verifies', () => {
    const { raw, headers } = profile!.webhook({});
    expect(adapter().verifySignature(raw, headers, SECRET, NOW)).toBe('valid');
  });

  it('INV-ADAPTER-SIG-REJECT: missing, wrong-secret, other-tenant, tampered and malformed signatures are refused', () => {
    const a = adapter();
    const ok = profile!.webhook({});
    expect(a.verifySignature(ok.raw, ok.headers, 'another-tenants-secret', NOW)).toBe('invalid');
    const missing = profile!.webhook({ omitSignature: true });
    expect(a.verifySignature(missing.raw, missing.headers, SECRET, NOW)).toBe('missing');
    for (const bad of ['', 'zz', 'abcd', 'A'.repeat(64), '0'.repeat(63), '0'.repeat(65)]) {
      const w = profile!.webhook({ signature: bad });
      expect(() => a.verifySignature(w.raw, w.headers, SECRET, NOW)).not.toThrow();
      expect(a.verifySignature(w.raw, w.headers, SECRET, NOW)).not.toBe('valid');
    }
    const tampered = profile!.webhook({});
    const raw = tampered.raw.replace('5000', '9000');
    expect(a.verifySignature(raw, tampered.headers, SECRET, NOW)).toBe('invalid');
  });

  it('INV-ADAPTER-WINDOW: 299 s old verifies, 301 s old (and 301 s in the future) is stale, only with a valid MAC', () => {
    const a = adapter();
    const at = (s: number) => new Date(NOW.getTime() + s * 1000);
    for (const [offset, verdict] of [
      [-299, 'valid'],
      [-301, 'stale'],
      [301, 'stale'],
    ] as const) {
      const w = profile!.webhook({ at: at(offset) });
      expect(a.verifySignature(w.raw, w.headers, SECRET, NOW)).toBe(verdict);
    }
    const forged = profile!.webhook({ at: at(-301), signature: '0'.repeat(64) });
    expect(a.verifySignature(forged.raw, forged.headers, SECRET, NOW)).toBe('invalid');
  });

  it('INV-ADAPTER-MAPPING: a successful deposit maps to exactly the canonical event', () => {
    const w = profile!.webhook({ id: 'evt-9', player: 'pl-9', amount: 12345 });
    expect(adapter().parseEvent(w.raw, w.headers)).toEqual({
      kind: 'deposit',
      event: profile!.expectedCanonical({ id: 'evt-9', player: 'pl-9', amount: 12345, at: NOW }),
    });
  });

  it('INV-ADAPTER-INT-MINOR: a float or non-positive amount is rejected, never rounded', () => {
    const a = adapter();
    for (const amount of [10.5, 0.1, -5, 0]) {
      const w = profile!.webhook({ amount });
      expect(a.parseEvent(w.raw, w.headers)).toEqual({
        kind: 'rejected',
        reason: 'schema_invalid',
      });
    }
  });

  it('INV-ADAPTER-SCHEMA: malformed JSON and schema-invalid bodies are rejected with distinct reasons', () => {
    const a = adapter();
    const bad = profile!.rawBody('{not json', SECRET, NOW);
    expect(a.parseEvent(bad.raw, bad.headers)).toEqual({
      kind: 'rejected',
      reason: 'malformed_json',
    });
    const empty = profile!.rawBody('{"unexpected":true}', SECRET, NOW);
    expect(a.parseEvent(empty.raw, empty.headers)).toEqual({
      kind: 'rejected',
      reason: 'schema_invalid',
    });
    const noPlayer = profile!.webhook({ player: '' });
    expect(a.parseEvent(noPlayer.raw, noPlayer.headers)).toEqual({
      kind: 'rejected',
      reason: 'schema_invalid',
    });
  });

  it('INV-ADAPTER-IGNORED: an unsuccessful deposit or unknown event type is acknowledged and ignored', () => {
    const w = profile!.webhook({ success: false });
    expect(adapter().parseEvent(w.raw, w.headers)).toEqual({ kind: 'ignored' });
  });

  it('INV-ADAPTER-ISSUE: a reward is issued once with our key and reported issued or pending', async () => {
    const casino = profile!.fake();
    const a = entry.create(cfg(casino.transport));
    const r = await a.issueReward(REQUEST, 'redeem:r1');
    expect(['issued', 'pending']).toContain(r.kind);
    await a.issueReward(REQUEST, 'redeem:r1'); // same key again
    expect(casino.issuedCount()).toBe(1);
  });

  it('INV-ADAPTER-LOST-REPLY: effect done, reply (with the casino reference) lost: status by OUR key finds it, no second reward', async () => {
    const casino = profile!.fake({ dropReply: true });
    const a = entry.create(cfg(casino.transport));
    const r = await a.issueReward(REQUEST, 'redeem:r2');
    expect(r).toEqual({ kind: 'unknown' });
    expect(casino.issuedCount()).toBe(1);
    const status = await a.getRewardStatus('redeem:r2', REQUEST);
    expect(status.kind).toBe('issued');
    expect((status as { reference: string }).reference).toEqual(expect.any(String));
    expect(casino.issuedCount()).toBe(1);
  });

  it('INV-ADAPTER-TIMEOUT-UNKNOWN: a hung casino is `unknown`, never a rejection', async () => {
    const hang: Transport = () => new Promise(() => undefined);
    const r = await entry.create(cfg(hang, { timeoutMs: 20 })).issueReward(REQUEST, 'redeem:r3');
    expect(r).toEqual({ kind: 'unknown' });
    const boom: Transport = async () => {
      throw new Error('ECONNRESET');
    };
    expect(await entry.create(cfg(boom)).issueReward(REQUEST, 'redeem:r3')).toEqual({
      kind: 'unknown',
    });
    const fiveHundred: Transport = async () => ({ status: 500, body: {} });
    expect(await entry.create(cfg(fiveHundred)).issueReward(REQUEST, 'redeem:r3')).toEqual({
      kind: 'unknown',
    });
  });

  it('INV-ADAPTER-FINAL-REJECTION: a business rejection is final and classified as rejected', async () => {
    const casino = profile!.fake({ reject: true });
    const a = entry.create(cfg(casino.transport));
    const r = await a.issueReward(REQUEST, 'redeem:r4');
    const s = r.kind === 'rejected' ? r : await a.getRewardStatus('redeem:r4', REQUEST);
    expect(s.kind).toBe('rejected');
    expect((s as { code: string }).code).toEqual(expect.any(String));
  });

  it('INV-ADAPTER-STATUS-UNKNOWN-KEY: a native-lookup adapter reports not_found for a key it never sent', async () => {
    if (entry.recoveryMode !== 'native_lookup') return; // a replay adapter issues on replay by design
    const a = entry.create(cfg(profile!.fake().transport));
    expect(await a.getRewardStatus('redeem:never', REQUEST)).toEqual({ kind: 'not_found' });
  });
});
