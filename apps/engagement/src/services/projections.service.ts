import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantCreatedV1, type EventEnvelope, type TenantProjection } from '@ex-mio/contracts';
import { Db, type Tx } from '@ex-mio/service-kit';
import { ProjectionsRepository } from '../model/projections.repository';

@Injectable()
export class ProjectionsService {
  constructor(
    private readonly db: Db,
    private readonly projections: ProjectionsRepository,
  ) {}

  /** Event handler: runs inside the inbox transaction, so a redelivery never reaches it. */
  async onTenantCreated(tx: Tx, event: EventEnvelope): Promise<void> {
    const payload = TenantCreatedV1.parse(event.payload);
    await this.projections.applyTenantCreated(tx, {
      tenantId: event.tenant_id,
      name: payload.name,
      slug: payload.slug,
    });
  }

  async getOwn(): Promise<TenantProjection> {
    const found = await this.db.tenantTx((tx) => this.projections.findOwn(tx));
    if (!found) throw new NotFoundException('tenant projection not found');
    return found;
  }
}
