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
  uuidv7,
  type MySpinsResponse,
  type PublicWheel,
  type SpinConflictBody,
  type SpinResponse,
} from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { currentTenant } from '@ex-mio/tenancy';
import {
  SEEDS,
  SpinCreditsRepository,
  SpinsRepository,
  WheelsRepository,
  type SeedProvider,
  type SpinRecord,
} from '../model/repositories';
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

export interface SpinInput {
  idempotencyKey: string;
  creditId?: string;
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
    const flightKey = `${tenantId}|${userId}|${input.idempotencyKey}`;
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
    const existing = await this.spins.findByOperation(tx, {
      userId,
      operationId: input.idempotencyKey,
    });
    if (existing) {
      // The same key with another credit_id is a different request: refused, nothing changes.
      if (input.creditId !== undefined && input.creditId !== existing.creditId) {
        throw new UnprocessableEntityException('Idempotency-Key was used with a different request');
      }
      return toResponse(existing);
    }

    const credit = await this.credits.consume(tx, {
      userId,
      ...(input.creditId !== undefined ? { creditId: input.creditId } : {}),
    });
    if (!credit) {
      if (input.creditId !== undefined) {
        // 404 for a credit that is not the player's; theirs but not available is `no_credit`.
        const own = await this.credits.findOwn(tx, { userId, creditId: input.creditId });
        if (!own) throw new NotFoundException('credit not found');
      }
      throw NO_CREDIT();
    }

    const table = await this.wheels.activeTable(tx, credit.wheelId);
    if (!table) throw new Error('no reward table for the credit wheel');
    const { version: seedVersion, seed } = this.seeds.current(tenantId);
    const spinId = uuidv7();
    const picked = selectSegment({ seed, seedVersion, spinId, table });
    const rewardCoins = picked.segment.reward.type === 'coins' ? picked.segment.reward.amount : 0;

    const record: SpinRecord = {
      id: spinId,
      userId,
      creditId: credit.id,
      operationId: input.idempotencyKey,
      seedVersion: picked.seedVersion,
      tableVersion: picked.tableVersion,
      hmac: picked.hmac,
      segmentIndex: picked.segmentIndex,
      segmentLabel: picked.segment.label,
      rewardCoins,
    };
    await this.spins.insert(tx, record);
    // Also for a `nothing` segment (0 coins): payments and metering key on the spin.
    await this.db.publish(
      tx,
      createEvent({
        type: 'engagement.spin.completed',
        tenantId,
        payload: {
          spin_id: spinId,
          player_id: userId,
          reward_coins: rewardCoins,
          table_version: picked.tableVersion,
        },
      }),
    );
    return toResponse(record);
  }

  /** `GET /v1/me/spins`: the caller's own count of available credits. */
  async availableSpins(): Promise<MySpinsResponse> {
    const { userId } = this.caller();
    const available = await this.db.tenantTx((tx) => this.credits.countAvailable(tx, { userId }));
    return { available };
  }

  /** `GET /v1/wheel/:wheelId`: labels only, built from the stored table. */
  async wheel(wheelId: string): Promise<PublicWheel> {
    const table = await this.db.tenantTx((tx) => this.wheels.activeTable(tx, wheelId));
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
