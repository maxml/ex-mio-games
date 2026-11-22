import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  HEADER_IDEMPOTENCY_KEY,
  ReserveCoinsRequest,
  ReserveRefRequest,
  Uuid,
  type CoinOperationResult,
  type WalletBalance,
} from '@ex-mio/contracts';
import { parseInput } from '@ex-mio/service-kit';
import { BalanceService } from '../services/balance.service';
import { LedgerService } from '../services/ledger.service';
import { ActingCoinGuard, CoinAction, NoCoinEffect } from './coin-action';
import { answer, requireIdempotencyKey } from './http';
import { PaymentsExceptionFilter } from './payments-exception.filter';

const ReservePath = z.object({ tenantId: Uuid, reserveId: Uuid });
const PlayerPath = z.object({ tenantId: Uuid, playerId: Uuid });
/** The environment of an internal read: a service-only route, set by engagement from its credential. */
const EnvironmentQuery = z.object({ sandbox: z.enum(['true', 'false']) }).strict();

/**
 * The internal coin commands and the balance read (`PAYMENTS_INTERNAL_ROUTES`). The service-kit entry
 * point admits only a service token for `aud=payments` whose caller (`svc:engagement`) is on the
 * allow-list, and takes the tenant from the path. A user token, an acting one included, never gets
 * here (401). `ActingCoinGuard` stays as defence in depth (D-5).
 */
@Controller('internal/v1/tenants/:tenantId')
@UseGuards(ActingCoinGuard)
@UseFilters(PaymentsExceptionFilter)
export class CoinsController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly balances: BalanceService,
  ) {}

  @Post('reserves')
  @CoinAction('coins.reserve')
  async reserve(
    @Body() body: unknown,
    @Headers(HEADER_IDEMPOTENCY_KEY) keyHeader: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CoinOperationResult> {
    const input = parseInput(ReserveCoinsRequest, body);
    return answer(reply, await this.ledger.reserve(input, requireIdempotencyKey(keyHeader)));
  }

  @Post('reserves/:reserveId/capture')
  @CoinAction('coins.capture')
  async capture(
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers(HEADER_IDEMPOTENCY_KEY) keyHeader: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CoinOperationResult> {
    const { reserveId } = parseInput(ReservePath, params);
    parseInput(ReserveRefRequest, body ?? {});
    return answer(
      reply,
      await this.ledger.capture({ reserve_id: reserveId }, requireIdempotencyKey(keyHeader)),
    );
  }

  @Post('reserves/:reserveId/release')
  @CoinAction('coins.release')
  async release(
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers(HEADER_IDEMPOTENCY_KEY) keyHeader: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CoinOperationResult> {
    const { reserveId } = parseInput(ReservePath, params);
    parseInput(ReserveRefRequest, body ?? {});
    return answer(
      reply,
      await this.ledger.release({ reserve_id: reserveId }, requireIdempotencyKey(keyHeader)),
    );
  }

  @Post('reserves/:reserveId/refund')
  @CoinAction('coins.refund')
  async refund(
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers(HEADER_IDEMPOTENCY_KEY) keyHeader: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CoinOperationResult> {
    const { reserveId } = parseInput(ReservePath, params);
    parseInput(ReserveRefRequest, body ?? {});
    return answer(
      reply,
      await this.ledger.refund({ reserve_id: reserveId }, requireIdempotencyKey(keyHeader)),
    );
  }

  @Get('players/:playerId/balance')
  @NoCoinEffect()
  balance(@Param() params: unknown, @Query() query: unknown): Promise<WalletBalance> {
    const { playerId } = parseInput(PlayerPath, params);
    const { sandbox } = parseInput(EnvironmentQuery, query);
    return this.balances.readByPlayer(playerId, { sandbox: sandbox === 'true' });
  }
}
