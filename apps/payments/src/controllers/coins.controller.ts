import { Body, Controller, Headers, Post, Res, UseFilters, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  HEADER_IDEMPOTENCY_KEY,
  ReserveCoinsRequest,
  ReserveRefRequest,
  type CoinOperationResult,
} from '@ex-mio/contracts';
import { parseInput } from '@ex-mio/service-kit';
import { LedgerService } from '../services/ledger.service';
import { answer, requireIdempotencyKey } from './http';
import { ActingTenantGuard } from './principal.guard';
import { PaymentsExceptionFilter } from './payments-exception.filter';
import { ServiceTokenGuard } from './service-token.guard';

/**
 * The four internal coin commands. Service identity only (`engagement`), and never with an
 * `acting_tenant` claim (D-5): both guards sit on the class, so every coin route has them.
 */
@Controller('internal/v1/coins')
@UseGuards(ServiceTokenGuard, ActingTenantGuard)
@UseFilters(PaymentsExceptionFilter)
export class CoinsController {
  constructor(private readonly ledger: LedgerService) {}

  @Post('reserve')
  async reserve(
    @Body() body: unknown,
    @Headers(HEADER_IDEMPOTENCY_KEY) keyHeader: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CoinOperationResult> {
    const input = parseInput(ReserveCoinsRequest, body);
    return answer(reply, await this.ledger.reserve(input, requireIdempotencyKey(keyHeader)));
  }

  @Post('capture')
  async capture(
    @Body() body: unknown,
    @Headers(HEADER_IDEMPOTENCY_KEY) keyHeader: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CoinOperationResult> {
    const input = parseInput(ReserveRefRequest, body);
    return answer(reply, await this.ledger.capture(input, requireIdempotencyKey(keyHeader)));
  }

  @Post('release')
  async release(
    @Body() body: unknown,
    @Headers(HEADER_IDEMPOTENCY_KEY) keyHeader: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CoinOperationResult> {
    const input = parseInput(ReserveRefRequest, body);
    return answer(reply, await this.ledger.release(input, requireIdempotencyKey(keyHeader)));
  }

  @Post('refund')
  async refund(
    @Body() body: unknown,
    @Headers(HEADER_IDEMPOTENCY_KEY) keyHeader: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CoinOperationResult> {
    const input = parseInput(ReserveRefRequest, body);
    return answer(reply, await this.ledger.refund(input, requireIdempotencyKey(keyHeader)));
  }
}
