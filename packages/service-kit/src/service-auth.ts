import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type CallHandler,
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Module,
  type NestInterceptor,
  type OnApplicationShutdown,
  type OnModuleInit,
  SetMetadata,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, ModuleRef, Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import {
  createEvent,
  INTERNAL_PATH_PREFIX,
  PLATFORM_TENANT_ID,
  SERVICE_CALL_POLICY,
  ServiceName,
  TENANT_STATUS_CACHE_SECONDS,
  type AccessTokenClaims,
  type EventEnvelope,
  type Role,
  type ServiceCallPolicy,
  type TenantStatus,
} from '@ex-mio/contracts';
import {
  IS_PUBLIC,
  isTenantId,
  runWithTenant,
  setRequestTenant,
  type TenantContext,
} from '@ex-mio/tenancy';
import {
  createServiceTokenVerifier,
  createTokenVerifier,
  JwksCache,
  TokenRejectedError,
  type Jwks,
} from './auth';
import {
  createOutboxAuditPort,
  logAuditFinalizeFailure,
  startAuditSweeper,
  type OutboxAuditPort,
} from './audit-intents';
import { Db } from './db';

export { Public } from '@ex-mio/tenancy';

/*
 * The ONE auth entry point of every service (decision D-4, spec section 1.5).
 *
 *   ServiceAuthModule.forService({ audience, identityUrl })
 *
 * builds the verifier, the deny-by-default guard, the tenant context and the audit of acting and
 * internal requests. It has no resolver option: the tenant comes from a verified token claim
 * (user mode) or from the explicit path/body tenant of an allow-listed internal route (service
 * mode), never from a header, the Host or a query.
 */

export const SERVICE_AUTH_OPTIONS = Symbol('SERVICE_AUTH_OPTIONS');
export const SERVICE_AUTH_RUNTIME = Symbol('SERVICE_AUTH_RUNTIME');

export type AuditPort = ((event: EventEnvelope) => Promise<void>) & {
  /** Called after the response with the same event object, final `decision` and `status` set. */
  finalize?: (event: EventEnvelope) => Promise<void>;
  /** Writes an event whose outcome is already final (a guard refusal), with no intent. */
  publishFinal?: (event: EventEnvelope) => Promise<void>;
  /** Ports that hold events back until finalize (the outbox default) are swept on a timer. */
  sweep?: (olderThanSeconds?: number) => Promise<number>;
};

export interface ServiceAuthOptions {
  /** The service this process is. Tokens are accepted only when minted for it. */
  audience: string;
  /** Identity base URL: production source of the JWKS and the tenant status; default audit is the outbox. */
  identityUrl?: string;
  jwks?: () => Promise<Jwks>;
  tenantStatus?: (tenantId: string) => Promise<TenantStatus>;
  auditPort?: (event: EventEnvelope) => Promise<void>;
  serviceCalls?: ServiceCallPolicy;
  nowSeconds?: () => number;
}

const ALLOWED_OPTIONS = new Set([
  'audience',
  'identityUrl',
  'jwks',
  'tenantStatus',
  'auditPort',
  'serviceCalls',
  'nowSeconds',
]);

export interface AuthContext {
  mode: 'user' | 'service';
  tenantId?: string;
  principalId: string;
  roles: Role[];
  acting?: { tenantId: string; reason: string };
  /** Service mode: the calling service. */
  service?: string;
  /** User mode: the token's `sbx` claim (X-3), the player's environment. Never read from a request value. */
  sandbox?: boolean;
}

const REQUEST_AUTH = Symbol.for('ex-mio:auth-context');
const authStorage = new AsyncLocalStorage<AuthContext>();
const INTERNAL_TENANTLESS_KEY = 'ex-mio:internal-tenantless';

/** Marks the one internal route whose tenant is not in the path or body (the key's tenant). */
export const InternalTenantless = (): MethodDecorator => SetMetadata(INTERNAL_TENANTLESS_KEY, true);

/** The auth context of the request being handled; throws when there is none (fails closed). */
export function currentAuth(): AuthContext {
  const ctx = authStorage.getStore();
  if (!ctx)
    throw new Error('no auth context: the request did not pass the service auth entry point');
  return ctx;
}

/** The auth context when there is one: for a read with a safe default (no context, no sandbox). */
export function tryCurrentAuth(): AuthContext | undefined {
  return authStorage.getStore();
}

/** For a guard that runs after the entry point: the context it established for this request. */
export function authOf(request: object): AuthContext | undefined {
  return (request as Record<symbol, AuthContext | undefined>)[REQUEST_AUTH];
}

const fail = (status: number, code: string, message = code): HttpException =>
  new HttpException({ code, message }, status);

interface FastifyLike {
  id?: string;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, unknown>;
  body?: unknown;
  routeOptions?: { url?: string };
  routerPath?: string;
}
interface ReplyLike {
  statusCode: number;
  raw: { once(event: string, fn: () => void): unknown };
}

/** The matched route template: decoded, query-free, never the raw URL string (N2). */
export function routeTemplate(req: FastifyLike): string {
  return req.routeOptions?.url ?? req.routerPath ?? req.url.split('?')[0] ?? '';
}

const bearerOf = (req: FastifyLike): string | undefined => {
  const raw = req.headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? /^Bearer ([^\s]+)$/.exec(value)?.[1] : undefined;
};

const AUDIT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

// ---- production sources (identityUrl) --------------------------------------------------------

class IdentityClient {
  private token: { value: string; expiresAt: number } | undefined;
  constructor(
    private readonly identityUrl: string,
    private readonly clientId: string,
    private readonly now: () => number,
  ) {}

  async jwks(): Promise<Jwks> {
    const res = await fetch(`${this.identityUrl}/.well-known/jwks.json`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`jwks ${res.status}`);
    return (await res.json()) as Jwks;
  }

  private async serviceToken(): Promise<string> {
    const now = this.now();
    if (this.token && this.token.expiresAt - 30 > now) return this.token.value;
    const secret = process.env.SERVICE_CLIENT_SECRET;
    if (!secret) throw new Error('SERVICE_CLIENT_SECRET is not set');
    const res = await fetch(`${this.identityUrl}/v1/auth/service-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: secret,
        audience: 'identity',
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`service token ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: now + body.expires_in };
    return body.access_token;
  }

  async tenantStatus(tenantId: string): Promise<TenantStatus> {
    const res = await fetch(`${this.identityUrl}/internal/v1/tenants/${tenantId}/status`, {
      headers: { authorization: `Bearer ${await this.serviceToken()}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`tenant status ${res.status}`);
    const body = (await res.json()) as { status: TenantStatus };
    return body.status;
  }
}

// ---- runtime ---------------------------------------------------------------------------------

export class ServiceAuthRuntime {
  readonly now: () => number;
  readonly audience: ServiceName;
  readonly policy: ServiceCallPolicy;
  readonly verifyUser: (token: string) => Promise<AccessTokenClaims>;
  readonly verifyService: ReturnType<typeof createServiceTokenVerifier>;
  private readonly statusSource: (tenantId: string) => Promise<TenantStatus>;
  readonly explicitAudit: ((event: EventEnvelope) => Promise<void>) | undefined;
  private readonly statusCache = new Map<string, { status: TenantStatus; at: number }>();

  constructor(options: ServiceAuthOptions) {
    this.now = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.audience = ServiceName.parse(options.audience);
    this.policy = options.serviceCalls ?? SERVICE_CALL_POLICY;
    const client = options.identityUrl
      ? new IdentityClient(options.identityUrl, this.audience, this.now)
      : undefined;
    const jwks = options.jwks ?? (() => client!.jwks());
    this.statusSource = options.tenantStatus ?? ((id) => client!.tenantStatus(id));
    this.explicitAudit = options.auditPort;
    const cache = new JwksCache(jwks, this.now);
    this.verifyUser = createTokenVerifier({
      audience: this.audience,
      jwks,
      nowSeconds: this.now,
      cache,
    });
    this.verifyService = createServiceTokenVerifier({
      audience: this.audience,
      jwks,
      nowSeconds: this.now,
      cache,
    });
  }

  private defaultAudit: OutboxAuditPort | undefined;

  /**
   * The audit port: the one the options gave, else the service's own two-step outbox port (D-21).
   * One instance per runtime, shared by the guard (writes) and the sweeper.
   */
  auditPort(moduleRef: ModuleRef): AuditPort {
    if (this.explicitAudit) return this.explicitAudit as AuditPort;
    this.defaultAudit ??= createOutboxAuditPort(() => moduleRef.get(Db, { strict: false }));
    return this.defaultAudit;
  }

  /** Cached tenant status, at most TENANT_STATUS_CACHE_SECONDS stale; an unreachable source fails closed. */
  async status(tenantId: string): Promise<TenantStatus> {
    const now = this.now();
    const hit = this.statusCache.get(tenantId);
    if (hit && now - hit.at < TENANT_STATUS_CACHE_SECONDS) return hit.status;
    let status: TenantStatus;
    try {
      status = await this.statusSource(tenantId);
    } catch {
      this.statusCache.delete(tenantId);
      throw fail(503, 'TENANT_STATUS_UNAVAILABLE', 'tenant status unavailable');
    }
    this.statusCache.set(tenantId, { status, at: now });
    return status;
  }
}

// ---- guard -----------------------------------------------------------------------------------

@Injectable()
export class ServiceAuthGuard implements CanActivate {
  private audit: AuditPort | undefined;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(SERVICE_AUTH_RUNTIME) private readonly rt: ServiceAuthRuntime,
  ) {}

  private auditPort(): AuditPort {
    this.audit ??= this.rt.auditPort(this.moduleRef);
    return this.audit;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyLike>();
    const reply = http.getResponse<ReplyLike>();
    const template = routeTemplate(req);
    const internal = template.startsWith(INTERNAL_PATH_PREFIX);
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const token = bearerOf(req);
    if (!token) throw fail(401, 'TENANT_REQUIRED', 'authentication required');
    return internal
      ? this.serviceMode(req, reply, template, token, targets)
      : this.userMode(req, reply, template, token);
  }

  // ---- user mode -----------------------------------------------------------------------------

  private async userMode(
    req: FastifyLike,
    reply: ReplyLike,
    template: string,
    token: string,
  ): Promise<boolean> {
    let claims: AccessTokenClaims;
    try {
      claims = await this.rt.verifyUser(token);
    } catch (err) {
      if (err instanceof TokenRejectedError) throw fail(401, err.code);
      throw fail(401, 'TOKEN_INVALID');
    }
    const acting = claims.act
      ? { tenantId: claims.act.tenant_id.toLowerCase(), reason: claims.act.reason }
      : undefined;
    if (acting) {
      await this.auditActing(req, reply, template, claims, acting);
    } else if ((await this.rt.status(claims.tid.toLowerCase())) !== 'active') {
      throw fail(403, 'TENANT_SUSPENDED', 'tenant is suspended');
    }
    const tenantId = acting?.tenantId ?? claims.tid.toLowerCase();
    const auth: AuthContext = {
      mode: 'user',
      tenantId,
      principalId: claims.sub,
      roles: claims.roles,
      ...(acting ? { acting } : {}),
      ...(claims.sbx ? { sandbox: true } : {}),
    };
    (req as unknown as Record<symbol, AuthContext>)[REQUEST_AUTH] = auth;
    setRequestTenant(req, { tenantId, principalId: claims.sub });
    return true;
  }

  private async auditActing(
    req: FastifyLike,
    reply: ReplyLike,
    template: string,
    claims: AccessTokenClaims,
    acting: { tenantId: string; reason: string },
  ): Promise<void> {
    const method = auditMethod(req.method);
    if (!method) return;
    const event = createEvent({
      type: 'audit.acting_request',
      tenantId: acting.tenantId,
      payload: {
        actor_user_id: claims.sub,
        actor_tenant_id: PLATFORM_TENANT_ID,
        acting_tenant_id: acting.tenantId,
        reason: acting.reason,
        service: this.rt.audience,
        method,
        route: `${method} ${template}`,
        decision: 'allowed',
        status: 200,
        request_id: String(req.id ?? 'req'),
        occurred_at: new Date(this.rt.now() * 1000).toISOString(),
      },
    });
    await this.write(event, req, reply);
  }

  // ---- service mode --------------------------------------------------------------------------

  private async serviceMode(
    req: FastifyLike,
    reply: ReplyLike,
    template: string,
    token: string,
    targets: Array<object>,
  ): Promise<boolean> {
    let caller: string;
    try {
      caller = (await this.rt.verifyService(token)).sub.slice('svc:'.length);
    } catch (err) {
      if (err instanceof TokenRejectedError) throw fail(401, err.code);
      throw fail(401, 'TOKEN_INVALID');
    }
    const tenantless = targets.some(
      (t) => Reflect.getMetadata(INTERNAL_TENANTLESS_KEY, t) === true,
    );
    const method = auditMethod(req.method);
    const routeKey = `${req.method === 'HEAD' ? 'GET' : req.method} ${template}`;

    const tenant = tenantless ? { ok: true as const, id: undefined } : tenantOfInternal(req);
    const eventTenant = tenant.ok && tenant.id ? tenant.id : PLATFORM_TENANT_ID;

    let refusal: HttpException | undefined;
    const allowed = this.rt.policy[caller as ServiceName]?.[this.rt.audience] ?? [];
    if (!allowed.includes(routeKey)) {
      refusal = fail(403, 'SERVICE_CALL_FORBIDDEN', 'this service may not call this route');
    } else if (!tenant.ok) {
      refusal = fail(400, 'VALIDATION_FAILED', tenant.message);
    }

    if (method) {
      const refused = refusal !== undefined;
      const event = createEvent({
        type: 'audit.service_call',
        tenantId: eventTenant,
        payload: {
          caller_service: caller as ServiceName,
          service: this.rt.audience,
          method,
          route: `${method} ${template}`,
          decision: refused ? 'refused' : 'allowed',
          status: refusal ? refusal.getStatus() : 200,
          request_id: String(req.id ?? 'req'),
          occurred_at: new Date(this.rt.now() * 1000).toISOString(),
        },
      });
      if (refused) await this.writeFinal(event);
      else await this.write(event, req, reply);
    }
    if (refusal) throw refusal;

    const tenantId = tenant.ok ? tenant.id : undefined;
    const auth: AuthContext = {
      mode: 'service',
      ...(tenantId ? { tenantId } : {}),
      principalId: `svc:${caller}`,
      roles: [],
      service: caller,
    };
    (req as unknown as Record<symbol, AuthContext>)[REQUEST_AUTH] = auth;
    setRequestTenant(req, tenantId ? { tenantId, principalId: `svc:${caller}` } : undefined);
    return true;
  }

  // ---- audit ---------------------------------------------------------------------------------

  /** A refusal made by this guard: the outcome is known, write it once, final. */
  private async writeFinal(event: EventEnvelope): Promise<void> {
    try {
      const port = this.auditPort();
      // A two-step port must not take a refusal as an intent: nothing would finalize it (F1).
      await (port.publishFinal ?? port)(event);
    } catch {
      throw fail(503, 'AUDIT_UNAVAILABLE', 'audit unavailable');
    }
  }

  /**
   * An allowed request: an audit INTENT is written BEFORE the handler (fail closed: if the port
   * throws the handler never runs), with a provisional outcome that is never published. When the
   * response is done, the same event object gets the real `decision` and `status`, and
   * `port.finalize` publishes it. The outbox default holds the intent in `audit_intents`, finalizes
   * it in one transaction and sweeps stale intents as `aborted` (D-21).
   */
  private async write(event: EventEnvelope, req: FastifyLike, reply: ReplyLike): Promise<void> {
    const port = this.auditPort();
    try {
      await port(event);
    } catch {
      throw fail(503, 'AUDIT_UNAVAILABLE', 'audit unavailable');
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      const payload = event.payload as { decision: string; status: number };
      payload.status = reply.statusCode;
      payload.decision = auditDecision(req, reply.statusCode);
      void port.finalize?.(event).catch(logAuditFinalizeFailure);
    };
    // 'close' without a finished response means the client went away before the outcome was known
    // (the status is still the default 200): record that as aborted, never as allowed (F7).
    const aborted = (): void => {
      if (done) return;
      done = true;
      const payload = event.payload as { decision: string; status: number };
      payload.status = 500;
      payload.decision = 'aborted';
      void port.finalize?.(event).catch(logAuditFinalizeFailure);
    };
    reply.raw.once('finish', finish);
    reply.raw.once('close', () => {
      const raw = reply.raw as { writableFinished?: boolean };
      if (raw.writableFinished === false) aborted();
      else finish();
    });
  }
}

const HANDLER_STARTED = Symbol.for('ex-mio:handler-started');

/**
 * D-24 / INV-STACK-8: the audit decision is the guards' authorization outcome, not the HTTP outcome.
 * Every guard (this entry point and any later one, such as payments' coin guard or engagement's
 * acting ban) runs before the interceptor that marks the handler as started. A request that ended
 * in an error WITHOUT reaching the handler was refused by a guard; once the handler started, its
 * own 403, 404, 409 or 500 is still an `allowed` call and the event carries the real status.
 */
export function auditDecision(req: object, status: number): 'allowed' | 'refused' {
  const handlerStarted = (req as Record<symbol, boolean | undefined>)[HANDLER_STARTED] === true;
  return !handlerStarted && status >= 400 ? 'refused' : 'allowed';
}

function auditMethod(method: string): 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | undefined {
  const m = method === 'HEAD' ? 'GET' : method;
  return AUDIT_METHODS.has(m) ? (m as 'GET') : undefined;
}

type InternalTenant = { ok: true; id: string } | { ok: false; message: string };

/** The tenant of an internal call: named once, in the path or the body, and a UUID. */
function tenantOfInternal(req: FastifyLike): InternalTenant {
  const fromPath =
    req.params && typeof req.params === 'object' ? req.params['tenantId'] : undefined;
  const body =
    req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : undefined;
  const fromBody = body?.['tenant_id'];
  const named = [fromPath, fromBody].filter((v) => v !== undefined);
  if (named.length === 0) return { ok: false, message: 'tenant_id is required' };
  for (const v of named) {
    if (!isTenantId(v)) return { ok: false, message: 'tenant_id must be a UUID' };
  }
  if (named.length === 2 && String(fromPath).toLowerCase() !== String(fromBody).toLowerCase()) {
    return { ok: false, message: 'tenant_id in the path and in the body differ' };
  }
  return { ok: true, id: String(named[0]).toLowerCase() };
}

// ---- interceptor -----------------------------------------------------------------------------

@Injectable()
export class ServiceAuthInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<object>();
    // Interceptors run after every guard: reaching this point means no guard refused (D-24).
    (req as Record<symbol, boolean>)[HANDLER_STARTED] = true;
    const auth = authOf(req);
    if (!auth) return next.handle();
    const tenant = (req as Record<symbol, TenantContext | undefined>)[
      Symbol.for('ex-mio:tenant-context')
    ];
    return new Observable((subscriber) =>
      authStorage.run(auth, () =>
        tenant
          ? runWithTenant(tenant, () => next.handle().subscribe(subscriber))
          : next.handle().subscribe(subscriber),
      ),
    );
  }
}

// ---- module ----------------------------------------------------------------------------------

/** Starts the 60 s audit sweeper for a port that holds events until finalize (D-21). */
@Injectable()
export class AuditSweeper implements OnModuleInit, OnApplicationShutdown {
  private stop: (() => void) | undefined;

  constructor(
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(SERVICE_AUTH_RUNTIME) private readonly rt: ServiceAuthRuntime,
  ) {}

  onModuleInit(): void {
    const port = this.rt.auditPort(this.moduleRef);
    if (typeof port.sweep === 'function') this.stop = startAuditSweeper({ sweep: port.sweep });
  }

  onApplicationShutdown(): void {
    this.stop?.();
  }
}

@Module({})
export class ServiceAuthModule {
  static forService(options: ServiceAuthOptions): DynamicModule {
    if (!options || typeof options !== 'object')
      throw new Error('ServiceAuthModule: options are required');
    for (const key of Object.keys(options)) {
      if (!ALLOWED_OPTIONS.has(key)) {
        throw new Error(`ServiceAuthModule: unknown option "${key}" (there is no resolver option)`);
      }
    }
    if (!ServiceName.safeParse(options.audience).success) {
      throw new Error('ServiceAuthModule: audience must be a service name');
    }
    if (!options.identityUrl) {
      for (const key of ['jwks', 'tenantStatus', 'auditPort'] as const) {
        if (typeof options[key] !== 'function') {
          throw new Error(`ServiceAuthModule: ${key} is required when there is no identityUrl`);
        }
      }
    }
    new ServiceAuthRuntime(options); // fail fast on an unusable option set (unknown audience, bad policy)
    return {
      module: ServiceAuthModule,
      providers: [
        { provide: SERVICE_AUTH_OPTIONS, useValue: options },
        // Built from the OPTIONS provider, so a test that overrides `SERVICE_AUTH_OPTIONS` (fixture
        // keys, tenant status, audit port, clock) changes what the real entry point uses.
        {
          provide: SERVICE_AUTH_RUNTIME,
          useFactory: (resolved: ServiceAuthOptions) => new ServiceAuthRuntime(resolved),
          inject: [SERVICE_AUTH_OPTIONS],
        },
        { provide: APP_GUARD, useClass: ServiceAuthGuard },
        { provide: APP_INTERCEPTOR, useClass: ServiceAuthInterceptor },
        AuditSweeper,
      ],
      exports: [SERVICE_AUTH_OPTIONS],
    };
  }
}
