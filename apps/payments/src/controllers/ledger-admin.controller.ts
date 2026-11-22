import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';
import type { ReconciliationRun } from '@ex-mio/contracts';
import { ReconciliationService } from '../services/reconciliation.service';
import { ActingCoinGuard, NoCoinEffect } from './coin-action';
import { PaymentsExceptionFilter } from './payments-exception.filter';
import { RequireRoles, RolesGuard } from './roles.guard';

/**
 * The platform admin's window on the ledger jobs (MIO-084). The record is tenant data (row-level
 * security), so a platform admin reads it the way they read any tenant's data: acting inside the
 * tenant (`act` claim, audited by the entry point). Reading has no coin effect, so an acting token
 * may call it; nothing here writes.
 */
@Controller('v1/platform/ledger')
@UseGuards(ActingCoinGuard, RolesGuard)
@UseFilters(PaymentsExceptionFilter)
export class LedgerAdminController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  /**
   * The latest reconciliation run of the tenant: when it ran, accounts checked, the mismatches by
   * kind, the conservation report, and `stale` once it finished over two hours ago. `last_run` is
   * null when the scheduled job has not run for this tenant yet.
   */
  @Get('reconciliation')
  @NoCoinEffect()
  @RequireRoles('platform_admin')
  async lastRun(): Promise<{ last_run: (ReconciliationRun & { stale: boolean }) | null }> {
    return { last_run: await this.reconciliation.last() };
  }
}
