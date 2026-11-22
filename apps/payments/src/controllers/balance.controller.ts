import { Controller, Get, Param, UseFilters, UseGuards } from '@nestjs/common';
import { PlayerIdParam, Uuid, type WalletBalance } from '@ex-mio/contracts';
import { currentAuth, parseInput } from '@ex-mio/service-kit';
import { BalanceService } from '../services/balance.service';
import { ActingCoinGuard, NoCoinEffect } from './coin-action';
import { PaymentsExceptionFilter } from './payments-exception.filter';
import { RequireRoles, RolesGuard } from './roles.guard';

@Controller('v1')
@UseGuards(ActingCoinGuard, RolesGuard)
@UseFilters(PaymentsExceptionFilter)
export class BalanceController {
  constructor(private readonly balances: BalanceService) {}

  /**
   * The caller's own balance: the player is the token subject, never a query or path value, and the
   * wallet environment is the token's `sbx` claim, never a header or a query (X-2, X-3).
   */
  @Get('me/balance')
  @NoCoinEffect()
  @RequireRoles('player')
  me(): Promise<WalletBalance> {
    const auth = currentAuth();
    const playerId = parseInput(Uuid, auth.principalId);
    return this.balances.readByPlayer(playerId, { sandbox: auth.sandbox });
  }

  /** An operator reads the PRODUCTION wallet of a player of their tenant. */
  @Get('players/:player_id/balance')
  @NoCoinEffect()
  @RequireRoles('operator_admin', 'operator_staff', 'platform_admin')
  byPlayer(@Param() params: unknown): Promise<WalletBalance> {
    const { player_id } = parseInput(PlayerIdParam, params);
    return this.balances.readByPlayer(player_id, { sandbox: false });
  }
}
