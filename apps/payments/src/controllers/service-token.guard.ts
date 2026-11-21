import { timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { HEADER_PRINCIPAL_KIND, HEADER_SERVICE_ID, HEADER_SERVICE_TOKEN } from '@ex-mio/contracts';

/** Injection token of `{ <service name>: <secret> }` (placeholder identity until the identity token lands). */
export const SERVICE_TOKENS = Symbol('SERVICE_TOKENS');

/** The only service allowed to move coins. */
const COIN_CALLER = 'engagement';

type Headers = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Internal coin commands accept the `engagement` service identity only. A player or operator principal
 * is refused even with a valid service token.
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(@Inject(SERVICE_TOKENS) private readonly tokens: Record<string, string>) {}

  canActivate(context: ExecutionContext): boolean {
    const headers = context.switchToHttp().getRequest<{ headers: Headers }>().headers;
    const id = one(headers[HEADER_SERVICE_ID]);
    const token = one(headers[HEADER_SERVICE_TOKEN]);
    const kind = one(headers[HEADER_PRINCIPAL_KIND]);
    const expected = id === COIN_CALLER ? this.tokens[COIN_CALLER] : undefined;
    if (!expected || !token || !sameSecret(token, expected) || kind) {
      throw new ForbiddenException('service identity required');
    }
    return true;
  }
}
