import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * The tenant registry. A platform table: it has no `tenant_id` column and no
 * row-level security, because it IS the list of tenants. Only platform-admin
 * endpoints touch it.
 */
@Entity({ name: 'tenants' })
export class TenantEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', unique: true })
  slug!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
