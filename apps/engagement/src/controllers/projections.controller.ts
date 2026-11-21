import { Controller, Get } from '@nestjs/common';
import type { TenantProjection } from '@ex-mio/contracts';
import { ProjectionsService } from '../services/projections.service';

/** Tenant-scoped: the tenant guard runs first, and the service reads only that tenant's row. */
@Controller('v1/tenant-projection')
export class ProjectionsController {
  constructor(private readonly projections: ProjectionsService) {}

  @Get()
  get(): Promise<TenantProjection> {
    return this.projections.getOwn();
  }
}
