import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  Injectable,
  Module,
  SetMetadata,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { INTERNAL_PATH_PREFIX, type Action } from '@ex-mio/contracts';
import { authOf, routeTemplate } from '@ex-mio/service-kit';
import { IS_PUBLIC } from '@ex-mio/tenancy';

export const PERMISSION_KEY = 'ex-mio:permission';

/** Declares the permission a route needs. Every identity route has this or `@Public()`. */
export const RequirePermission = (action: Action): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, action);

/**
 * Default deny: a route that declares neither a permission nor `@Public()` is refused, so a new
 * route cannot ship open by omission. `/internal/v1/` routes are service-token routes decided by
 * the entry point (on the normalised path, the same decision it makes); no user permission applies.
 * The permission itself is enforced by `AccessService.authorize` in the service the route calls.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = context.switchToHttp().getRequest<object>();
    const template = routeTemplate(req as never);
    if (template.startsWith(INTERNAL_PATH_PREFIX)) return true;
    if (!authOf(req)) {
      throw new HttpException({ code: 'TOKEN_INVALID', message: 'authentication required' }, 401);
    }
    const declared = this.reflector.getAllAndOverride<Action | undefined>(PERMISSION_KEY, targets);
    if (!declared) {
      throw new HttpException(
        { code: 'FORBIDDEN', message: 'route has no declared permission' },
        403,
      );
    }
    return true;
  }
}

/**
 * Registers `PermissionGuard` app-wide. It lives in its own module, imported AFTER
 * `ServiceAuthModule`, because global guards run in module registration order and this one reads
 * the auth context the entry point establishes.
 */
@Module({ providers: [{ provide: APP_GUARD, useClass: PermissionGuard }] })
export class PermissionGuardModule {}
