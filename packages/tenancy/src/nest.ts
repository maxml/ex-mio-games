import {
  type CallHandler,
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  Module,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { isTenantId, runWithTenant, type TenantContext } from './context';

export const TENANT_HEADER = 'x-tenant-id';
export const IS_PUBLIC = 'ex-mio:public';
export const TENANT_RESOLVER = Symbol('TENANT_RESOLVER');
const REQUEST_TENANT = Symbol.for('ex-mio:tenant-context');

/** Marks a route that is deliberately tenant-less (health probes, platform endpoints). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

export interface TenantRequestLike {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Turns a request into a tenant. The default reads the `x-tenant-id` header,
 * which is only a placeholder until the identity service issues JWTs: the
 * resolver that replaces it must take the tenant from a verified token claim,
 * never from a header the caller controls.
 */
export type TenantResolver = (request: TenantRequestLike) => TenantContext | undefined;

export const PRINCIPAL_HEADER = 'x-principal-id';

const first = (raw: string | string[] | undefined): string | undefined =>
  Array.isArray(raw) ? raw[0] : raw;

export const headerTenantResolver: TenantResolver = (request) => {
  const tenantId = first(request.headers[TENANT_HEADER]);
  if (!isTenantId(tenantId)) return undefined;
  const principal = first(request.headers[PRINCIPAL_HEADER]);
  return {
    tenantId: tenantId.toLowerCase(),
    ...(principal && principal.length <= 128 ? { principalId: principal } : {}),
  };
};

/**
 * Deny by default: every route needs a resolvable tenant unless it is `@Public()`.
 * A missing or malformed tenant is a 401, not a fallback to some default tenant.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  // No fallback resolver: a DI mistake must fail closed, never revert to the header.
  constructor(
    private readonly reflector: Reflector,
    @Inject(TENANT_RESOLVER) private readonly resolver: TenantResolver,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const request = context.switchToHttp().getRequest<TenantRequestLike>();
    const tenant = this.resolver(request);
    if (!tenant) throw new UnauthorizedException('tenant required');
    (request as unknown as Record<symbol, TenantContext>)[REQUEST_TENANT] = tenant;
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

/** Set to `true` to boot the header resolver with NODE_ENV=production (never on a real deployment). */
export const ALLOW_HEADER_TENANT_ENV = 'ALLOW_INSECURE_HEADER_TENANT';

/**
 * May this process trust the tenant a caller names in a header? Only outside
 * production, or when the operator says so with an explicit flag.
 */
export function headerTenantAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' || env[ALLOW_HEADER_TENANT_ENV] === 'true';
}

@Module({})
export class TenancyModule {
  /**
   * Registers the deny-by-default guard and the context interceptor app-wide.
   * Without a `resolver` the header placeholder is used, and in production that
   * is refused at boot: the tenant must come from a verified token claim.
   */
  static forRoot(
    options: { resolver?: TenantResolver; env?: NodeJS.ProcessEnv } = {},
  ): DynamicModule {
    if (!options.resolver && !headerTenantAllowed(options.env)) {
      throw new Error(
        `refusing to boot: the x-tenant-id header resolver is a placeholder and is not allowed in production (pass a verified-token resolver; ${ALLOW_HEADER_TENANT_ENV}=true overrides, for a throwaway environment only)`,
      );
    }
    return {
      module: TenancyModule,
      providers: [
        { provide: TENANT_RESOLVER, useValue: options.resolver ?? headerTenantResolver },
        { provide: APP_GUARD, useClass: TenantGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
      ],
    };
  }
}
