import { z } from 'zod';
import { PLATFORM_TENANT_ID, ServiceName } from './identity';
import { Uuid, Uuidv7, uuidv7 } from './ids';

/**
 * The event envelope every bus message carries. `tenant_id` is mandatory: there
 * is no tenant-less event. `correlation_id` ties a whole business flow together;
 * `causation_id` points at the event (or request) that directly caused this one.
 */
export const EventEnvelope = z.object({
  event_id: Uuidv7,
  type: z.string().min(1),
  version: z.number().int().positive(),
  tenant_id: Uuid,
  occurred_at: z.string().datetime(),
  correlation_id: Uuid,
  causation_id: Uuid.nullable(),
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

// ---- event types ------------------------------------------------------------
// One entry per (type, version). A payload change that is not backward
// compatible gets a new version, never an edit of the old schema. Names are
// `<owning-service>.<aggregate>.<past-tense-verb>`.

export const TenantCreatedV1 = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
});

export const PlayerRegisteredV1 = z.object({
  player_id: Uuid,
});

export const CoinsCreditedV1 = z.object({
  credit_id: Uuid,
  player_id: Uuid,
  amount: z.number().int().positive(),
});

export const SpinCompletedV1 = z.object({
  spin_id: Uuid,
  player_id: Uuid,
  reward_coins: z.number().int().nonnegative(),
});

export const RedemptionRequestedV1 = z.object({
  redemption_id: Uuid,
  player_id: Uuid,
  coins: z.number().int().positive(),
});

const HTTP_METHOD = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * D-11: written by the service-kit entry point of EVERY service for each request that carries an
 * acting claim, allowed or refused. Envelope `tenant_id` is the acting tenant. `route` is
 * `METHOD template` (never the raw URL, never the query string).
 */
export const ActingRequestAuditedV1 = z
  .object({
    actor_user_id: Uuid,
    actor_tenant_id: z.literal(PLATFORM_TENANT_ID),
    acting_tenant_id: Uuid,
    reason: z.string().min(1),
    service: ServiceName,
    method: HTTP_METHOD,
    route: z.string().regex(/^(GET|POST|PUT|PATCH|DELETE) \/[^?#\s]*$/),
    decision: z.enum(['allowed', 'refused']),
    status: z.number().int().min(100).max(599),
    request_id: z.string().min(1),
    occurred_at: z.string().datetime(),
  })
  .strict()
  .refine((p) => p.route.startsWith(`${p.method} `), { message: 'route must start with method' });

/**
 * D-14: written by the entry point of the CALLEE for each internal (service-token) request,
 * allowed or refused. Envelope `tenant_id` is the tenant named in the path or body (or the key's
 * tenant for the tenant-less webhook route, recorded as the platform tenant).
 */
export const ServiceCallAuditedV1 = z
  .object({
    caller_service: ServiceName,
    service: ServiceName,
    method: HTTP_METHOD,
    route: z.string().regex(/^(GET|POST|PUT|PATCH|DELETE) \/[^?#\s]*$/),
    decision: z.enum(['allowed', 'refused']),
    status: z.number().int().min(100).max(599),
    request_id: z.string().min(1),
    occurred_at: z.string().datetime(),
  })
  .strict()
  .refine((p) => p.route.startsWith(`${p.method} `), { message: 'route must start with method' });

export const EVENT_SCHEMAS = {
  'audit.acting_request': { 1: ActingRequestAuditedV1 },
  'audit.service_call': { 1: ServiceCallAuditedV1 },
  'identity.tenant.created': { 1: TenantCreatedV1 },
  'identity.player.registered': { 1: PlayerRegisteredV1 },
  'payments.coins.credited': { 1: CoinsCreditedV1 },
  'engagement.spin.completed': { 1: SpinCompletedV1 },
  'engagement.redemption.requested': { 1: RedemptionRequestedV1 },
} as const;

export type EventType = keyof typeof EVENT_SCHEMAS;
export const EVENT_TYPES = Object.keys(EVENT_SCHEMAS) as EventType[];

export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEventError';
  }
}

/**
 * Validate a raw message: the envelope first, then the payload against the
 * schema registered for (type, version). Unknown types and versions are
 * rejected, not passed through; a consumer that cannot understand a message
 * must not act on it.
 */
export function parseEvent(raw: unknown): EventEnvelope {
  const envelope = EventEnvelope.safeParse(raw);
  if (!envelope.success) {
    throw new InvalidEventError(`invalid envelope: ${envelope.error.message}`);
  }
  const versions = (EVENT_SCHEMAS as Record<string, Record<number, z.ZodTypeAny>>)[
    envelope.data.type
  ];
  const schema = versions?.[envelope.data.version];
  if (!schema) {
    throw new InvalidEventError(
      `unknown event type/version: ${envelope.data.type} v${envelope.data.version}`,
    );
  }
  const payload = schema.safeParse(envelope.data.payload);
  if (!payload.success) {
    throw new InvalidEventError(
      `invalid payload for ${envelope.data.type}: ${payload.error.message}`,
    );
  }
  return { ...envelope.data, payload: payload.data };
}

export interface NewEventInput<T extends EventType> {
  type: T;
  tenantId: string;
  payload: z.input<(typeof EVENT_SCHEMAS)[T][1]>;
  correlationId?: string;
  causationId?: string | null;
}

/** Build a validated v1 envelope with a fresh `event_id` and `occurred_at`. */
export function createEvent<T extends EventType>(input: NewEventInput<T>): EventEnvelope {
  return parseEvent({
    event_id: uuidv7(),
    type: input.type,
    version: 1,
    tenant_id: input.tenantId,
    occurred_at: new Date().toISOString(),
    correlation_id: input.correlationId ?? uuidv7(),
    causation_id: input.causationId ?? null,
    payload: input.payload,
  });
}
