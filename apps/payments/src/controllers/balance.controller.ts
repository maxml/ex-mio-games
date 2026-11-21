import { Controller, Get, Param, UseFilters, UseGuards } from '@nestjs/common';
import { PlayerIdParam, Uuid, type WalletBalance } from '@ex-mio/contracts';
import { parseInput } from '@ex-mio/service-kit';
import { currentTenant } from '@ex-mio/tenancy';
import { BalanceService } from '../services/balance.service';
import { PaymentsExceptionFilter } from './payments-exception.filter';
import { PrincipalGuard, RequirePrincipal } from './principal.guard';

@Controller('v1')
@UseGuards(PrincipalGuard)
@UseFilters(PaymentsExceptionFilter)
export class BalanceController {
  constructor(private readonly balances: BalanceService) {}

  /** The caller's own balance: the player is the principal, never a query or path value. */
  @Get('me/balance')
  @RequirePrincipal('player')
  me(): Promise<WalletBalance> {
    const playerId = parseInput(Uuid, currentTenant().principalId);
    return this.balances.readByPlayer(playerId);
  }

  @Get('players/:player_id/balance')
  @RequirePrincipal('operator')
  byPlayer(@Param() params: unknown): Promise<WalletBalance> {
    const { player_id } = parseInput(PlayerIdParam, params);
    return this.balances.readByPlayer(player_id);
  }
}
