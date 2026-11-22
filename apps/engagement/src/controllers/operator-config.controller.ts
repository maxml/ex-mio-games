import { Body, Controller, Headers, Put, UseFilters } from '@nestjs/common';
import { PutRuleRequest, PutWheelRequest, type PublishedVersion } from '@ex-mio/contracts';
import { parseInput } from '@ex-mio/service-kit';
import { OperatorConfigService } from '../services/operator-config.service';
import { readPrincipal, requireRole } from './principal';
import { StoreErrorFilter } from './store-error.filter';

/**
 * The operator's wheel and deposit rules (D-27). `operator_admin` only (identity's `wheel.manage`
 * and `rules.manage`); the role is checked before the body is read. The tenant is the verified
 * token's, and the principal is recorded on every published version.
 */
@Controller('v1/operator')
@UseFilters(StoreErrorFilter)
export class OperatorConfigController {
  constructor(private readonly config: OperatorConfigService) {}

  @Put('wheel')
  putWheel(
    @Headers() headers: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<PublishedVersion> {
    const principal = readPrincipal(headers);
    requireRole(principal, 'operator_admin');
    return this.config.putWheel(parseInput(PutWheelRequest, body), principal.id);
  }

  @Put('rules')
  putRules(
    @Headers() headers: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<PublishedVersion> {
    const principal = readPrincipal(headers);
    requireRole(principal, 'operator_admin');
    return this.config.putRule(parseInput(PutRuleRequest, body), principal.id);
  }
}
