import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Wiring placeholder for the money path: one row per coin credit. The ledger of
 * balanced entries replaces this table; until then it exercises tenant isolation,
 * idempotency and the outbox end to end.
 */
@Entity({ name: 'coin_credits' })
export class CoinCreditEntity {
  // Composite key (tenant_id, id): another tenant's id is not revealed by a duplicate-key error.
  @PrimaryColumn({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'player_id', type: 'uuid' })
  playerId!: string;

  @Column({ type: 'integer' })
  amount!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
