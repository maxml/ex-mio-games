import {
  buildProductEvent,
  type ProductEventInput as ProductEventInputShape,
} from '@ex-mio/contracts';
import { logger as defaultLogger, type AppLogger } from './logger';

export type { ProductEventInputShape as ProductEventInput };

/**
 * Emit a product analytics event as one JSON line (`kind: "product_event"`) on the service's
 * stdout, next to ordinary log lines. The envelope is Varta's product-event schema (D-19): the
 * input is validated and a fresh UUIDv7 `event_id` is stamped, then the line is written. An event
 * that breaks the contract (no tenant, both or neither actor id, a PII prop key, a name without
 * `domain.object_action`, a line that could pass 8 KiB) throws instead of polluting the stream.
 *
 * Services call {@link emitProductEvent} (which never throws) after the transaction commits.
 */
export function logProductEvent(logger: AppLogger, event: ProductEventInputShape): void {
  const payload = buildProductEvent(event);
  // No message argument: pino would add `msg`, which Varta's collector strips from an event line.
  logger.info(payload);
}

let sink: AppLogger = defaultLogger;

/** Tests (and a service that owns its logger) point the emitter at a logger of their choice. */
export function setProductEventLogger(logger: AppLogger | undefined): void {
  sink = logger ?? defaultLogger;
}

/**
 * The service-layer entry point. An analytics failure must never fail a business request that has
 * already committed, so a rejected event is dropped and reported as one warn line instead.
 */
export function emitProductEvent(event: ProductEventInputShape): void {
  try {
    logProductEvent(sink, event);
  } catch (err) {
    sink.warn(
      {
        event: typeof event?.event === 'string' ? event.event : 'unknown',
        err: String(err).slice(0, 300),
      },
      'product_event_dropped',
    );
  }
}

/**
 * Emit an event for the actor of the current request: `auth` is the verified AuthContext
 * (`tryCurrentAuth()`), `tenantId` the tenant of the business row when it is known. Without an
 * auth context or a tenant the event is dropped with a warn line, like any other bad event.
 */
export function emitProductEventAs(
  auth: ProductAuth | undefined,
  event: Omit<ProductEventInputShape, 'tenant_id' | 'actor_type' | 'actor_id' | 'anon_id'> & {
    tenant_id?: string;
  },
): void {
  try {
    if (!auth) throw new Error('no auth context for the event actor');
    const { tenant_id, ...rest } = event;
    emitProductEvent({ ...rest, ...actorFromAuth(auth, tenant_id) });
  } catch (err) {
    sink.warn({ event: event.event, err: String(err).slice(0, 300) }, 'product_event_dropped');
  }
}

/** The structural part of service-kit's AuthContext the emitter needs. */
export interface ProductAuth {
  mode: 'user' | 'service';
  tenantId?: string;
  principalId: string;
  roles: readonly string[];
  acting?: { tenantId: string } | undefined;
  service?: string | undefined;
  /** INV-ENV-INPUT: required; the actor's environment (a boolean, as a Varta prop). */
  sandbox: boolean;
}

/**
 * Actor and tenant of an event, from the verified AuthContext (never from a body or header).
 * `actor_id` is the internal principal id (a UUID or a service name), never an email.
 * An acting platform admin is attributed to the tenant it acts in.
 */
export function actorFromAuth(
  auth: ProductAuth,
  tenantId?: string,
): Pick<ProductEventInputShape, 'tenant_id' | 'actor_type' | 'actor_id'> {
  const tenant = tenantId ?? auth.acting?.tenantId ?? auth.tenantId;
  if (!tenant) throw new Error('product event needs a tenant');
  if (auth.mode === 'service') {
    return { tenant_id: tenant, actor_type: 'service', actor_id: auth.service ?? auth.principalId };
  }
  const roles = auth.roles;
  const actorType = roles.includes('player')
    ? 'player'
    : roles.includes('platform_admin')
      ? 'platform_admin'
      : 'operator';
  return { tenant_id: tenant, actor_type: actorType, actor_id: auth.principalId };
}
