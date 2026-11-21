import { timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { HEADER_PLATFORM_TOKEN } from '@ex-mio/contracts';

export const PLATFORM_ADMIN_TOKEN = Symbol('PLATFORM_ADMIN_TOKEN');

/**
 * Guard for platform endpoints (the tenant registry). A shared token is a
 * stand-in until operator login exists; it is compared in constant time.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(@Inject(PLATFORM_ADMIN_TOKEN) private readonly expected: string) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const given = Buffer.from(request.headers[HEADER_PLATFORM_TOKEN] ?? '');
    const want = Buffer.from(this.expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new UnauthorizedException('platform admin token required');
    }
    return true;
  }
}
