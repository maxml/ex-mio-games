import {
  createEvent,
  parseEvent,
  type EventEnvelope,
  type IssueRewardRequest,
  type IssueRewardResult,
  type RewardAdapter,
  type RewardStatusResult,
} from '@ex-mio/contracts';
import type { Clock, CrashBoundary, CrashPoints } from '../ports';
import { MemoryStore } from './memory-store';

/** A simulated process death. The world catches it and "restarts" the saga. */
export class Crash extends Error {
  constructor(readonly where: string) {
    super(`crash at ${where}`);
  }
}

// ---- fake casino ---------------------------------------------------------------------

export type CasinoBehaviour =
  | 'ok'
  | 'reject' // definitive rejection, nothing issued
  | 'timeout_effect' // reward issued, reply lost -> outcome unknown
  | 'timeout_noeffect' // nothing issued, outcome unknown
  | 'error500' // nothing issued, outcome unknown
  | 'unknown_code'; // the adapter met a rejection code it does not know: unknown

export class FakeCasino implements RewardAdapter {
  readonly issueCalls: IssueRewardRequest[] = [];
  readonly rewards = new Map<string, string>(); // key -> reference
  readonly rejected = new Set<string>();
  plan: CasinoBehaviour[] = [];
  sticky: CasinoBehaviour = 'ok';
  statusDown = false;
  private n = 0;

  async issueReward(req: IssueRewardRequest): Promise<IssueRewardResult> {
    this.issueCalls.push(structuredClone(req));
    const b = this.plan.shift() ?? this.sticky;
    const issue = (): string => {
      const have = this.rewards.get(req.idempotencyKey);
      if (have) return have;
      const ref = `ref-${++this.n}`;
      this.rewards.set(req.idempotencyKey, ref);
      return ref;
    };
    switch (b) {
      case 'ok':
        return { outcome: 'issued', reference: issue() };
      case 'reject':
        this.rejected.add(req.idempotencyKey);
        return { outcome: 'rejected', code: 'player_not_eligible' };
      case 'timeout_effect':
        issue();
        return { outcome: 'unknown', detail: 'timeout' };
      case 'timeout_noeffect':
        return { outcome: 'unknown', detail: 'timeout' };
      case 'error500':
        return { outcome: 'unknown', detail: 'http 500' };
      case 'unknown_code':
        return { outcome: 'unknown', detail: 'unlisted rejection code' };
    }
  }

  async getRewardStatus(key: string): Promise<RewardStatusResult> {
    if (this.statusDown) return { outcome: 'unknown', detail: 'status endpoint down' };
    const ref = this.rewards.get(key);
    if (ref) return { outcome: 'issued', reference: ref };
    if (this.rejected.has(key)) return { outcome: 'rejected', code: 'player_not_eligible' };
    return { outcome: 'not_found' };
  }

  get rewardCount(): number {
    return this.rewards.size;
  }
}

// ---- fake payments (hold table of MIO-066) -------------------------------------------

type HoldState = 'HELD' | 'CAPTURED' | 'RELEASED' | 'REFUNDED';

export class FakePayments {
  readonly balances = new Map<string, { available: number; held: number; captured: number }>();
  readonly holds = new Map<string, { state: HoldState; amount: number; player: string }>();
  readonly inbox = new Set<string>();
  readonly outbox: { envelope: EventEnvelope; consumed: boolean }[] = [];
  releases = 0;
  refunds = 0;
  captures = 0;
  down = false;

  credit(player: string, amount: number): void {
    this.bal(player).available += amount;
  }

  bal(player: string): { available: number; held: number; captured: number } {
    let b = this.balances.get(player);
    if (!b) this.balances.set(player, (b = { available: 0, held: 0, captured: 0 }));
    return b;
  }

  /** available + held + captured: the quantity that must stay equal to what was credited. */
  total(player: string): number {
    const b = this.bal(player);
    return b.available + b.held + b.captured;
  }

  private emit(cmd: EventEnvelope, type: string, extra: Record<string, unknown> = {}): void {
    const p = cmd.payload as { redemption_id: string; player_id: string; sandbox: boolean };
    this.outbox.push({
      consumed: false,
      envelope: createEvent({
        type: type as never,
        tenantId: cmd.tenant_id,
        causationId: cmd.event_id,
        payload: {
          redemption_id: p.redemption_id,
          player_id: p.player_id,
          sandbox: p.sandbox,
          ...extra,
        } as never,
      }),
    });
  }

  /** One command, one transaction: inbox dedupe by event id, effect idempotent by operation id. */
  process(cmd: EventEnvelope): void {
    if (this.inbox.has(cmd.event_id)) return;
    this.inbox.add(cmd.event_id);
    const p = cmd.payload as { operation_id: string; redemption_id: string; player_id: string };
    const id = p.redemption_id;
    const hold = this.holds.get(id);
    const b = this.bal(p.player_id);
    const reject = (command: string, reason: string) =>
      this.emit(cmd, 'payments.hold.command_rejected', { command, reason });
    switch (cmd.type) {
      case 'engagement.hold.place': {
        const amount = (cmd.payload as { amount: number }).amount;
        if (hold) {
          this.emit(cmd, 'payments.hold.placed', { amount: hold.amount });
        } else if (b.available >= amount) {
          b.available -= amount;
          b.held += amount;
          this.holds.set(id, { state: 'HELD', amount, player: p.player_id });
          this.emit(cmd, 'payments.hold.placed', { amount });
        } else {
          this.emit(cmd, 'payments.hold.rejected', { reason: 'insufficient_funds' });
        }
        return;
      }
      case 'engagement.hold.capture':
        if (!hold) return reject('capture', 'hold_not_found');
        if (hold.state === 'RELEASED') return reject('capture', 'hold_already_released');
        if (hold.state === 'HELD') {
          b.held -= hold.amount;
          b.captured += hold.amount;
          hold.state = 'CAPTURED';
          this.captures += 1;
        }
        return this.emit(cmd, 'payments.hold.captured');
      case 'engagement.hold.release':
        if (!hold) return reject('release', 'hold_not_found');
        if (hold.state === 'CAPTURED' || hold.state === 'REFUNDED')
          return reject('release', 'hold_already_captured');
        if (hold.state === 'HELD') {
          b.held -= hold.amount;
          b.available += hold.amount;
          hold.state = 'RELEASED';
          this.releases += 1;
        }
        return this.emit(cmd, 'payments.hold.released');
      case 'engagement.hold.refund':
        if (!hold || hold.state === 'HELD' || hold.state === 'RELEASED')
          return reject('refund', 'hold_not_captured');
        if (hold.state === 'CAPTURED') {
          b.captured -= hold.amount;
          b.available += hold.amount;
          hold.state = 'REFUNDED';
          this.refunds += 1;
        }
        return this.emit(cmd, 'payments.hold.refunded');
    }
  }
}

// ---- the world -------------------------------------------------------------------------

export class TestClock implements Clock {
  constructor(public t = new Date('2026-11-22T10:00:00.000Z')) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export interface SagaLike {
  handle(event: EventEnvelope): Promise<void>;
  sweep(now: Date): Promise<number>;
}

export interface SagaFactory<S extends SagaLike> {
  (deps: {
    store: MemoryStore;
    adapters: { production: RewardAdapter; sandbox: RewardAdapter };
    clock: Clock;
    random: () => number;
    crash: CrashPoints;
  }): S;
}

/**
 * Everything around the saga: store, payments, two casinos, a relay that
 * delivers outbox commands to payments and payment events back to the saga
 * (at least once), and a way to kill the process at a named point.
 *
 * Kill points: the two saga boundaries ('after_issuing_committed',
 * 'after_casino_effect') and relay boundaries 'cmd:<verb>' (before the
 * command is delivered) and 'evt:<verb>' (before the event is consumed).
 */
export class World<S extends SagaLike> {
  readonly store: MemoryStore;
  readonly payments = new FakePayments();
  readonly casino = new FakeCasino();
  readonly sandboxCasino = new FakeCasino();
  readonly clock = new TestClock();
  readonly tenant = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
  saga!: S;
  restarts = 0;
  private killAt: string | null = null;
  /** Deliver every event twice (at-least-once). */
  duplicateDelivery = false;
  random: () => number = () => 1;

  constructor(private readonly make: SagaFactory<S>) {
    this.store = new MemoryStore(() => this.clock.now());
    this.build();
  }

  private build(): void {
    const crash: CrashPoints = { hit: (b: CrashBoundary) => this.maybeKill(b) };
    this.saga = this.make({
      store: this.store,
      adapters: { production: this.casino, sandbox: this.sandboxCasino },
      clock: this.clock,
      random: () => this.random(),
      crash,
    });
  }

  killOnce(where: string): void {
    this.killAt = where;
  }

  private maybeKill(where: string): void {
    if (this.killAt === where) {
      this.killAt = null;
      throw new Crash(where);
    }
  }

  restart(): void {
    this.restarts += 1;
    this.build();
  }

  /** One relay pass. Returns how many messages moved. */
  async relay(): Promise<number> {
    let moved = 0;
    if (!this.payments.down) {
      for (const row of this.store.outbox.filter((r) => !r.relayed)) {
        const type = row.envelope.type;
        if (!type.startsWith('engagement.hold.')) continue;
        this.maybeKill(`cmd:${type.split('.')[2]}`);
        this.payments.process(parseEvent(row.envelope));
        if (this.duplicateDelivery) this.payments.process(parseEvent(row.envelope));
        row.relayed = true; // marked after the effect: a crash in between means redelivery
        moved += 1;
      }
    }
    for (const row of this.payments.outbox.filter((r) => !r.consumed)) {
      this.maybeKill(`evt:${row.envelope.type.split('.')[2]}`);
      await this.saga.handle(parseEvent(row.envelope));
      if (this.duplicateDelivery) await this.saga.handle(parseEvent(row.envelope));
      row.consumed = true;
      moved += 1;
    }
    return moved;
  }

  /** Run relay + sweep rounds, advancing time, restarting after a crash. */
  async settle(rounds = 24, stepMs = 6 * 60_000): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      try {
        await this.relay();
        await this.saga.sweep(this.clock.now());
      } catch (e) {
        if (!(e instanceof Crash)) throw e;
        this.restart();
      }
      this.clock.advance(stepMs);
    }
  }

  /** Re-deliver every already consumed payments event (redelivery after a lost ack). */
  async redeliverAllEvents(): Promise<void> {
    for (const row of this.payments.outbox) await this.saga.handle(parseEvent(row.envelope));
  }

  /** Commands in the engagement outbox, by type. */
  commands(type: string): EventEnvelope[] {
    return this.store.outbox.map((r) => r.envelope).filter((e) => e.type === type);
  }

  snapshot(id: string) {
    const r = this.store.redemptions.get(id)!;
    return {
      state: r.state,
      reservation: r.reservation,
      rewards: this.casino.rewardCount + this.sandboxCasino.rewardCount,
      holdState: this.payments.holds.get(id)?.state,
      balance: structuredClone(this.payments.bal(r.playerId)),
    };
  }
}
