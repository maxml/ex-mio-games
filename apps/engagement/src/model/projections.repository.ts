import { Injectable } from '@nestjs/common';
import type { TenantProjection } from '@ex-mio/contracts';
import type { Tx } from '@ex-mio/service-kit';
import { TenantProjectionEntity } from './tenant-projection.entity';

@Injectable()
export class ProjectionsRepository {
  /** Insert the tenant's projection, or count one more application of the event. */
  async applyTenantCreated(
    tx: Tx,
    input: { tenantId: string; name: string; slug: string },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO "tenant_projections" ("tenant_id", "name", "slug", "applied_count")
       VALUES ($1, $2, $3, 1)
       ON CONFLICT ("tenant_id") DO UPDATE
         SET "applied_count" = "tenant_projections"."applied_count" + 1,
             "name" = EXCLUDED."name", "slug" = EXCLUDED."slug"`,
      [input.tenantId, input.name, input.slug],
    );
  }

  /** The projection of the transaction's tenant. Row-level security picks the row. */
  async findOwn(tx: Tx): Promise<TenantProjection | null> {
    const row = await tx.getRepository(TenantProjectionEntity).find({ take: 1 });
    const found = row[0];
    return found
      ? {
          tenant_id: found.tenantId,
          name: found.name,
          slug: found.slug,
          applied_count: found.appliedCount,
        }
      : null;
  }
}
