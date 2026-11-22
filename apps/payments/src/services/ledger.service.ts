import { Inject, Injectable } from '@nestjs/common';
import {
  COIN_CURRENCY,
  RESERVE_COMMAND_OUTCOMES,
  createEvent,
  uuidv7,
  type CoinOperationResult,
  type ReserveCoinsRequest,
  type ReserveState,
} from '@ex-mio/contracts';
import type { IdempotentOutcome } from '@ex-mio/idempotency';
import { AuthorizationRefused, Db, type Tx } from '@ex-mio/service-kit';
import { currentTenant } from '@ex-mio/tenancy';
import { afterCommit, emitProductEvent } from '@ex-mio/logger';
import { LEDGER_FAULTS, type LedgerFaults } from '../model/ledger.faults';
import {
  LedgerRepository,
  type AccountKind,
  type Direction,
  type OperationType,
  type WalletAccounts,
} from '../model/ledger.repository';
import { LedgerError } from './ledger.errors';

type Command = 'capture' | 'release' | 'refund';
export type CoinOutcome = IdempotentOutcome<CoinOperationResult>;

interface Posting {
  accountId: string;
  kind: AccountKind;
  direction: Direction;
  amount: number;
}

/**
 * The order balances are updated in, whatever the command. Every transaction that touches several
 * balance rows takes their row locks in this one order, so parallel commands cannot deadlock.
 */
const LOCK_ORDER: Record<AccountKind, number> = {
  tenant_issuance: 0,
  player_available: 1,
  player_held: 2,
  tenant_redeemed: 3,
};

/** What each reserve command moves: the state it needs, the state it leaves, the legs it writes. */
const PHASES: Record<
  Command,
  {
    from: ReserveState;
    to: ReserveState;
    debit: AccountKind;
    credit: AccountKind;
    event: 'payments.coins.captured' | 'payments.coins.released' | 'payments.coins.refunded';
  }
> = {
  capture: {
    from: 'reserved',
    to: 'captured',
    debit: 'player_held',
    credit: 'tenant_redeemed',
    event: 'payments.coins.captured',
  },
  release: {
    from: 'reserved',
    to: 'released',
    debit: 'player_held',
    credit: 'player_available',
    event: 'payments.coins.released',
  },
  refund: {
    from: 'captured',
    to: 'refunded',
    debit: 'tenant_redeemed',
    credit: 'player_available',
    event: 'payments.coins.refunded',
  },
};

/** Capture, release and refund name the reserve; the controller takes the id from the path (X-4). */
export interface ReserveRef {
  reserve_id: string;
}

export interface SpinCredit {
  tenantId: string;
  spinId: string;
  playerId: string;
  amount: number;
  /** The producer's environment flag from the envelope (X-2/X-3): sandbox coins go to the sandbox wallet. */
  sandbox: boolean;
}

/**
 * Every coin movement. Each command runs in ONE database transaction (`Db.idempotent`): journal row and
 * legs, the balance changes, the reserve state change, the outbox event and the idempotency record
 * commit or roll back together.
 *
 * Rules that make the ledger safe under concurrency:
 *  - a balance is only changed by a conditional RELATIVE update (`amount = amount - n ... AND amount >= n`);
 *    no decision is made from a value read earlier, and the cache is never consulted (D-9);
 *  - the durable id of a business operation (`spin_id`, `reserve_id`) is the `operation_id` of its
 *    journal row; the unique constraint on it makes a repeat under any HTTP key return the first result;
 *  - a reserve changes state only through `UPDATE ... WHERE state = <expected>`; the loser of a race
 *    reads the state the winner left and answers by `RESERVE_COMMAND_OUTCOMES`.
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly db: Db,
    private readonly repo: LedgerRepository,
    @Inject(LEDGER_FAULTS) private readonly faults: LedgerFaults,
  ) {}

  reserve(input: ReserveCoinsRequest, key: string): Promise<CoinOutcome> {
    const { tenantId, principalId } = this.actor();
    return this.db.idempotent<CoinOperationResult>({
      principalId,
      operation: 'payments.coins.reserve',
      key,
      request: input,
      effect: (tx) => this.reserveEffect(tx, tenantId, principalId, input),
    });
  }

  capture(input: ReserveRef, key: string): Promise<CoinOutcome> {
    return this.command('capture', input, key);
  }

  release(input: ReserveRef, key: string): Promise<CoinOutcome> {
    return this.command('release', input, key);
  }

  refund(input: ReserveRef, key: string): Promise<CoinOutcome> {
    return this.command('refund', input, key);
  }

  /** Erasure (MIO-107): drop the only link between a person and a wallet. The ledger stays. */
  async eraseIdentityLink(playerId: string): Promise<void> {
    const { tenantId } = currentTenant();
    await this.db.tenantTx((tx) => this.repo.deleteLink(tx, tenantId, playerId));
  }

  /**
   * Credit the coins of one spin, inside the caller's transaction (the inbox consumer's). The spin id
   * is the operation id: the same spin again returns the first transaction; the same spin with other
   * parameters is `operation_conflict`.
   */
  async creditSpin(
    tx: Tx,
    input: SpinCredit,
  ): Promise<{ transactionId: string; created: boolean }> {
    const { tenantId, spinId, playerId, amount, sandbox } = input;
    const sameSpin = async () => {
      const existing = await this.repo.journalByOperation(tx, tenantId, 'spin_award', spinId);
      if (!existing) return null;
      const award = await this.repo.awardOf(tx, tenantId, existing.id);
      // The player is compared while the identity link exists; once erased only the amount can be.
      // The environment is part of the spin: the same spin id never moves between wallets.
      if (
        !award ||
        award.amount !== amount ||
        award.sandbox !== sandbox ||
        (award.playerId && award.playerId !== playerId)
      ) {
        throw new LedgerError('operation_conflict');
      }
      return { transactionId: existing.id, created: false };
    };

    const replay = await sameSpin();
    if (replay) return replay;

    const system = await this.repo.ensureSystemAccounts(tx, tenantId, sandbox);
    const wallet = await this.repo.ensureWallet(tx, tenantId, playerId, sandbox);
    const transactionId = uuidv7();
    const inserted = await this.repo.insertJournal(tx, {
      tenantId,
      id: transactionId,
      type: 'spin_award',
      operationId: spinId,
      createdBy: 'inbox:payments',
    });
    if (!inserted) {
      const winner = await sameSpin();
      if (!winner) throw new Error('spin award vanished after a unique conflict');
      return winner;
    }
    await this.repo.insertLegs(tx, tenantId, transactionId, [
      { accountId: system.issuance, direction: 'debit', amount },
      { accountId: wallet.available, direction: 'credit', amount },
    ]);
    await this.faults.hit('after_journal', tx);
    await this.applyPostings(tx, tenantId, [
      { accountId: system.issuance, kind: 'tenant_issuance', direction: 'debit', amount },
      { accountId: wallet.available, kind: 'player_available', direction: 'credit', amount },
    ]);
    await this.faults.hit('after_balance', tx);
    await this.db.publish(
      tx,
      createEvent({
        type: 'payments.coins.credited',
        tenantId,
        sandbox,
        payload: { credit_id: transactionId, player_id: playerId, amount },
      }),
    );
    await this.faults.hit('after_outbox', tx);
    // After the inbox consumer's commit: the player's coins exist. The actor is the player (an
    // internal id); an inbox message has no AuthContext. No amount of money, only coins.
    afterCommit(tx, () =>
      emitProductEvent({
        event: 'payments.coins_credited',
        tenant_id: tenantId,
        actor_type: 'player',
        actor_id: playerId,
        props: { source: 'spin', coins: amount, sandbox },
      }),
    );
    return { transactionId, created: true };
  }

  // ---- reserve --------------------------------------------------------------------------------

  private async reserveEffect(
    tx: Tx,
    tenantId: string,
    principalId: string,
    input: ReserveCoinsRequest,
  ): Promise<{ status: number; body: CoinOperationResult }> {
    const again = await this.reserveReplay(tx, tenantId, input);
    if (again) return { status: 200, body: again };

    // The HTTP boundary requires the flag (a missing one is a 400); only an explicit `true` selects the
    // sandbox wallet, so a caller that bypassed the boundary never reaches sandbox coins by accident.
    const wallet = await this.repo.walletByPlayer(
      tx,
      tenantId,
      input.player_id,
      input.sandbox === true,
    );
    // A player who never won anything in this environment has no wallet and no coins.
    if (!wallet) throw new LedgerError('insufficient_funds');

    const transactionId = uuidv7();
    const inserted = await this.repo.insertJournal(tx, {
      tenantId,
      id: transactionId,
      type: 'reserve',
      operationId: input.reserve_id,
      createdBy: `service:${principalId}`,
    });
    if (!inserted) {
      // Another request made this reserve first (a different key); answer with its result.
      const winner = await this.reserveReplay(tx, tenantId, input);
      if (!winner) throw new Error('reserve vanished after a unique conflict');
      return { status: 200, body: winner };
    }
    await this.repo.insertReserve(tx, {
      tenantId,
      id: input.reserve_id,
      walletId: wallet.walletId,
      amount: input.amount,
    });
    await this.repo.insertLegs(tx, tenantId, transactionId, [
      { accountId: wallet.available, direction: 'debit', amount: input.amount },
      { accountId: wallet.held, direction: 'credit', amount: input.amount },
    ]);
    await this.faults.hit('after_journal', tx);
    await this.applyPostings(
      tx,
      tenantId,
      [
        {
          accountId: wallet.available,
          kind: 'player_available',
          direction: 'debit',
          amount: input.amount,
        },
        { accountId: wallet.held, kind: 'player_held', direction: 'credit', amount: input.amount },
      ],
      'insufficient_funds',
    );
    await this.faults.hit('after_balance', tx);
    const body = await this.result(tx, tenantId, {
      operation: 'reserve',
      transactionId,
      reserveId: input.reserve_id,
      amount: input.amount,
      walletId: wallet.walletId,
    });
    await this.publishMovement(
      tx,
      tenantId,
      'payments.coins.reserved',
      body,
      input.player_id,
      wallet.sandbox,
    );
    await this.faults.hit('after_outbox', tx);
    return { status: 201, body };
  }

  /** The reserve already exists (same id): its first result, or `operation_conflict` if the parameters differ. */
  private async reserveReplay(
    tx: Tx,
    tenantId: string,
    input: ReserveCoinsRequest,
  ): Promise<CoinOperationResult | null> {
    const reserve = await this.repo.reserveById(tx, tenantId, input.reserve_id);
    if (!reserve) return null;
    const owner = await this.repo.playerOfWallet(tx, tenantId, reserve.walletId);
    if (
      reserve.amount !== input.amount ||
      reserve.sandbox !== (input.sandbox === true) ||
      (owner !== null && owner !== input.player_id)
    ) {
      throw new LedgerError('operation_conflict');
    }
    return this.storedResult(
      tx,
      tenantId,
      'reserve',
      input.reserve_id,
      reserve.walletId,
      reserve.amount,
    );
  }

  // ---- capture, release, refund ---------------------------------------------------------------

  private command(command: Command, input: ReserveRef, key: string): Promise<CoinOutcome> {
    const { tenantId, principalId } = this.actor();
    return this.db.idempotent<CoinOperationResult>({
      principalId,
      operation: `payments.coins.${command}`,
      key,
      request: input,
      effect: (tx) => this.commandEffect(tx, tenantId, principalId, command, input.reserve_id),
    });
  }

  private async commandEffect(
    tx: Tx,
    tenantId: string,
    principalId: string,
    command: Command,
    reserveId: string,
  ): Promise<{ status: number; body: CoinOperationResult }> {
    const phase = PHASES[command];
    // The state decides, in the database: only the call that really moves the reserve goes on.
    const moved = await this.repo.transitionReserve(tx, tenantId, reserveId, phase.from, phase.to);
    if (!moved) {
      const reserve = await this.repo.reserveById(tx, tenantId, reserveId);
      if (!reserve) throw new LedgerError('reserve_not_found');
      const outcome: string = RESERVE_COMMAND_OUTCOMES[reserve.state][command];
      if (outcome === 'replay') {
        const body = await this.storedResult(
          tx,
          tenantId,
          command,
          reserveId,
          reserve.walletId,
          reserve.amount,
        );
        return { status: 200, body };
      }
      if (outcome === 'apply') throw new Error('reserve changed state under a conditional update');
      throw new LedgerError(outcome as 'reserve_already_captured');
    }

    // The reserve's own wallet decides the environment: capture, release and refund never read the
    // request or the player to choose one, so sandbox coins cannot settle against production accounts.
    const wallet = await this.mustWallet(tx, tenantId, moved.walletId);
    const system = await this.repo.systemAccounts(tx, tenantId, wallet.sandbox);
    const accounts: Record<AccountKind, string | undefined> = {
      player_available: wallet.available,
      player_held: wallet.held,
      tenant_issuance: system.issuance,
      tenant_redeemed: system.redeemed,
    };
    const debit = accounts[phase.debit];
    const credit = accounts[phase.credit];
    if (!debit || !credit) throw new Error('ledger accounts are missing');

    const transactionId = uuidv7();
    const inserted = await this.repo.insertJournal(tx, {
      tenantId,
      id: transactionId,
      type: command,
      operationId: reserveId,
      createdBy: `service:${principalId}`,
    });
    if (!inserted)
      throw new Error(`${command} transaction exists for a reserve that was not moved`);
    await this.repo.insertLegs(tx, tenantId, transactionId, [
      { accountId: debit, direction: 'debit', amount: moved.amount },
      { accountId: credit, direction: 'credit', amount: moved.amount },
    ]);
    await this.faults.hit('after_journal', tx);
    await this.applyPostings(tx, tenantId, [
      { accountId: debit, kind: phase.debit, direction: 'debit', amount: moved.amount },
      { accountId: credit, kind: phase.credit, direction: 'credit', amount: moved.amount },
    ]);
    await this.faults.hit('after_balance', tx);
    const body = await this.result(tx, tenantId, {
      operation: command,
      transactionId,
      reserveId,
      amount: moved.amount,
      walletId: moved.walletId,
    });
    const owner = await this.repo.playerOfWallet(tx, tenantId, moved.walletId);
    // After an erasure the person is unknown; the wallet id is the stable pseudonym that is left.
    await this.publishMovement(
      tx,
      tenantId,
      phase.event,
      body,
      owner ?? moved.walletId,
      wallet.sandbox,
    );
    await this.faults.hit('after_outbox', tx);
    return { status: 201, body };
  }

  // ---- shared ---------------------------------------------------------------------------------

  private actor(): { tenantId: string; principalId: string } {
    const { tenantId, principalId } = currentTenant();
    if (!principalId) {
      throw new AuthorizationRefused({
        code: 'forbidden',
        message: 'a service identity is required',
      });
    }
    return { tenantId, principalId };
  }

  private async mustWallet(tx: Tx, tenantId: string, walletId: string): Promise<WalletAccounts> {
    const wallet = await this.repo.walletById(tx, tenantId, walletId);
    if (!wallet) throw new Error('wallet accounts are missing');
    return wallet;
  }

  /**
   * Apply the balance effect of the legs: credit-normal accounts grow on a credit and shrink on a
   * debit; the issuance account is debit-normal. Each change is one conditional relative UPDATE, in
   * the fixed lock order. A refused guard throws, which rolls the whole transaction back.
   */
  private async applyPostings(
    tx: Tx,
    tenantId: string,
    postings: Posting[],
    refusal: 'insufficient_funds' | null = null,
  ): Promise<void> {
    const ordered = [...postings].sort((a, b) => LOCK_ORDER[a.kind] - LOCK_ORDER[b.kind]);
    for (const p of ordered) {
      const grows = (p.kind === 'tenant_issuance') === (p.direction === 'debit');
      const delta = grows ? p.amount : -p.amount;
      const after = await this.repo.applyDelta(tx, tenantId, p.accountId, delta);
      if (after === null) {
        if (refusal && delta < 0) throw new LedgerError(refusal);
        throw new Error(`balance guard refused a change of ${delta} on ${p.kind}`);
      }
    }
  }

  private async result(
    tx: Tx,
    tenantId: string,
    r: {
      operation: CoinOperationResult['operation'];
      transactionId: string;
      reserveId: string | null;
      amount: number;
      walletId: string;
    },
  ): Promise<CoinOperationResult> {
    const balance = await this.repo.walletBalance(tx, tenantId, r.walletId);
    return {
      transaction_id: r.transactionId,
      operation: r.operation,
      reserve_id: r.reserveId,
      amount: r.amount,
      currency: COIN_CURRENCY,
      balance: { wallet_id: r.walletId, ...balance, currency: COIN_CURRENCY },
    };
  }

  /** The stored result of a phase that was already applied: its transaction id, the current balance. */
  private async storedResult(
    tx: Tx,
    tenantId: string,
    type: OperationType,
    reserveId: string,
    walletId: string,
    amount: number,
  ): Promise<CoinOperationResult> {
    const journal = await this.repo.journalByOperation(tx, tenantId, type, reserveId);
    if (!journal) throw new Error(`reserve is ${type}d but has no ${type} transaction`);
    return this.result(tx, tenantId, {
      operation: type as CoinOperationResult['operation'],
      transactionId: journal.id,
      reserveId,
      amount,
      walletId,
    });
  }

  private async publishMovement(
    tx: Tx,
    tenantId: string,
    type:
      | 'payments.coins.reserved'
      | 'payments.coins.captured'
      | 'payments.coins.released'
      | 'payments.coins.refunded',
    body: CoinOperationResult,
    playerId: string,
    sandbox: boolean,
  ): Promise<void> {
    await this.db.publish(
      tx,
      createEvent({
        type,
        tenantId,
        sandbox,
        payload: {
          transaction_id: body.transaction_id,
          player_id: playerId,
          wallet_id: body.balance.wallet_id,
          reserve_id: body.reserve_id as string,
          amount: body.amount,
          available_after: body.balance.available,
          held_after: body.balance.held,
        },
      }),
    );
  }
}
