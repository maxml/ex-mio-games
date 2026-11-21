import type {
  IssueResult,
  ResolvedRewardPort,
  RewardRequest,
  RewardStatus,
} from '@ex-mio/contracts';
import { rewardOfOrder } from '../redemptions/reward-request';
import {
  StoreRejection,
  type ApplyResult,
  type CasinoReport,
  type CoinsCall,
  type CoinsReply,
  type Operator,
  type RedemptionRecord,
  type RedemptionSaga,
  type SagaDeps,
  type Scope,
  type StateChange,
} from '../redemptions/ports';
import { SagaError } from '../redemptions/saga-error';
import {
  backoffDelayMs,
  ISSUING_LEASE_MS,
  MAX_ATTEMPTS,
  MAX_UNKNOWN_AGE_MS,
  PAYMENTS_RETRY_MS,
  POLL_INTERVAL_MS,
} from './backoff';

/** Consumer name of the inbox rows written by `onCasinoReport`. */
export const SAGA_CONSUMER = 'engagement.redemption-saga';

const keyOf = (id: string): string => `redeem:${id}`;

/** History causes of an ISSUING entry that was followed by a casino call (see `wasAsked`). */
const ISSUE_ATTEMPT = 'issue_attempt';
const RETRY_SAME_KEY = 'retry_same_key';
/** The casino was sent (or may have been sent) the request at least once. */
const wasAsked = (r: RedemptionRecord): boolean =>
  r.history.some(
    (h) => h.to === 'ISSUING' && (h.cause === ISSUE_ATTEMPT || h.cause === RETRY_SAME_KEY),
  );
const isIllegal = (err: unknown): boolean =>
  err instanceof Error && err.name === 'IllegalTransitionError';

/**
 * The redemption saga (spec sections 1 and 4.2). It holds no state of its own: every step is a
 * committed `store.apply`, then the next call, so a process killed anywhere resumes from the
 * store through `sweep`. Rules the code keeps:
 *  - no casino call before the reserve answered `ok`, and none while the row is not ISSUING with
 *    its attempt already committed;
 *  - coins go back through `releaseCoins` only, and only for a REJECTED row (the casino said no);
 *  - late or conflicting news never moves coins: it moves the row to NEEDS_REVIEW.
 */
export class RedemptionSagaService implements RedemptionSaga {
  constructor(private readonly deps: SagaDeps) {}

  now(): Date {
    return this.deps.clock.now();
  }

  // ---- the order and the inline reserve ------------------------------------------------------

  async redeem(
    scope: Scope,
    operationKey: string,
    itemId: string,
  ): Promise<{ redemption: RedemptionRecord; created: boolean }> {
    const placed = await this.deps.store.placeOrder(scope, { operationKey, itemId });
    if (!placed.created) {
      // A replay answers as the first call did and never asks payments again.
      if (placed.redemption.state === 'REJECTED_FUNDS')
        throw new StoreRejection('insufficient_funds');
      return placed;
    }
    const redemption = await this.reserve(placed.redemption, true);
    return { redemption, created: true };
  }

  /** The coin reserve, key `hold:{id}`. Inline in the POST, and again from the sweeper after the grace. */
  private async reserve(r: RedemptionRecord, inline: boolean): Promise<RedemptionRecord> {
    const now = this.deps.clock.now();
    let reply: CoinsReply;
    try {
      reply = await this.deps.coins.reserve({ ...this.call(r), amount: r.price }, `hold:${r.id}`);
    } catch {
      // Timeout or transport: the outcome is unknown, the SAME call is repeated later.
      if (!inline)
        await this.deps.store.reschedule(
          r.tenantId,
          r.id,
          'REQUESTED',
          new Date(now.getTime() + PAYMENTS_RETRY_MS),
        );
      return r;
    }

    if (reply.ok && reply.amount === r.price) {
      const res = await this.apply(r, {
        expectFrom: ['REQUESTED'],
        to: 'RESERVED',
        cause: 'reserved',
        nextAttemptAt: now,
      });
      return res.redemption;
    }
    if (reply.ok) return (await this.toReview(r, 'REQUESTED', 'hold_amount_mismatch')).redemption;
    if (reply.code === 'insufficient_funds') {
      const res = await this.apply(r, {
        expectFrom: ['REQUESTED'],
        to: 'REJECTED_FUNDS',
        cause: 'insufficient_funds',
        failureReason: 'insufficient_funds',
        reservation: 'release',
        nextAttemptAt: null,
      });
      if (inline && res.redemption.state === 'REJECTED_FUNDS')
        throw new StoreRejection('insufficient_funds');
      return res.redemption;
    }
    return (await this.toReview(r, 'REQUESTED', 'reserve_refused', `reserve_refused:${reply.code}`))
      .redemption;
  }

  // ---- the sweeper ---------------------------------------------------------------------------

  async sweep(now: Date): Promise<number> {
    const due = await this.deps.store.dueForSweep(now);
    let acted = 0;
    let failure: unknown;
    for (const { tenantId, id } of due) {
      try {
        if (await this.step(tenantId, id, now)) acted += 1;
      } catch (err) {
        // One bad redemption must not stall the others; the first error is raised after the pass.
        failure ??= err;
      }
    }
    if (failure !== undefined) throw failure;
    return acted;
  }

  /** One step for one redemption, from the state the store holds right now. */
  private async step(tenantId: string, id: string, now: Date): Promise<boolean> {
    const r = await this.deps.store.getForOperator(tenantId, id);
    if (!r) return false;
    if (r.nextAttemptAt && r.nextAttemptAt.getTime() > now.getTime()) return false; // another sweeper moved it
    switch (r.state) {
      case 'REQUESTED':
        await this.reserve(r, false);
        return true;
      case 'RESERVED':
        return this.issue(r, now);
      case 'ISSUING':
        // The lease expired: the worker died somewhere around the adapter call. The outcome is
        // unknown, never "not issued" (D3): the next step asks the casino by our key.
        return (
          await this.apply(r, {
            expectFrom: ['ISSUING'],
            to: 'UNKNOWN',
            cause: 'lease_expired',
            nextAttemptAt: now,
          })
        ).applied;
      case 'UNKNOWN':
        return this.inquire(r, now);
      case 'ISSUED':
        return this.capture(r, now);
      case 'REJECTED':
        return this.releaseCoins(r, now);
      default:
        return false;
    }
  }

  /**
   * The port of the order's tenant and ENVIRONMENT (X-6, D-12). `undefined` is "no adapter" (the
   * caller sends the order to review, coins held; the production adapter is never a fallback for a
   * sandbox order). A REJECTED promise (identity down) is transport: the same attempt is rescheduled,
   * never a review and never a refund; `'moved'` means the step is over for this pass.
   */
  private async portFor(
    r: RedemptionRecord,
    from: RedemptionRecord['state'],
    now: Date,
  ): Promise<ResolvedRewardPort | undefined | 'moved'> {
    try {
      return await this.deps.ports.forTenant(r.tenantId, { sandbox: r.sandbox });
    } catch {
      await this.deps.store.reschedule(
        r.tenantId,
        r.id,
        from,
        new Date(now.getTime() + PAYMENTS_RETRY_MS),
      );
      return 'moved';
    }
  }

  /** RESERVED -> ISSUING (committed, attempt counted, lease, request frozen) BEFORE the adapter is called. */
  private async issue(r: RedemptionRecord, now: Date): Promise<boolean> {
    const resolved = await this.portFor(r, 'RESERVED', now);
    if (resolved === 'moved') return true;
    // The casino's own id of the player comes from identity's link (D-20); `undefined` means erased
    // or never created: the coins stay held and a person decides. No id is ever guessed.
    let request: RewardRequest | undefined;
    try {
      request = await this.deps.requests.build({
        tenantId: r.tenantId,
        userId: r.playerId,
        reward: rewardOfOrder(r),
        sandbox: r.sandbox,
      });
    } catch {
      await this.deps.store.reschedule(
        r.tenantId,
        r.id,
        'RESERVED',
        new Date(now.getTime() + PAYMENTS_RETRY_MS),
      );
      return true;
    }
    if (!resolved) return this.blocked(r, 'no_adapter', request);
    if (!request) return this.blocked(r, 'player_unmapped');
    const won = await this.apply(r, {
      expectFrom: ['RESERVED'],
      to: 'ISSUING',
      cause: ISSUE_ATTEMPT,
      attemptsIncrement: true,
      rewardRequest: request,
      nextAttemptAt: new Date(now.getTime() + ISSUING_LEASE_MS),
    });
    if (!won.applied) return false; // another sweeper holds this attempt
    await this.callAdapter(won.redemption, request, resolved, now);
    return true;
  }

  /**
   * An order that cannot be issued at all (`no_adapter`, `player_unmapped`) goes to review with its
   * coins held and the casino never called. The state table has no RESERVED -> NEEDS_REVIEW pair, so
   * the order takes the legal road RESERVED -> ISSUING -> UNKNOWN -> NEEDS_REVIEW with causes that
   * say nothing was sent (`issue_blocked`): no attempt is counted, and `wasAsked` does not count it.
   */
  private async blocked(
    r: RedemptionRecord,
    reason: 'no_adapter' | 'player_unmapped',
    request?: RewardRequest,
  ): Promise<boolean> {
    const entered = await this.apply(r, {
      expectFrom: ['RESERVED'],
      to: 'ISSUING',
      cause: `issue_blocked:${reason}`,
      ...(request ? { rewardRequest: request } : {}),
      nextAttemptAt: null,
    });
    if (!entered.applied) return false;
    const unknown = await this.apply(entered.redemption, {
      expectFrom: ['ISSUING'],
      to: 'UNKNOWN',
      cause: `issue_blocked:${reason}`,
      nextAttemptAt: null,
    });
    if (!unknown.applied) return true;
    await this.toReview(unknown.redemption, 'UNKNOWN', reason);
    return true;
  }

  /** The adapter call for a row that is ISSUING with its attempt committed, and what it answered. */
  private async callAdapter(
    r: RedemptionRecord,
    request: RewardRequest,
    resolved: ResolvedRewardPort,
    now: Date,
  ): Promise<void> {
    let result: IssueResult;
    try {
      result = await resolved.port.issueReward(request, keyOf(r.id));
    } catch {
      result = { kind: 'unknown' };
    }
    switch (result.kind) {
      case 'issued': {
        const res = await this.apply(r, {
          expectFrom: ['ISSUING', 'UNKNOWN'],
          to: 'ISSUED',
          cause: 'casino_issued',
          casinoReference: result.external_ref,
          nextAttemptAt: now,
        });
        // Late news (F6): the row was released while the call was in flight. Coins went back,
        // the casino says it issued: a person decides, nothing moves by itself.
        if (
          !res.applied &&
          (res.redemption.state === 'REJECTED' || res.redemption.state === 'RELEASED')
        )
          await this.apply(res.redemption, {
            expectFrom: ['REJECTED', 'RELEASED'],
            to: 'NEEDS_REVIEW',
            cause: 'late_success_after_release',
            failureReason: 'late_success_after_release',
            nextAttemptAt: null,
          });
        return;
      }
      case 'rejected':
        await this.apply(r, {
          expectFrom: ['ISSUING', 'UNKNOWN'],
          to: 'REJECTED',
          cause: 'casino_rejected',
          failureReason: `casino_rejected:${result.reason}`,
          nextAttemptAt: now,
        });
        return;
      case 'pending':
        // A ticket: waiting, not failing. The ref is stored; polling consumes no attempt.
        await this.apply(r, {
          expectFrom: ['ISSUING'],
          to: 'UNKNOWN',
          cause: 'casino_pending',
          ...(result.external_ref ? { casinoReference: result.external_ref } : {}),
          nextAttemptAt: new Date(now.getTime() + POLL_INTERVAL_MS),
        });
        return;
      case 'unknown':
        await this.apply(r, {
          expectFrom: ['ISSUING'],
          to: 'UNKNOWN',
          cause: 'casino_unknown',
          nextAttemptAt: new Date(now.getTime() + backoffDelayMs(r.attempts, this.deps.random)),
        });
        return;
    }
  }

  /** UNKNOWN: ask the casino by OUR key, with the frozen request, and act on the answer. */
  private async inquire(r: RedemptionRecord, now: Date): Promise<boolean> {
    const request = r.rewardRequest;
    if (!request) return (await this.toReview(r, 'UNKNOWN', 'request_missing')).applied;
    const resolved = await this.portFor(r, 'UNKNOWN', now);
    if (resolved === 'moved') return true;
    if (!resolved) return (await this.toReview(r, 'UNKNOWN', 'no_adapter')).applied;
    const status = await this.lookup(resolved, r, request);
    switch (status.kind) {
      case 'issued':
        return (
          await this.apply(r, {
            expectFrom: ['UNKNOWN'],
            to: 'ISSUED',
            cause: 'lookup_issued',
            casinoReference: status.external_ref,
            nextAttemptAt: now,
          })
        ).applied;
      case 'rejected':
        return (
          await this.apply(r, {
            expectFrom: ['UNKNOWN'],
            to: 'REJECTED',
            cause: 'lookup_rejected',
            failureReason: `casino_rejected:${status.reason}`,
            nextAttemptAt: now,
          })
        ).applied;
      case 'not_found':
        if (r.attempts >= MAX_ATTEMPTS)
          return (await this.toReview(r, 'UNKNOWN', 'attempts_exhausted')).applied;
        if (this.tooOld(r, now))
          return (await this.toReview(r, 'UNKNOWN', 'unknown_too_long')).applied;
        return this.retrySameKey(r, request, resolved, now);
      case 'pending':
      case 'unknown':
        if (this.tooOld(r, now))
          return (await this.toReview(r, 'UNKNOWN', 'unknown_too_long')).applied;
        await this.deps.store.reschedule(
          r.tenantId,
          r.id,
          'UNKNOWN',
          new Date(now.getTime() + POLL_INTERVAL_MS),
        );
        return true;
    }
  }

  /** The casino has no record: the same key and the same frozen request go out again. */
  private async retrySameKey(
    r: RedemptionRecord,
    request: RewardRequest,
    resolved: ResolvedRewardPort,
    now: Date,
  ): Promise<boolean> {
    const won = await this.apply(r, {
      expectFrom: ['UNKNOWN'],
      to: 'ISSUING',
      cause: RETRY_SAME_KEY,
      attemptsIncrement: true,
      nextAttemptAt: new Date(now.getTime() + ISSUING_LEASE_MS),
    });
    if (!won.applied) return false;
    await this.callAdapter(won.redemption, request, resolved, now);
    return true;
  }

  private tooOld(r: RedemptionRecord, now: Date): boolean {
    const since = r.unknownSince ?? r.updatedAt;
    return now.getTime() - since.getTime() >= MAX_UNKNOWN_AGE_MS;
  }

  private async lookup(
    resolved: ResolvedRewardPort,
    r: RedemptionRecord,
    request: RewardRequest,
  ): Promise<RewardStatus> {
    try {
      return await resolved.port.getRewardStatus(keyOf(r.id), request);
    } catch {
      return { kind: 'unknown' }; // a lookup that fails is never a decision
    }
  }

  // ---- settling with payments ------------------------------------------------------------------

  /** ISSUED -> capture (key `capture:{id}`) -> COMPLETED. */
  private async capture(r: RedemptionRecord, now: Date): Promise<boolean> {
    let reply: CoinsReply;
    try {
      reply = await this.deps.coins.capture(this.call(r), `capture:${r.id}`);
    } catch {
      await this.deps.store.reschedule(
        r.tenantId,
        r.id,
        'ISSUED',
        new Date(now.getTime() + PAYMENTS_RETRY_MS),
      );
      return true;
    }
    if (reply.ok)
      return (
        await this.apply(r, {
          expectFrom: ['ISSUED'],
          to: 'COMPLETED',
          cause: 'captured',
          reservation: 'commit',
          nextAttemptAt: null,
        })
      ).applied;
    // D-20: `reserve_already_refunded` on a capture is CONSISTENT when our own order is already
    // RELEASED or REFUNDED (a concurrent path settled it first): nothing to review. In any other
    // state it is a real disagreement and goes to review. The row is re-read, never trusted from
    // the sweep's earlier read.
    if (reply.code === 'reserve_already_refunded') {
      const current = await this.deps.store.getForOperator(r.tenantId, r.id);
      if (current && (current.state === 'RELEASED' || current.state === 'REFUNDED')) return false;
    }
    // Payments says which conflicting state it holds (D-9): the code is kept in the history cause.
    return (await this.toReview(r, 'ISSUED', 'capture_refused', `capture_refused:${reply.code}`))
      .applied;
  }

  /**
   * THE release gate: the only place in the engagement service that asks payments to give coins
   * back. It is reached for a REJECTED row only, and a row is REJECTED only after the casino
   * answered `rejected` (or the operator path in `resolveReview` got that answer or a late
   * `not_found` from a fresh lookup).
   */
  private async releaseCoins(r: RedemptionRecord, now: Date): Promise<boolean> {
    if (r.state !== 'REJECTED') return false;
    let reply: CoinsReply;
    try {
      reply = await this.deps.coins.release(this.call(r), `release:${r.id}`);
    } catch {
      await this.deps.store.reschedule(
        r.tenantId,
        r.id,
        'REJECTED',
        new Date(now.getTime() + PAYMENTS_RETRY_MS),
      );
      return true;
    }
    if (reply.ok)
      return (
        await this.apply(r, {
          expectFrom: ['REJECTED'],
          to: 'RELEASED',
          cause: 'released',
          reservation: 'release',
          nextAttemptAt: null,
        })
      ).applied;
    // Payments holds nothing under this id and the casino was never asked (no ISSUING row in the
    // whole history): the refused reserve never made a hold, so there is nothing to give back,
    // and the stock unit and limit slot are returned now, once, by the store.
    if (reply.code === 'reserve_not_found' && !wasAsked(r))
      return (
        await this.apply(r, {
          expectFrom: ['REJECTED'],
          to: 'RELEASED',
          cause: 'released_no_hold',
          reservation: 'release',
          nextAttemptAt: null,
        })
      ).applied;
    return (await this.toReview(r, 'REJECTED', 'release_refused', `release_refused:${reply.code}`))
      .applied;
  }

  // ---- late and conflicting news -----------------------------------------------------------------

  async onCasinoReport(
    tenantId: string,
    id: string,
    report: CasinoReport,
    eventId: string,
  ): Promise<void> {
    const r = await this.deps.store.getForOperator(tenantId, id);
    if (!r) throw new SagaError('redemption_not_found');
    const dedupe = { consumer: SAGA_CONSUMER, eventId };
    const now = this.deps.clock.now();
    const review = (from: RedemptionRecord['state'][], reason: string) =>
      this.apply(r, {
        expectFrom: from,
        to: 'NEEDS_REVIEW',
        cause: reason,
        failureReason: reason,
        nextAttemptAt: null,
        dedupe,
      });

    switch (report.outcome) {
      case 'issued':
        if (r.state === 'UNKNOWN' || r.state === 'ISSUING')
          await this.apply(r, {
            expectFrom: ['UNKNOWN', 'ISSUING'],
            to: 'ISSUED',
            cause: 'report_issued',
            casinoReference: report.external_ref,
            nextAttemptAt: now,
            dedupe,
          });
        else if (r.state === 'REJECTED' || r.state === 'RELEASED')
          await review(['REJECTED', 'RELEASED'], 'late_success_after_release');
        return; // any other state is already past this news
      case 'rejected':
        if (r.state === 'UNKNOWN' || r.state === 'ISSUING')
          await this.apply(r, {
            expectFrom: ['UNKNOWN', 'ISSUING'],
            to: 'REJECTED',
            cause: 'report_rejected',
            failureReason: `casino_rejected:${report.reason}`,
            nextAttemptAt: now,
            dedupe,
          });
        else if (r.state === 'ISSUED' || r.state === 'COMPLETED')
          await review(['ISSUED', 'COMPLETED'], 'late_rejection_after_complete');
        return;
      case 'revoked':
        if (r.state === 'COMPLETED') await this.refund(r, dedupe);
        else if (r.state === 'ISSUED') await review(['ISSUED'], 'late_rejection_after_complete');
        return;
    }
  }

  /** COMPLETED -> refund (key `refund:{id}`) -> REFUNDED. A transport error throws: the report is redelivered. */
  private async refund(
    r: RedemptionRecord,
    dedupe: { consumer: string; eventId: string },
  ): Promise<void> {
    const reply = await this.deps.coins.refund(this.call(r), `refund:${r.id}`);
    if (reply.ok) {
      await this.apply(r, {
        expectFrom: ['COMPLETED'],
        to: 'REFUNDED',
        cause: 'refunded',
        nextAttemptAt: null,
        dedupe,
      });
      return;
    }
    await this.apply(r, {
      expectFrom: ['COMPLETED'],
      to: 'NEEDS_REVIEW',
      cause: `refund_refused:${reply.code}`,
      failureReason: 'refund_refused',
      nextAttemptAt: null,
      dedupe,
    });
  }

  // ---- the operator -------------------------------------------------------------------------------

  async replay(tenantId: string, id: string): Promise<RedemptionRecord> {
    const r = await this.deps.store.getForOperator(tenantId, id);
    if (!r) throw new SagaError('redemption_not_found');
    const res = await this.applyOrRefuse(r, {
      expectFrom: ['NEEDS_REVIEW'],
      to: 'UNKNOWN',
      cause: 'replay',
      attemptsReset: true,
      nextAttemptAt: this.deps.clock.now(),
    });
    return res.redemption;
  }

  async resolveReview(
    tenantId: string,
    id: string,
    input: { outcome: 'issued' | 'not_issued'; reason: string; operator: Operator },
  ): Promise<RedemptionRecord> {
    if (input.operator.role !== 'operator_admin') throw new SagaError('forbidden'); // X-15
    const r = await this.deps.store.getForOperator(tenantId, id);
    if (!r) throw new SagaError('redemption_not_found');
    if (r.state !== 'NEEDS_REVIEW') throw new SagaError('illegal_transition');
    const origin = [...r.history].reverse().find((h) => h.to === 'NEEDS_REVIEW')?.from ?? null;
    // F1 (L4 review): "the casino was never asked" is a property of the WHOLE history (no ISSUING
    // row), not of the latest review entry, so it survives a second round of review.
    const neverAsked = !wasAsked(r);
    const audit = `${input.operator.id}: ${input.reason}`;
    const now = this.deps.clock.now();

    if (input.outcome === 'issued') {
      // A review of an order the casino never saw has nothing to confirm.
      if (neverAsked) throw new SagaError('illegal_transition');
      // D-18: the operator's word alone never moves coins. A fresh lookup by our key must say
      // `issued`; `unknown`, `pending` and the rest leave the row in review.
      const status = await this.lookupForReview(r, origin);
      if (!status || status.kind !== 'issued')
        throw new SagaError('illegal_transition', 'issue_not_confirmed');
      return (
        await this.applyOrRefuse(r, {
          expectFrom: ['NEEDS_REVIEW'],
          to: 'ISSUED',
          cause: `operator_issued ${audit}`,
          casinoReference: status.external_ref,
          nextAttemptAt: now,
        })
      ).redemption;
    }

    if (!neverAsked) await this.requireBackedRelease(r, origin);
    return (
      await this.applyOrRefuse(r, {
        expectFrom: ['NEEDS_REVIEW'],
        to: 'REJECTED',
        cause: `operator_not_issued ${audit}`,
        failureReason: 'operator_not_issued',
        nextAttemptAt: now,
      })
    ).redemption;
  }

  /**
   * A fresh lookup for an operator decision, or `undefined` when none may be made (Q-6, D-15): on an
   * `idempotent_replay` casino a lookup RE-SENDS the issue, so it can issue the reward; for a review
   * entered after RELEASED, COMPLETED or a refused capture the coins are no longer held, so no
   * lookup is made at all. No adapter for the order's environment is also `undefined`. A rejected
   * registry promise (identity down) is transport and propagates: the operator retries.
   */
  private async lookupForReview(
    r: RedemptionRecord,
    origin: RedemptionRecord['state'] | null,
  ): Promise<RewardStatus | undefined> {
    const request = r.rewardRequest;
    if (!request) return undefined;
    const resolved = await this.deps.ports.forTenant(r.tenantId, { sandbox: r.sandbox });
    if (!resolved) return undefined;
    const coinsGone = origin === 'RELEASED' || origin === 'COMPLETED' || origin === 'ISSUED';
    if (resolved.info.recovery_mode === 'idempotent_replay' && coinsGone) return undefined;
    return this.lookup(resolved, r, request);
  }

  /**
   * The operator's word alone never releases coins. A fresh lookup must say `rejected`, or
   * `not_found` made at or after the issue deadline: the order's `firstIssuingAt` plus the tenant's
   * `info.issue_deadline_ms` (X-6), not a fixed 24 h.
   */
  private async requireBackedRelease(
    r: RedemptionRecord,
    origin: RedemptionRecord['state'] | null,
  ): Promise<void> {
    const lookupAt = this.deps.clock.now();
    const resolved = await this.deps.ports.forTenant(r.tenantId, { sandbox: r.sandbox });
    const status = resolved ? await this.lookupForReview(r, origin) : undefined;
    if (!resolved || !status) throw new SagaError('release_not_allowed');
    if (status.kind === 'rejected') return;
    if (status.kind === 'not_found') {
      const first = r.firstIssuingAt ?? r.history.find((h) => h.to === 'ISSUING')?.at;
      if (first && lookupAt.getTime() >= first.getTime() + resolved.info.issue_deadline_ms) return;
    }
    throw new SagaError('release_not_allowed');
  }

  // ---- helpers --------------------------------------------------------------------------------------

  private call(r: RedemptionRecord): CoinsCall {
    return { tenantId: r.tenantId, playerId: r.playerId, sandbox: r.sandbox, reserveId: r.id };
  }

  private apply(r: RedemptionRecord, change: StateChange): Promise<ApplyResult> {
    return this.deps.store.apply(r.tenantId, r.id, change);
  }

  private toReview(
    r: RedemptionRecord,
    from: RedemptionRecord['state'],
    reason: string,
    cause: string = reason,
  ): Promise<ApplyResult> {
    return this.apply(r, {
      expectFrom: [from],
      to: 'NEEDS_REVIEW',
      cause,
      failureReason: reason,
      nextAttemptAt: null,
    });
  }

  /** `apply` for an operator action: a refused or lost transition is `illegal_transition`. */
  private async applyOrRefuse(r: RedemptionRecord, change: StateChange): Promise<ApplyResult> {
    let res: ApplyResult;
    try {
      res = await this.apply(r, change);
    } catch (err) {
      if (isIllegal(err)) throw new SagaError('illegal_transition');
      throw err;
    }
    if (!res.applied) throw new SagaError('illegal_transition');
    return res;
  }
}
