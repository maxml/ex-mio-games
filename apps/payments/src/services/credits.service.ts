import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createEvent, uuidv7, type CreateCreditRequest, type Credit } from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { currentTenant } from '@ex-mio/tenancy';
import { CreditsRepository } from '../model/credits.repository';

export interface CreditResult {
  status: number;
  body: Credit;
  replayed: boolean;
}

@Injectable()
export class CreditsService {
  constructor(
    private readonly db: Db,
    private readonly credits: CreditsRepository,
  ) {}

  /**
   * Credit coins to a player, at most once per Idempotency-Key. The credit row,
   * the stored response and the outbox event commit in one transaction.
   */
  async credit(input: CreateCreditRequest, idempotencyKey: string): Promise<CreditResult> {
    const { tenantId, principalId } = currentTenant();
    if (!principalId) throw new UnauthorizedException('principal required');
    return this.db.idempotent<Credit>({
      principalId,
      operation: 'payments.credit',
      key: idempotencyKey,
      request: input,
      effect: async (tx) => {
        const credit = await this.credits.insert(tx, {
          id: uuidv7(),
          tenantId,
          playerId: input.player_id,
          amount: input.amount,
        });
        await this.db.publish(
          tx,
          createEvent({
            type: 'payments.coins.credited',
            tenantId,
            payload: { credit_id: credit.id, player_id: credit.player_id, amount: credit.amount },
          }),
        );
        return { status: 201, body: credit };
      },
    });
  }

  list(): Promise<Credit[]> {
    return this.db.tenantTx((tx) => this.credits.list(tx));
  }
}
