import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * This service's read copy of a tenant, built from `identity.tenant.created`.
 * `applied_count` counts how many times the event's effect ran: with the inbox
 * working it is exactly 1, however many times the broker delivers the message.
 */
@Entity({ name: 'tenant_projections' })
export class TenantProjectionEntity {
  @PrimaryColumn({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  slug!: string;

  @Column({ name: 'applied_count', type: 'integer', default: 1 })
  appliedCount!: number;
}
