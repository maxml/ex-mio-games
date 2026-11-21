import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@ex-mio/contracts';
import { authOf } from '@ex-mio/service-kit';
import { IS_PUBLIC } from '@ex-mio/tenancy';

const ROLES_KEY = 'payments:roles';

/** Restrict a handler or controller to user tokens that carry one of these roles (verified claim). */
export const RequireRoles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/**
 * The role check of user-mode routes. The roles come from the auth context the service-kit entry
 * point built from the verified token. A route with no `@RequireRoles` is refused, so a new route
 * is closed until someone says who may call it. Internal (service) routes carry no roles and never
 * use this guard.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const auth = authOf(context.switchToHttp().getRequest<object>());
    if (!auth)
      throw new HttpException({ code: 'unauthenticated', message: 'authentication required' }, 401);
    const wanted = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (!wanted || !auth.roles.some((r) => wanted.includes(r))) {
      throw new HttpException({ code: 'forbidden', message: 'role not allowed' }, 403);
    }
    return true;
  }
}
