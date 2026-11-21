import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseFilters,
} from '@nestjs/common';
import { z } from 'zod';
import {
  CreateRedemptionRequest,
  HEADER_IDEMPOTENCY_KEY,
  ListRedemptionsQuery,
  ResolveReviewRequest,
  Uuid,
  type Redemption,
} from '@ex-mio/contracts';
import { parseInput } from '@ex-mio/service-kit';
import { currentTenant } from '@ex-mio/tenancy';
import { RedemptionsService } from '../services/redemptions.service';
import { SagaError } from '../redemptions/saga-error';
import { playerIdOf, readPrincipal, requireRole } from './principal';
import { toRedemption } from './redemption.dto';
import { StoreErrorFilter } from './store-error.filter';

const IdempotencyKey = z.string().trim().min(8).max(128);
const IdParam = z.object({ id: Uuid });

type Headers_ = Record<string, unknown>;
/** The part of the Fastify reply this controller uses. */
interface Reply {
  header(name: string, value: string): unknown;
}

/**
 * Player and operator API of the redemption saga (spec section 7). Every input is parsed with a
 * zod schema before the service sees it; identity and the sandbox flag come from the request
 * context, never from the URL or the body.
 */
@Controller()
@UseFilters(StoreErrorFilter)
export class RedemptionsController {
  constructor(private readonly redemptions: RedemptionsService) {}

  @Post('v1/redemptions')
  @HttpCode(202)
  async redeem(
    @Headers() headers: Headers_,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<Redemption> {
    const principal = readPrincipal(headers);
    requireRole(principal, 'player');
    const key = parseInput(IdempotencyKey, headers[HEADER_IDEMPOTENCY_KEY]);
    const input = parseInput(CreateRedemptionRequest, body);
    const result = await this.redemptions.redeem(
      {
        tenantId: currentTenant().tenantId,
        playerId: playerIdOf(principal),
        sandbox: principal.sandbox,
      },
      key,
      input.item_id,
    );
    if (!result.created) void reply.header('idempotent-replayed', 'true');
    return toRedemption(result.redemption, 'player');
  }

  @Get('v1/redemptions/:id')
  async getOwn(@Headers() headers: Headers_, @Param() params: unknown): Promise<Redemption> {
    const principal = readPrincipal(headers);
    requireRole(principal, 'player');
    const { id } = parseInput(IdParam, params);
    const found = await this.redemptions.getOwn(
      {
        tenantId: currentTenant().tenantId,
        playerId: playerIdOf(principal),
        sandbox: principal.sandbox,
      },
      id,
    );
    if (!found) throw new SagaError('redemption_not_found');
    return toRedemption(found, 'player');
  }

  @Get('v1/operator/redemptions')
  async list(@Headers() headers: Headers_, @Query() query: unknown): Promise<Redemption[]> {
    requireRole(readPrincipal(headers), 'owner', 'admin', 'analyst');
    const { status } = parseInput(ListRedemptionsQuery, query);
    const rows = await this.redemptions.listForOperator(currentTenant().tenantId, status);
    return rows.map((r) => toRedemption(r, 'operator'));
  }

  @Get('v1/operator/redemptions/:id')
  async getForOperator(
    @Headers() headers: Headers_,
    @Param() params: unknown,
  ): Promise<Redemption> {
    requireRole(readPrincipal(headers), 'owner', 'admin', 'analyst');
    const { id } = parseInput(IdParam, params);
    const found = await this.redemptions.getForOperator(currentTenant().tenantId, id);
    if (!found) throw new SagaError('redemption_not_found');
    return toRedemption(found, 'operator');
  }

  @Post('v1/operator/redemptions/:id/resolve')
  @HttpCode(200)
  async resolve(
    @Headers() headers: Headers_,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<Redemption> {
    const principal = readPrincipal(headers);
    requireRole(principal, 'owner', 'admin');
    const { id } = parseInput(IdParam, params);
    const input = parseInput(ResolveReviewRequest, body);
    const resolved = await this.redemptions.resolveReview(currentTenant().tenantId, id, input, {
      id: principal.id,
      role: principal.role as 'owner' | 'admin',
    });
    return toRedemption(resolved, 'operator');
  }
}
