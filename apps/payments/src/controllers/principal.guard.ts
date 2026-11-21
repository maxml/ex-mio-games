import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HEADER_ACTING_TENANT, HEADER_PRINCIPAL_KIND } from '@ex-mio/contracts';

type Headers = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const PRINCIPAL_KIND = 'payments:principal-kind';

/** Restrict a route to one principal kind (`player` or `operator`). */
export const RequirePrincipal = (kind: 'player' | 'operator'): MethodDecorator & ClassDecorator =>
  SetMetadata(PRINCIPAL_KIND, kind);

/** Placeholder until the verified token claim replaces `x-principal-kind`. */
@Injectable()
export class PrincipalGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const wanted = this.reflector.getAllAndOverride<string | undefined>(PRINCIPAL_KIND, [
      context.getHandler(),
      context.getClass(),
    ]);
    const headers = context.switchToHttp().getRequest<{ headers: Headers }>().headers;
    if (wanted && one(headers[HEADER_PRINCIPAL_KIND]) !== wanted) {
      throw new ForbiddenException(`${wanted} principal required`);
    }
    return true;
  }
}

/**
 * D-5: a token that carries `acting_tenant` (an operator acting inside a tenant) moves no coins. Applied
 * at the class of the coins controller, so every coin route has it.
 */
@Injectable()
export class ActingTenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const headers = context.switchToHttp().getRequest<{ headers: Headers }>().headers;
    if (one(headers[HEADER_ACTING_TENANT])) {
      throw new ForbiddenException('acting tenant cannot move coins');
    }
    return true;
  }
}
