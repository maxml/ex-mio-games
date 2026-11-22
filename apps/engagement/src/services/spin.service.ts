import { createHash } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  createEvent,
  scopedKey,
  ScopedKeyTooLong,
  type MySpinsResponse,
  type PublicWheel,
  type SpinConflictBody,
  type SpinResponse,
} from '@ex-mio/contracts';
import { currentAuth, Db } from '@ex-mio/service-kit';
import { currentTenant } from '@ex-mio/tenancy';
import {
  SEEDS,
  SpinCreditsRepository,
  SpinsRepository,
  WheelsRepository,
  type SeedProvider,
  type SpinRecord,
} from '../model/repositories';
import { emitPlayerEventAfterCommit } from './analytics';
import { selectSegment, toPublicWheel } from './wheel';

const conflict = (body: SpinConflictBody): ConflictException => new ConflictException(body);

const NO_CREDIT = (): ConflictException =>
  conflict({ message: 'no spin available', code: 'no_credit' });
const IN_PROGRESS = (): ConflictException =>
  conflict({
    message: 'the same request is still running, retry with the same key',
    code: 'in_progress',
  });

const UNIQUE_VIOLATION = '23505';

/** A stable UUID (version 8 layout) derived from an environment-scoped key. */
const uuidFromKey = (key: string): string => {
  const b = createHash('sha256').update(key).digest().subarray(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export interface SpinInput {
  idempotencyKey: string;
  creditId?: string;
  /** From the verified token's `sbx` claim (the controller); never from a body or a header. */
  sandbox?: boolean;
}

const toResponse = (s: SpinRecord): SpinResponse => ({
  spin_id: s.id,
  segment_index: s.segmentIndex,
  segment_label: s.segmentLabel,
  reward_coins: s.rewardCoins,
});

/**
 * The server-authoritative spin (docs/specs/engagement-ingest.md sections 2 and 8). The player is
 * the principal of the verified token, never input. One tenant transaction consumes ONE credit with
 * the conditional UPDATE, draws the segment from HMAC(seed, spin_id), inserts the spin and writes
 * `engagement.spin.completed` to the outbox: they commit or roll back together. Payments consumes
 * the event and credits the coins (D-1); nothing here calls it.
 */
@Injectable()
export class SpinService {
  /** Same-key requests running in this process: a duplicate gets 409 `in_progress` (D-3). */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly credits: SpinCreditsRepository,
    private readonly spins: SpinsRepository,
    private readonly wheels: WheelsRepository,
    @Inject(SEEDS) private readonly seeds: SeedProvider,
  ) {}

  async spin(input: SpinInput): Promise<SpinResponse> {
    const { tenantId, userId } = this.caller();
    // D-26: the environment is in every key (the token's `sbx` claim, never a request value).
    const sandbox = input.sandbox === true;
    // F4: the client's key is the only unbounded part. Both keys (flight here, spin in the tx) are
    // built from it, so a key that escapes past the bound is refused here, as a 4xx, before either.
    let flightKey: string;
    try {
      flightKey = scopedKey({
        kind: 'flight',
        tenantId,
        sandbox,
        parts: [userId, input.idempotencyKey],
      });
      scopedKey({ kind: 'spin', tenantId, sandbox, parts: [userId, input.idempotencyKey] });
    } catch (err) {
      if (err instanceof ScopedKeyTooLong) {
        throw new UnprocessableEntityException('Idempotency-Key is too long once escaped');
      }
      throw err;
    }
    if (this.inFlight.has(flightKey)) throw IN_PROGRESS();
    this.inFlight.add(flightKey);
    try {
      return await this.db.tenantTx((tx) => this.spinInTx(tx, tenantId, userId, input));
    } catch (err) {
      // Backstop for a duplicate in another process: the UNIQUE (tenant, user, operation) lost.
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw IN_PROGRESS();
      throw err;
    } finally {
      this.inFlight.delete(flightKey);
    }
  }

  private async spinInTx(
    tx: Parameters<Parameters<Db['tenantTx']>[0]>[0],
    tenantId: string,
    userId: string,
    input: SpinInput,
  ): Promise<SpinResponse> {
    // The stored operation id is the environment-scoped key; the spin id is derived from it, so
    // (tenant_id, id) is the dedupe key and a sandbox and a production request never collide (D-26).
    const operationId = scopedKey({
      kind: 'spin',
      tenantId,
      sandbox: input.sandbox === true,
      parts: [userId, input.idempotencyKey],
    });
    const existing = await this.spins.findByOperation(tx, { userId, operationId });
    if (existing) {
      // The same key with another credit_id is a different request: refused, nothing changes.
      if (input.creditId !== undefined && input.creditId !== existing.creditId) {
        throw new UnprocessableEntityException('Idempotency-Key was used with a different request');
      }
      return toResponse(existing);
    }

    // Credits are per environment, like wallets (D-13): a sandbox token spends only sandbox credits.
    const sandboxToken = input.sandbox === true;
    const credit = await this.credits.consume(tx, {
      userId,
      sandbox: sandboxToken,
      ...(input.creditId !== undefined ? { creditId: input.creditId } : {}),
    });
    if (!credit) {
      if (input.creditId !== undefined) {
        // 404 for a credit that is not the player's; theirs but not available is `no_credit`.
        const own = await this.credits.findOwn(tx, {
          userId,
          sandbox: sandboxToken,
          creditId: input.creditId,
        });
        if (!own) throw new NotFoundException('credit not found');
      }
      throw NO_CREDIT();
    }

    const table = await this.wheels.activeTable(tx, credit.wheelId);
    if (!table) throw new Error('no reward table for the credit wheel');
    const { version: seedVersion, seed } = this.seeds.current(tenantId);
    const spinId = uuidFromKey(operationId);
    const picked = selectSegment({ seed, seedVersion, spinId, table });
    const rewardCoins = picked.segment.reward.type === 'coins' ? picked.segment.reward.amount : 0;

    const record: SpinRecord = {
      id: spinId,
      userId,
      creditId: credit.id,
      operationId,
      seedVersion: picked.seedVersion,
      tableVersion: picked.tableVersion,
      hmac: picked.hmac,
      segmentIndex: picked.segmentIndex,
      segmentLabel: picked.segment.label,
      rewardCoins,
    };
    await this.spins.insert(tx, record);
    // X-3 / D-13: a spin is a sandbox spin when the token came through a sandbox credential or the
    // credit itself was granted from a sandbox deposit. Payments then credits the sandbox wallet and
    // meters nothing (X-2). The flag is on the envelope, never in the payload.
    const sandbox = input.sandbox === true || credit.sandbox === true;
    // Also for a `nothing` segment (0 coins): payments and metering key on the spin.
    await this.db.publish(
      tx,
      createEvent({
        type: 'engagement.spin.completed',
        tenantId,
        ...(sandbox ? { sandbox: true } : {}),
        payload: {
          spin_id: spinId,
          player_id: userId,
          reward_coins: rewardCoins,
          table_version: picked.tableVersion,
        },
      }),
    );
    // After the commit: the spin happened, with its reward and the environment it ran in.
    emitPlayerEventAfterCommit(tx, tenantId, userId, {
      event: 'engagement.spin_completed',
      props: { reward_coins: rewardCoins, sandbox },
    });
    return toResponse(record);
  }

  /** `GET /v1/me/spins`: the caller's own count of available credits. */
  async availableSpins(): Promise<MySpinsResponse> {
    const { userId } = this.caller();
    // Credits are per environment (D-13): the verified token's `sbx` claim picks which are counted.
    // `currentAuth()` throws without an auth context: fail closed, never default to production.
    const sandbox = currentAuth().sandbox === true;
    const available = await this.db.tenantTx((tx) =>
      this.credits.countAvailable(tx, { userId, sandbox }),
    );
    return { available };
  }

  /**
   * `GET /v1/wheel/:wheelId` and `GET /v1/wheel` (W-2, the tenant's active wheel when no id is
   * given): labels only, built from the stored table.
   */
  async wheel(wheelId?: string): Promise<PublicWheel> {
    const table = await this.db.tenantTx(async (tx) => {
      const id = wheelId ?? (await this.wheels.activeWheelId(tx));
      return id === undefined ? undefined : this.wheels.activeTable(tx, id);
    });
    if (!table) throw new NotFoundException('wheel not found');
    return toPublicWheel(table);
  }

  /** The tenant and the player come from the verified token's ambient context, nowhere else. */
  private caller(): { tenantId: string; userId: string } {
    const ctx = currentTenant();
    if (!ctx.principalId) throw new UnauthorizedException('player required');
    return { tenantId: ctx.tenantId, userId: ctx.principalId };
  }
}
