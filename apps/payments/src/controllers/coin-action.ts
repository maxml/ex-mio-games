import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { COIN_VALUE_ACTIONS, type Action } from '@ex-mio/contracts';
import { authOf } from '@ex-mio/service-kit';
import { IS_PUBLIC } from '@ex-mio/tenancy';

/** Metadata key of the coin action a handler performs (one of the contract `ACTIONS`). */
export const COIN_ACTION_KEY = 'payments:coin-action';
/** Metadata key of a handler that has no coin effect (a read, a billing call). */
export const NO_COIN_EFFECT_KEY = 'payments:no-coin-effect';

/** Declare the coin action of a handler, for example `@CoinAction('coins.reserve')`. */
export const CoinAction = (action: Action): MethodDecorator => SetMetadata(COIN_ACTION_KEY, action);

/** Declare that a handler moves no coins, so an acting token may call it. */
export const NoCoinEffect = (): MethodDecorator => SetMetadata(NO_COIN_EFFECT_KEY, true);

const BANNED_WHILE_ACTING: ReadonlySet<string> = new Set(
  COIN_VALUE_ACTIONS.map((a) => `coins.${a}`),
);

const refuse = (status: number, code: string, message: string): HttpException =>
  new HttpException({ code, message }, status);

/**
 * D-5: a token that carries `act` (a platform admin acting inside a tenant) moves no coins. This
 * guard sits on every payments controller. It reads `act` from the auth context that
 * `ServiceAuthModule` established from the VERIFIED token, never from a header or the body, and it
 * fails closed: no auth context is 401, a handler that declares neither a coin action nor
 * `@NoCoinEffect()` (nor `@Public()`) is 403 for everyone.
 */
@Injectable()
export class ActingCoinGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const auth = authOf(context.switchToHttp().getRequest<object>());
    if (!auth) throw refuse(401, 'unauthenticated', 'authentication required');

    const action = this.reflector.get<string | undefined>(COIN_ACTION_KEY, context.getHandler());
    const noEffect = this.reflector.get<boolean | undefined>(
      NO_COIN_EFFECT_KEY,
      context.getHandler(),
    );
    if (action === undefined && noEffect !== true) {
      throw refuse(403, 'forbidden', 'the route declares no coin effect');
    }
    if (action !== undefined && auth.acting && BANNED_WHILE_ACTING.has(action)) {
      throw refuse(403, 'acting_forbidden', 'an acting tenant cannot move coins');
    }
    return true;
  }
}
