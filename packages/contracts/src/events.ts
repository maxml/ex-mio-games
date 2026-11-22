import { z } from 'zod';
import { PLATFORM_TENANT_ID, ServiceName } from './identity';
import { Uuid, Uuidv7, uuidv7 } from './ids';
import { DepositConfirmedV1, SpinGrantedV1 } from './ingest';
import { CoinsCapturedV1, CoinsRefundedV1, CoinsReleasedV1, CoinsReservedV1 } from './payments';
import {
  RedemptionIssuedV1,
  RedemptionNeedsReviewV1,
  RedemptionRejectedV1,
  RedemptionStatusChangedV1,
} from './store';

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
  /**
   * D-13. Set by the PRODUCER from its server-side context (the verifying key of a sandbox
   * tenant), never copied from a payload or a client header. A consumer that meters or bills
   * reads this flag and nothing else. Required (INV-ENV-INPUT): an envelope without it is invalid.
   */
  sandbox: z.boolean(),
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
  /** Reward table version the spin was drawn from (D-1, X-16). Required: it is the audit trail. */
  table_version: z.number().int().positive(),
});

export const RedemptionRequestedV1 = z.object({
  redemption_id: Uuid,
  player_id: Uuid,
  coins: z.number().int().positive(),
});

const HTTP_METHOD = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * D-21: `aborted` is what the entry point's sweeper publishes for a request whose audit intent was
 * never finalized (the handler hung or the process died). It is never published for a finished one.
 */
const AUDIT_DECISION = z.enum(['allowed', 'refused', 'aborted']);

/**
 * D-11: written by the service-kit entry point of EVERY service for each request that carries an
 * acting claim, allowed or refused. Envelope `tenant_id` is the acting tenant. `route` is
 * `METHOD template` (never the raw URL, never the query string).
 * Naming exception (Q-3, coordinator D-15): `audit.acting_request` is the one cross-service event
 * that does not follow `<owning-service>.<aggregate>.<past-tense-verb>`, because every service
 * produces it.
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
    decision: AUDIT_DECISION,
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
    decision: AUDIT_DECISION,
    status: z.number().int().min(100).max(599),
    request_id: z.string().min(1),
    occurred_at: z.string().datetime(),
  })
  .strict()
  .refine((p) => p.route.startsWith(`${p.method} `), { message: 'route must start with method' });

export const EVENT_SCHEMAS = {
  'audit.acting_request': { 1: ActingRequestAuditedV1 },
  'audit.service_call': { 1: ServiceCallAuditedV1 },
  'engagement.deposit.confirmed': { 1: DepositConfirmedV1 },
  'engagement.redemption.issued': { 1: RedemptionIssuedV1 },
  'engagement.redemption.needs_review': { 1: RedemptionNeedsReviewV1 },
  'engagement.redemption.rejected': { 1: RedemptionRejectedV1 },
  'engagement.redemption.requested': { 1: RedemptionRequestedV1 },
  'engagement.redemption.status_changed': { 1: RedemptionStatusChangedV1 },
  'engagement.spin.completed': { 1: SpinCompletedV1 },
  'engagement.spin.granted': { 1: SpinGrantedV1 },
  'identity.player.registered': { 1: PlayerRegisteredV1 },
  'identity.tenant.created': { 1: TenantCreatedV1 },
  'payments.coins.captured': { 1: CoinsCapturedV1 },
  'payments.coins.credited': { 1: CoinsCreditedV1 },
  'payments.coins.refunded': { 1: CoinsRefundedV1 },
  'payments.coins.released': { 1: CoinsReleasedV1 },
  'payments.coins.reserved': { 1: CoinsReservedV1 },
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
  /** D-13/FX-1: from the producer's server-side context only. Required, always written (INV-ENV-INPUT). */
  sandbox: boolean;
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
    sandbox: input.sandbox,
    payload: input.payload,
  });
}
