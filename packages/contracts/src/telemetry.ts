import { z } from 'zod';
import { uuidv7 } from './ids';

// Varta telemetry contract shapes (see api/TELEMETRY_CONTRACT.md).
// These schemas describe the wire shapes a project emits so Varta can watch it;
// the project never depends on Varta at runtime — it just conforms to these.

// §3.1 — the fixed log-level enum. MUST be closed so Varta can alert on
// `error`/`fatal` rates.
export const LogLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export type LogLevel = z.infer<typeof LogLevel>;

// §3.1 — one structured JSON log line (one object per line, to stdout/stderr).
export const LogLine = z.object({
  ts: z.string().datetime(), // ISO-8601 UTC
  level: LogLevel,
  service: z.string(), // = service.name (§6)
  env: z.string(), // = deployment.environment (§6)
  version: z.string(), // = release (§6)
  msg: z.string(),
  // When tracing is on, these link a log line to its trace and back (§3.1).
  trace_id: z.string().optional(),
  span_id: z.string().optional(),
  // Present on request-scoped lines.
  http: z
    .object({
      method: z.string(),
      route: z.string(),
      status: z.number().int(),
      duration_ms: z.number(),
    })
    .optional(),
  // Present only on error lines.
  err: z
    .object({
      type: z.string(),
      message: z.string(),
      stack: z.string().optional(),
    })
    .optional(),
});
export type LogLine = z.infer<typeof LogLine>;

// A product analytics event, written to stdout as one JSON line with
// `kind: "product_event"` so the log collector can route it apart from ordinary
// log lines. The envelope follows Varta's product-event schema (D-19, vendored at
// `packages/contracts/schemas/varta-product-event.schema.json`, TELEMETRY_CONTRACT
// section 11): a closed key list. The 8 KiB line limit is enforced by the emitter.

const ID_CHARS = /^[A-Za-z0-9._:|/+=~-]+$/;
const ASCII_WS = '[ \\t\\n\\r]';

// props key and value rules, copied from the vendored schema (RE2-safe: no \d, \s, lookaround).
const PII_EXACT_KEY =
  /^(email|emails|e_mail|mail|user_mail|useremail|phone|phones|phone_number|mobile|msisdn|ip|ips|ip_address|ipv4|ipv6|remote_addr|client_ip|wallet|wallet_address|address|street_address|home_address|card|card_number|cc_number|ccnum|pan|cvv|cvc|iban|password|passwd|pwd|token|access_token|refresh_token|api_key|apikey|secret|client_secret|ssn|tax_id|passport|first_name|last_name|full_name|date_of_birth|dob|birthdate|email_address|billing_address|shipping_address|mobile_number|username|user_name|display_name|birthday|ip_addr|phone_no|passport_number|national_id|private_key|seed_phrase|mnemonic|jwt)$/;
const PII_SUFFIX_KEY =
  /_(email|phone|ip|ip_address|password|token|secret|card_number|address|phone_number|iban|cvv|first_name|last_name)$/;
const PII_FLAG_PREFIX = /^(has|is|uses|show|verified|confirmed)_/;
const PII_FLAG_KEY =
  /^(has|is|uses|show|verified|confirmed)(_[a-z0-9_]*)?_(email|phone|ip|ip_address|password|token|secret|card_number|address|phone_number|iban|cvv|first_name|last_name)$/;
const JSON_TEXT = new RegExp(
  `^${ASCII_WS}*(\\{(?:${ASCII_WS}|[^ \\t\\n\\r])*\\}|\\[(?:${ASCII_WS}|[^ \\t\\n\\r])*\\])${ASCII_WS}*$`,
);
const EMAIL_TEXT = /^[ \t\n\r\f\v]*[^ \t\n\r\f\v@]+@[^ \t\n\r\f\v@]+\.[A-Za-z]{2,}[ \t\n\r\f\v]*$/;

// Final review, starter item 10: prop VALUES are an allow-list too. The old rule refused JSON text
// and an exact email, and missed an email followed by a zero-width space or `#`, a percent-encoded
// email in a nested URL, an Arabic-Indic phone number and a bearer token with commas. A text
// value now passes only when every character is on this list. Stricter than the vendored Varta
// schema on purpose: a stricter producer still conforms (D-19), and a refused key is dropped
// with its event, never rewritten.
const SAFE_PROP_TEXT = /^[A-Za-z0-9 _.:/[\]()-]{0,256}$/;
const LONG_DIGITS = /[0-9]{9,}/;

/**
 * The props map: flat scalars, snake_case keys, no `varta_` prefix, no PII-shaped key, and text
 * values from a closed character set (so no email, URL query, token or non-ASCII digits).
 */
export const ProductEventProps = z
  .record(z.union([z.string(), z.number(), z.boolean()]))
  .superRefine((props, ctx) => {
    for (const [key, value] of Object.entries(props)) {
      const bad = (message: string): void =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
      if (!/^[a-z][a-z0-9_]*$/.test(key) || key.length > 64) {
        bad('props key must be snake_case, up to 64 chars');
      } else if (key.startsWith('varta_')) {
        bad('props key must not start with varta_');
      } else if (PII_EXACT_KEY.test(key)) {
        bad('props key names PII');
      } else if (PII_SUFFIX_KEY.test(key) && !PII_FLAG_PREFIX.test(key)) {
        bad('props key names PII');
      }
      if (PII_FLAG_KEY.test(key) && typeof value !== 'boolean') bad('a PII-named flag is boolean');
      if (typeof value === 'string' && (JSON_TEXT.test(value) || EMAIL_TEXT.test(value))) {
        bad('props value must not be JSON text or an email address');
      }
      if (typeof value === 'string' && !SAFE_PROP_TEXT.test(value)) {
        bad('props text must be plain ASCII words (no @ # % , = ? & quotes, braces or non-ASCII)');
      } else if (typeof value === 'string' && LONG_DIGITS.test(value.replace(/[ ()._/:-]/g, ''))) {
        bad('props text must not carry a phone-, card- or id-length digit run');
      }
      if (typeof value === 'number' && !Number.isFinite(value)) bad('props number must be finite');
    }
  });
export type ProductEventProps = z.infer<typeof ProductEventProps>;

export const ProductEventConsent = z.enum(['analytics', 'essential']);

// The envelope keys an emitter supplies (shared by the input and the full line).
const eventShape = {
  event: z
    .string()
    .max(128)
    .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  event_v: z.number().int().min(1),
  tenant_id: z.string().min(1).max(48).regex(ID_CHARS),
  actor_type: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z][a-z0-9_]*$/),
  actor_id: z
    .string()
    .min(1)
    .max(96)
    .regex(ID_CHARS)
    .refine((v) => !/^anon:/i.test(v), 'actor_id must not start with anon:')
    .optional(),
  anon_id: z.string().min(1).max(91).regex(ID_CHARS).optional(),
  session_id: z.string().min(1).max(128).optional(),
  consent: ProductEventConsent,
  actor_since: z
    .string()
    .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
    .optional(),
  props: ProductEventProps.optional(),
};

const oneActor = (v: { actor_id?: string | undefined; anon_id?: string | undefined }): boolean =>
  (v.actor_id === undefined) !== (v.anon_id === undefined);
const ONE_ACTOR = { message: 'exactly one of actor_id and anon_id' };

/** What an emitter supplies; the logger adds `kind`, `event_id` and the logger fields. */
export const ProductEventInput = z
  .object({
    ...eventShape,
    event_v: eventShape.event_v.default(1),
    consent: eventShape.consent.default('essential'),
  })
  .strict()
  .refine(oneActor, ONE_ACTOR);
export type ProductEventInput = z.input<typeof ProductEventInput>;

/** The full stdout line: the input plus `kind`, `event_id` (UUIDv7) and the logger fields. */
export const ProductEventLine = z
  .object({
    ts: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/),
    level: LogLevel,
    service: z.string().min(1).max(128).optional(),
    env: z.string().min(1).max(64).optional(),
    version: z.string().min(1).max(128).optional(),
    trace_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
    span_id: z
      .string()
      .regex(/^[0-9a-f]{16}$/)
      .optional(),
    msg: z.string().max(1024).optional(),
    kind: z.literal('product_event'),
    event_id: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    ...eventShape,
  })
  .strict()
  .refine(oneActor, ONE_ACTOR);
export type ProductEventLine = z.infer<typeof ProductEventLine>;

/** The Varta limit: one event is one line of at most 8 KiB. */
export const PRODUCT_EVENT_MAX_LINE_BYTES = 8192;

// Room the logger adds on top of the validated envelope: ts, level, service, env, version, msg,
// trace_id and span_id, at their schema maxima.
const LOGGER_FIELDS_RESERVE_BYTES = 1024;

/**
 * The one place an event is validated and given its id: the emitter in `packages/logger` and the
 * web BFF (which writes its own line, without pino) both call it. Throws on anything the Varta
 * schema would reject, or on a line that could pass 8 KiB once the logger fields are added.
 */
export function buildProductEvent(input: ProductEventInput): {
  kind: 'product_event';
  event_id: string;
} & z.output<typeof ProductEventInput> {
  const parsed = ProductEventInput.parse(input);
  const payload = { kind: 'product_event' as const, event_id: uuidv7(), ...parsed };
  if (
    new TextEncoder().encode(JSON.stringify(payload)).length + LOGGER_FIELDS_RESERVE_BYTES >
    PRODUCT_EVENT_MAX_LINE_BYTES
  ) {
    throw new Error('product event line would exceed 8 KiB');
  }
  return payload;
}

// §2.1 — the `varta_build_info{service,version,git_sha,env} 1` gauge label set.
// A low-cardinality label set whose values carry the release identity (the
// standard "build_info" pattern). `git_sha`, not the mutable version tag, is the
// deploy-correlation key (§6).
export const BuildInfo = z.object({
  service: z.string(),
  version: z.string(),
  git_sha: z.string(),
  env: z.string(),
});
export type BuildInfo = z.infer<typeof BuildInfo>;
