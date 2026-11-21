import { Injectable } from '@nestjs/common';
import type { Credit } from '@ex-mio/contracts';
import type { Tx } from '@ex-mio/service-kit';
import { CoinCreditEntity } from './coin-credit.entity';

function toCredit(e: CoinCreditEntity): Credit {
  return {
    id: e.id,
    player_id: e.playerId,
    amount: e.amount,
    created_at: e.createdAt.toISOString(),
  };
}

@Injectable()
export class CreditsRepository {
  async insert(
    tx: Tx,
    input: { id: string; tenantId: string; playerId: string; amount: number },
  ): Promise<Credit> {
    const repo = tx.getRepository(CoinCreditEntity);
    return toCredit(await repo.save(repo.create(input)));
  }

  /** The transaction's tenant's credits; row-level security does the filtering. */
  async list(tx: Tx): Promise<Credit[]> {
    const rows = await tx
      .getRepository(CoinCreditEntity)
      .find({ order: { createdAt: 'DESC', id: 'DESC' }, take: 100 });
    return rows.map(toCredit);
  }
}
