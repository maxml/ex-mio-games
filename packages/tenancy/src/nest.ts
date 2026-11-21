import {
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  Optional,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { runWithTenant, type TenantContext } from './context';

export const IS_PUBLIC = 'ex-mio:public';
export const TENANT_RESOLVER = Symbol('TENANT_RESOLVER');
const REQUEST_TENANT = Symbol.for('ex-mio:tenant-context');

/** Marks a route that is deliberately tenant-less (health probes, public auth endpoints). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

export interface TenantRequestLike {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Turns a request into a tenant. The only resolver in the code base reads a verified token claim
 * (`jwtTenantResolver`); there is no header resolver and no default tenant. It is a building block
 * of the service-kit entry point (`ServiceAuthModule.forService`), not something an app wires.
 */
export type TenantResolver = (
  request: TenantRequestLike,
) => TenantContext | undefined | Promise<TenantContext | undefined>;

/** The part of a verified access token the resolver needs. */
export interface VerifiedTenantClaims {
  sub: string;
  tid: string;
  act?: { tenant_id: string } | undefined;
}

const bearerOf = (request: TenantRequestLike): string | undefined => {
  const raw = request.headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  return /^Bearer ([^\s]+)$/.exec(value)?.[1];
};

/**
 * Resolve the tenant from a verified token: `act.tenant_id` when the token is an acting session,
 * else `tid`. The principal is always the real actor (`sub`). A missing, malformed or rejected
 * token resolves to nothing, which `TenantGuard` turns into a 401.
 */
export function jwtTenantResolver(
  verify: (token: string) => Promise<VerifiedTenantClaims>,
): TenantResolver {
  return async (request) => {
    const token = bearerOf(request);
    if (!token) return undefined;
    try {
      const claims = await verify(token);
      return {
        tenantId: (claims.act?.tenant_id ?? claims.tid).toLowerCase(),
        principalId: claims.sub,
      };
    } catch {
      return undefined;
    }
  };
}

/**
 * Deny by default: every route needs a resolvable tenant unless it is `@Public()`.
 * A missing or malformed tenant is a 401, not a fallback to some default tenant. Built without a
 * resolver, it denies everything but `@Public()` routes.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(TENANT_RESOLVER)
    private readonly resolver?: TenantResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const request = context.switchToHttp().getRequest<TenantRequestLike>();
    const tenant = this.resolver ? await this.resolver(request) : undefined;
    if (!tenant) throw new UnauthorizedException('tenant required');
    setRequestTenant(request, tenant);
    return true;
  }
}

/** Opens the ambient tenant context around the handler for requests the guard accepted. */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Record<symbol, TenantContext | undefined>>();
    const tenant = request[REQUEST_TENANT];
    if (!tenant) return next.handle();
    return new Observable((subscriber) =>
      runWithTenant(tenant, () => next.handle().subscribe(subscriber)),
    );
  }
}

/** For the service-kit entry point: store the tenant the interceptor will open. */
export function setRequestTenant(request: object, tenant: TenantContext | undefined): void {
  (request as Record<symbol, TenantContext | undefined>)[REQUEST_TENANT] = tenant;
}
