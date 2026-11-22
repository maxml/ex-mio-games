import { Controller, Get, HttpException, UseFilters, UseGuards } from '@nestjs/common';
import type { OperatorPlan } from '@ex-mio/contracts';
import { BillingService } from '../services/billing.service';
import { ActingCoinGuard, NoCoinEffect } from './coin-action';
import { PaymentsExceptionFilter } from './payments-exception.filter';
import { RequireRoles, RolesGuard } from './roles.guard';

/**
 * D-27: the operator reads its own plan, including the provider's subscription id (which the
 * provider's callbacks carry). `operator_admin` only: the id is billing detail. The tenant is the
 * verified token's; nothing in the request names one.
 */
@Controller('v1/operator')
@UseGuards(ActingCoinGuard, RolesGuard)
@UseFilters(PaymentsExceptionFilter)
export class OperatorPlanController {
  constructor(private readonly billing: BillingService) {}

  @Get('plan')
  @NoCoinEffect()
  @RequireRoles('operator_admin')
  async plan(): Promise<OperatorPlan> {
    const plan = await this.billing.operatorPlan();
    if (!plan)
      throw new HttpException({ code: 'no_subscription', message: 'no current plan' }, 404);
    return plan;
  }
}
