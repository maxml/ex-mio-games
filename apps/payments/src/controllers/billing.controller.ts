import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
  type RawBodyRequest,
} from '@nestjs/common';
import { Public } from '@ex-mio/tenancy';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CreateAttemptRequest,
  HEADER_IDEMPOTENCY_KEY,
  Uuid,
  type BillingPlan,
  type Invoice,
  type PaymentAttempt,
  type UsageReport,
  type WebhookResult,
} from '@ex-mio/contracts';
import { parseInput } from '@ex-mio/service-kit';
import { BillingService } from '../services/billing.service';
import { UsageService } from '../services/usage.service';
import { ActingCoinGuard, NoCoinEffect } from './coin-action';
import { answer, requireIdempotencyKey } from './http';
import { PaymentsExceptionFilter } from './payments-exception.filter';
import { RequireRoles, RolesGuard } from './roles.guard';

const IdParam = z.object({ id: Uuid });
const PeriodQuery = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });

/** Who may read billing state of their tenant. Creating or cancelling an attempt is `operator_admin` only. */
const READERS = ['operator_admin', 'operator_staff', 'platform_admin'] as const;

/** Operator billing, plus the provider's public webhook (verified by signature, not by a token). */
@Controller('v1/billing')
@UseGuards(ActingCoinGuard, RolesGuard)
@UseFilters(PaymentsExceptionFilter)
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly usage: UsageService,
  ) {}

  @Get('plans')
  @NoCoinEffect()
  @RequireRoles(...READERS)
  plans(): Promise<BillingPlan[]> {
    return this.billing.listPlans();
  }

  /** The only place a card number is read: it goes to the provider adapter's `tokenize` and no further. */
  @Post('attempts')
  @NoCoinEffect()
  @RequireRoles('operator_admin')
  async createAttempt(
    @Body() body: unknown,
    @Headers(HEADER_IDEMPOTENCY_KEY) keyHeader: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PaymentAttempt> {
    const key = requireIdempotencyKey(keyHeader);
    const input = parseInput(CreateAttemptRequest, body);
    return answer(reply, await this.billing.createAttempt(input, key));
  }

  @Get('attempts/:id')
  @NoCoinEffect()
  @RequireRoles(...READERS)
  attempt(@Param() params: unknown): Promise<PaymentAttempt> {
    return this.billing.getAttempt(parseInput(IdParam, params).id);
  }

  @Post('attempts/:id/cancel')
  @NoCoinEffect()
  @RequireRoles('operator_admin')
  async cancel(
    @Param() params: unknown,
    @Headers(HEADER_IDEMPOTENCY_KEY) keyHeader: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PaymentAttempt> {
    const key = requireIdempotencyKey(keyHeader);
    const { id } = parseInput(IdParam, params);
    return answer(reply, await this.billing.cancelAttempt(id, key));
  }

  @Get('subscription')
  @NoCoinEffect()
  @RequireRoles(...READERS)
  async subscription(@Res() reply: FastifyReply): Promise<void> {
    // `null` is a valid answer (no current subscription), sent as the JSON text `null`.
    const current = await this.billing.currentSubscription();
    void reply.type('application/json').send(JSON.stringify(current));
  }

  @Get('invoices')
  @NoCoinEffect()
  @RequireRoles(...READERS)
  invoices(): Promise<Invoice[]> {
    return this.billing.listInvoices();
  }

  @Get('usage')
  @NoCoinEffect()
  @RequireRoles(...READERS)
  report(@Query() query: unknown): Promise<UsageReport> {
    return this.usage.report(parseInput(PeriodQuery, query).period);
  }

  /** Public: no token. The adapter verifies the signature over the EXACT raw bytes. */
  @Post('webhooks')
  @Public()
  @HttpCode(200)
  webhook(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers('x-webhook-signature') signature: string | undefined,
  ): Promise<WebhookResult> {
    return this.billing.handleWebhook(req.rawBody?.toString('utf8') ?? '', signature);
  }
}
