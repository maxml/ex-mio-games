import type {
  CasinoRewardPort,
  EventEnvelope,
  IssueResult,
  RedemptionState,
  RewardRequest,
  RewardStatus,
} from '@ex-mio/contracts';
import type {
  ApplyResult,
  CoinsCall,
  CoinsPort,
  CoinsReply,
  RedemptionRecord,
  RedemptionSaga,
  RedemptionStore,
  SagaDeps,
  Scope,
  StateChange,
} from '../ports';
import { TestClock } from './clock';
import { MemoryStore } from './memory-store';

export { TestClock };

/** A simulated process death. The world decides when it happens; the saga cannot place it. */
export class Crash extends Error {
  constructor(readonly where: string) {
    super(`crash at ${where}`);
  }
}

// ---- fake casino (the shared port of casino-adapter.ts) ---------------------------------------------

export type CasinoBehaviour =
  | 'ok' // issued at once
  | 'reject' // definitive rejection, nothing issued
  | 'timeout_effect' // reward issued, reply lost -> unknown
  | 'timeout_noeffect' // nothing issued -> unknown
  | 'error500' // nothing issued -> unknown
  | 'unknown_code' // a rejection code the adapter does not know: unknown
  | 'pending_then_issued' // casino B: ticket now, `settle(key, 'issued')` later
  | 'pending_then_rejected' // casino B: ticket now, `settle(key, 'rejected')` later
  | 'pending_forever' // casino B: the ticket never settles
  | 'drop_reply'; // casino B: ticket created, the 202 reply was lost -> unknown

interface Ticket {
  ref: string;
  status: 'pending' | 'issued' | 'rejected';
  request: RewardRequest;
}

/**
 * Behaves like the casino side of the port. It does NOT dedupe by key unless asked: a double
 * `issueReward` is a double `effect`, so "one reward" assertions count `effects`, never map sizes.
 * `lookup: 'replay'` is casino B: no lookup by key; the casino only answers when the frozen request
 * is passed again, and a different request for a known key is `unknown`.
 */
export class FakeCasino implements CasinoRewardPort {
  readonly issueCalls: { key: string; request: RewardRequest }[] = [];
  readonly statusCalls: { key: string; request: RewardRequest }[] = [];
  readonly tickets = new Map<string, Ticket>();
  readonly rejectedKeys = new Set<string>();
  /** Issuances that really happened. */
  effects = 0;
  plan: CasinoBehaviour[] = [];
  sticky: CasinoBehaviour = 'ok';
  /** The status endpoint itself times out (answers `unknown`). */
  statusTimeout = false;
  dedupe = false;
  lookup: 'by_key' | 'replay' = 'by_key';
  private n = 0;

  private grant(key: string, request: RewardRequest): Ticket {
    const have = this.tickets.get(key);
    if (this.dedupe && have?.status === 'issued') return have;
    const t: Ticket = { ref: `ref-${++this.n}`, status: 'issued', request };
    this.tickets.set(key, t);
    this.effects += 1;
    return t;
  }

  private open(key: string, request: RewardRequest): Ticket {
    const have = this.tickets.get(key);
    if (have) return have;
    const t: Ticket = { ref: `ticket-${++this.n}`, status: 'pending', request };
    this.tickets.set(key, t);
    return t;
  }

  /** The casino finishes a pending ticket (test hook). */
  settle(key: string, outcome: 'issued' | 'rejected'): void {
    const t = this.tickets.get(key);
    if (!t || t.status !== 'pending') throw new Error(`no pending ticket for ${key}`);
    t.status = outcome;
    if (outcome === 'issued') this.effects += 1;
  }

  async issueReward(request: RewardRequest, key: string): Promise<IssueResult> {
    this.issueCalls.push({ key, request: structuredClone(request) });
    const b = this.plan.shift() ?? this.sticky;
    switch (b) {
      case 'ok':
        return { kind: 'issued', external_ref: this.grant(key, request).ref };
      case 'reject':
        this.rejectedKeys.add(key);
        return { kind: 'rejected', reason: 'player_not_eligible' };
      case 'timeout_effect':
        this.grant(key, request);
        return { kind: 'unknown' };
      case 'timeout_noeffect':
      case 'error500':
      case 'unknown_code':
        return { kind: 'unknown' };
      case 'pending_then_issued':
      case 'pending_then_rejected':
      case 'pending_forever':
        return { kind: 'pending', external_ref: this.open(key, request).ref };
      case 'drop_reply':
        this.open(key, request);
        return { kind: 'unknown' };
    }
  }

  async getRewardStatus(key: string, request: RewardRequest): Promise<RewardStatus> {
    this.statusCalls.push({ key, request: structuredClone(request) });
    if (this.statusTimeout) return { kind: 'unknown' };
    const t = this.tickets.get(key);
    if (this.lookup === 'replay' && t && JSON.stringify(t.request) !== JSON.stringify(request))
      return { kind: 'unknown' };
    if (t?.status === 'issued') return { kind: 'issued', external_ref: t.ref };
    if (t?.status === 'pending') return { kind: 'pending', external_ref: t.ref };
    if (t?.status === 'rejected' || this.rejectedKeys.has(key))
      return { kind: 'rejected', reason: 'player_not_eligible' };
    return { kind: 'not_found' };
  }
}

// ---- fake payments: the HTTP table of the payments service (decisions D-1, D-9) ----------------------

type ReserveState = 'reserved' | 'captured' | 'released' | 'refunded';
type Verb = 'reserve' | 'capture' | 'release' | 'refund';

/** The transport failed: the caller cannot tell whether the call had an effect. */
export class PaymentsDown extends Error {
  constructor() {
    super('payments unreachable');
  }
}

/**
 * Answers like `POST /internal/v1/coins/reserve|capture|release|refund`: 409 insufficient_funds,
 * 409 invalid_reserve_transition, 404 reserve_not_found, 409 operation_conflict. Capture, release
 * and refund are idempotent BY THE STATE of the reserve, whatever key they come with. Wallets are
 * keyed by (player, sandbox): a sandbox order never touches production coins.
 */
export class FakePayments implements CoinsPort {
  readonly wallets = new Map<string, { available: number; held: number; captured: number }>();
  readonly reserves = new Map<
    string,
    { state: ReserveState; amount: number; wallet: string; playerId: string }
  >();
  /** Every call that reached the service, with the key it carried. */
  readonly calls: { verb: Verb; key: string; reserveId: string; sandbox: boolean }[] = [];
  /** Calls that changed something. */
  readonly effects: Record<Verb, number> = { reserve: 0, capture: 0, release: 0, refund: 0 };
  down = false;

  private wallet(player: string, sandbox: boolean) {
    const k = `${player}|${sandbox}`;
    let w = this.wallets.get(k);
    if (!w) this.wallets.set(k, (w = { available: 0, held: 0, captured: 0 }));
    return w;
  }

  credit(player: string, amount: number, sandbox = false): void {
    this.wallet(player, sandbox).available += amount;
  }

  bal(player: string, sandbox = false) {
    return this.wallet(player, sandbox);
  }

  /** available + held + captured: what must stay equal to what was credited. */
  total(player: string, sandbox = false): number {
    const b = this.bal(player, sandbox);
    return b.available + b.held + b.captured;
  }

  holdState(reserveId: string): ReserveState | undefined {
    return this.reserves.get(reserveId)?.state;
  }

  callsOf(verb: Verb): { verb: Verb; key: string; reserveId: string; sandbox: boolean }[] {
    return this.calls.filter((c) => c.verb === verb);
  }

  private enter(verb: Verb, call: CoinsCall, key: string): void {
    if (this.down) throw new PaymentsDown();
    this.calls.push({ verb, key, reserveId: call.reserveId, sandbox: call.sandbox });
  }

  async reserve(call: CoinsCall & { amount: number }, key: string): Promise<CoinsReply> {
    this.enter('reserve', call, key);
    const have = this.reserves.get(call.reserveId);
    if (have) {
      const same = have.amount === call.amount && have.playerId === call.playerId;
      return same ? { ok: true, amount: have.amount } : { ok: false, code: 'operation_conflict' };
    }
    const w = this.wallet(call.playerId, call.sandbox);
    if (w.available < call.amount) return { ok: false, code: 'insufficient_funds' };
    w.available -= call.amount;
    w.held += call.amount;
    this.reserves.set(call.reserveId, {
      state: 'reserved',
      amount: call.amount,
      wallet: `${call.playerId}|${call.sandbox}`,
      playerId: call.playerId,
    });
    this.effects.reserve += 1;
    return { ok: true, amount: call.amount };
  }

  private move(
    verb: Exclude<Verb, 'reserve'>,
    from: ReserveState,
    to: ReserveState,
    call: CoinsCall,
    key: string,
  ): CoinsReply {
    this.enter(verb, call, key);
    const r = this.reserves.get(call.reserveId);
    if (!r) return { ok: false, code: 'reserve_not_found' };
    if (r.state === to) return { ok: true, amount: r.amount }; // stored result, any key
    if (r.state !== from) return { ok: false, code: 'invalid_reserve_transition' };
    const w = this.wallets.get(r.wallet)!;
    if (verb === 'capture') {
      w.held -= r.amount;
      w.captured += r.amount;
    } else if (verb === 'release') {
      w.held -= r.amount;
      w.available += r.amount;
    } else {
      w.captured -= r.amount;
      w.available += r.amount;
    }
    r.state = to;
    this.effects[verb] += 1;
    return { ok: true, amount: r.amount };
  }

  async capture(call: CoinsCall, key: string): Promise<CoinsReply> {
    return this.move('capture', 'reserved', 'captured', call, key);
  }
  async release(call: CoinsCall, key: string): Promise<CoinsReply> {
    return this.move('release', 'reserved', 'released', call, key);
  }
  async refund(call: CoinsCall, key: string): Promise<CoinsReply> {
    return this.move('refund', 'captured', 'refunded', call, key);
  }
}

// ---- the world -------------------------------------------------------------------------------------

interface Life {
  dead: boolean;
}

export interface CasinoCallAudit {
  key: string;
  /** The row at the moment the casino was called, read from the store, not reported by the saga. */
  state: RedemptionState;
  attempts: number;
  replayed: boolean;
}

export interface SagaFactory<S extends RedemptionSaga> {
  (deps: SagaDeps): S;
}

/**
 * Everything around the saga: store, payments, two casinos, a clock, and a way to kill the
 * process at a named point. The kill points are placed HERE, on the ports the saga calls, so the
 * saga cannot choose where it can be killed. A kill marks the process dead: every later call the
 * dead saga makes on any port throws `Crash`, so swallowing the first error cannot make a dead
 * process write anything. `restart()` builds a fresh saga over the same durable state.
 *
 * Kill points:
 *   after_place                      the order committed, nothing else happened
 *   after_commit:<STATE>             the store committed a change INTO <STATE>
 *   casino:after_effect              the casino issued, the reply never arrived
 *   payments:before:<verb>           the request was never sent
 *   payments:after_effect:<verb>     payments applied it, the reply never arrived
 *   (<verb> = reserve | capture | release | refund)
 *
 * Audit: every `issueReward` records the row as the store holds it at that instant. Tests call
 * `auditViolations()`: the adapter may only be called while the row is ISSUING with its attempt
 * already counted (the durable-before-call invariant).
 */
export class World<S extends RedemptionSaga> {
  readonly store: MemoryStore;
  readonly payments = new FakePayments();
  readonly casino = new FakeCasino();
  readonly sandboxCasino = new FakeCasino();
  readonly clock = new TestClock();
  readonly tenant = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
  readonly audit: CasinoCallAudit[] = [];
  saga!: S;
  restarts = 0;
  private life: Life = { dead: false };
  private killAt: string | null = null;
  random: () => number = () => 1;

  constructor(private readonly make: SagaFactory<S>) {
    this.store = new MemoryStore(() => this.clock.now());
    this.build();
  }

  get dead(): boolean {
    return this.life.dead;
  }

  private build(): void {
    const life: Life = { dead: false };
    this.life = life;
    const alive = () => {
      if (life.dead) throw new Crash('dead process');
    };
    const kill = (where: string) => {
      if (this.killAt === where) {
        this.killAt = null;
        life.dead = true;
        throw new Crash(where);
      }
    };
    const s = this.store;
    const store: RedemptionStore = {
      placeOrder: async (scope: Scope, input) => {
        alive();
        const res = await s.placeOrder(scope, input);
        if (res.created) kill('after_place');
        return res;
      },
      apply: async (tenantId: string, id: string, change: StateChange): Promise<ApplyResult> => {
        alive();
        const res = await s.apply(tenantId, id, change);
        if (res.applied) kill(`after_commit:${res.redemption.state}`);
        return res;
      },
      reschedule: async (...a: Parameters<RedemptionStore['reschedule']>) => {
        alive();
        return s.reschedule(...a);
      },
      getOwn: async (scope: Scope, id: string) => {
        alive();
        return s.getOwn(scope, id);
      },
      getForOperator: async (tenantId: string, id: string) => {
        alive();
        return s.getForOperator(tenantId, id);
      },
      listForOperator: async (tenantId: string, state?: RedemptionState) => {
        alive();
        return s.listForOperator(tenantId, state);
      },
      dueForSweep: async (now: Date) => {
        alive();
        return s.dueForSweep(now);
      },
    };

    const pay = async (verb: Verb, run: () => Promise<CoinsReply>): Promise<CoinsReply> => {
      alive();
      kill(`payments:before:${verb}`);
      const reply = await run();
      kill(`payments:after_effect:${verb}`);
      alive();
      return reply;
    };
    const coins: CoinsPort = {
      reserve: (c, k) => pay('reserve', () => this.payments.reserve(c, k)),
      capture: (c, k) => pay('capture', () => this.payments.capture(c, k)),
      release: (c, k) => pay('release', () => this.payments.release(c, k)),
      refund: (c, k) => pay('refund', () => this.payments.refund(c, k)),
    };

    const wrapCasino = (inner: FakeCasino): CasinoRewardPort => ({
      issueReward: async (request, key) => {
        alive();
        this.record(key);
        const res = await inner.issueReward(request, key);
        kill('casino:after_effect');
        alive();
        return res;
      },
      getRewardStatus: async (key, request) => {
        alive();
        return inner.getRewardStatus(key, request);
      },
    });
    const production = wrapCasino(this.casino);
    const sandbox = wrapCasino(this.sandboxCasino);

    this.saga = this.make({
      store,
      coins,
      adapterFor: (_tenant, isSandbox) => (isSandbox ? sandbox : production),
      rewardRequest: async (o: RedemptionRecord) => ({
        external_player_id: `ext-${o.playerId}`,
        reward: {
          type: o.reward.type,
          amount_minor: Number(o.reward.params['count'] ?? o.price),
          currency: 'EUR',
        },
      }),
      clock: this.clock,
      random: () => this.random(),
    });
  }

  private record(key: string): void {
    const id = key.startsWith('redeem:') ? key.slice('redeem:'.length) : '';
    const r = this.store.redemptions.get(id);
    this.audit.push({
      key,
      state: r?.state ?? ('MISSING' as RedemptionState),
      attempts: r?.attempts ?? 0,
      replayed: r?.history.some((h) => h.cause.startsWith('replay')) ?? false,
    });
  }

  /**
   * Empty when every adapter call happened while the store row was ISSUING, with a recorded
   * attempt, and no two calls of one key shared an attempt number (outside a replay).
   */
  auditViolations(): string[] {
    const out: string[] = [];
    const last = new Map<string, number>();
    for (const a of this.audit) {
      if (a.state !== 'ISSUING') out.push(`${a.key}: adapter called while the row was ${a.state}`);
      else if (a.attempts < 1) out.push(`${a.key}: no attempt recorded before the call`);
      else if (!a.replayed && a.attempts <= (last.get(a.key) ?? 0))
        out.push(`${a.key}: attempt ${a.attempts} used for a second call`);
      last.set(a.key, a.attempts);
    }
    return out;
  }

  /** Total real issuances over both casinos. */
  get effects(): number {
    return this.casino.effects + this.sandboxCasino.effects;
  }

  killOnce(where: string): void {
    this.killAt = where;
  }

  restart(): void {
    this.restarts += 1;
    this.build();
  }

  /** The process died while the caller was inside a request (the saga may have swallowed the error). */
  recoverIfDead(): boolean {
    if (!this.life.dead) return false;
    this.restart();
    return true;
  }

  /** Run sweeps, advancing time, restarting after a crash. */
  async settle(rounds = 24, stepMs = 6 * 60_000): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      try {
        await this.saga.sweep(this.clock.now());
      } catch (e) {
        if (!(e instanceof Crash)) throw e;
      }
      this.recoverIfDead();
      this.clock.advance(stepMs);
    }
  }

  /** Events the store wrote, by type. */
  events(type: string): EventEnvelope[] {
    return this.store.outbox.map((r) => r.envelope).filter((e) => e.type === type);
  }

  snapshot(id: string) {
    const r = this.store.redemptions.get(id)!;
    return {
      state: r.state,
      reservation: r.reservation,
      effects: this.effects,
      holdState: this.payments.holdState(id),
      balance: structuredClone(this.payments.bal(r.playerId, r.sandbox)),
    };
  }
}
