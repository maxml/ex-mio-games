import { type CanActivate, type ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { authOf } from '@ex-mio/service-kit';

/**
 * D-5, D-15 Q-2 (a), X-11: an acting platform_admin session never moves coins, and resolving a
 * redemption moves coins one hop away (`redemptions.resolve` is in identity's `ACTING_DENIED_ACTIONS`).
 *
 * D-24: this is a GUARD, not a check inside the handler. The audit decision is the guards'
 * authorization outcome, and a refusal made inside the handler would be recorded as `allowed`.
 * It reads `act` from the auth context the entry point built from the VERIFIED token.
 */
@Injectable()
export class ActingBanGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const auth = authOf(context.switchToHttp().getRequest<object>());
    if (auth?.acting)
      throw new HttpException(
        { code: 'ACTING_FORBIDDEN', message: 'an acting session cannot do this' },
        403,
      );
    return true;
  }
}
