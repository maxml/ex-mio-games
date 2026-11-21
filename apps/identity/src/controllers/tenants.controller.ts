import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { CreateTenantRequest, TenantIdParam, type Tenant } from '@ex-mio/contracts';
import { parseInput } from '@ex-mio/service-kit';
import { Public } from '@ex-mio/tenancy';
import { TenantsService } from '../services/tenants.service';
import { PlatformAdminGuard } from './platform-admin.guard';

/**
 * Platform-level endpoints: they act on the registry of tenants, so they are
 * `@Public()` as far as tenant resolution goes and gated by the platform token.
 */
@Public()
@UseGuards(PlatformAdminGuard)
@Controller('v1/tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown): Promise<Tenant> {
    return this.tenants.create(parseInput(CreateTenantRequest, body));
  }

  @Get(':id')
  get(@Param() params: unknown): Promise<Tenant> {
    return this.tenants.get(parseInput(TenantIdParam, params).id);
  }
}
