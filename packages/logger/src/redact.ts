// Log redaction as an ALLOW-list (final review, starter item 10). A deny-list of secret key
// names leaks every key it does not know (`x-api-key`, `api_key`, a header two levels deep) and
// never reads a value. This module inverts it: only the keys listed below keep their value;
// every other key stays visible (so an operator sees that something was logged) with the value
// replaced by the censor. Strings that do pass are scrubbed for credential and PII shapes.

import { looksLikePhoneNumber, ProductEventProps } from '@ex-mio/contracts';

export const REDACT_CENSOR = '[redacted]';

/**
 * `props` keys a plain log line may carry (R3). A product event goes through the contracts schema
 * and keeps its keys; anything else that says `props` is an unvalidated map, so only these known
 * keys keep their value and every other key is censored.
 */
const ALLOWED_LOG_PROP_KEYS: ReadonlySet<string> = new Set([
  'sandbox',
  'environment',
  'source',
  'status',
  'role',
  'reason',
  'currency',
  'casino',
  'plan_code',
  'amount_minor',
  'coins',
  'reward_coins',
  'price_coins',
  'new_player',
  'launched',
  'rotated',
]);

/** Top-level keys whose value is written (after string scrubbing). Everything else is censored. */
const ALLOWED_TOP = new Set([
  // the Varta log-line shape
  'ts',
  'level',
  'service',
  'env',
  'version',
  'msg',
  'trace_id',
  'span_id',
  'http',
  'err',
  // the product-event envelope (props is validated by the contracts schema)
  'kind',
  'event_id',
  'event',
  'event_v',
  'tenant_id',
  'actor_type',
  'actor_id',
  'anon_id',
  'session_id',
  'consent',
  'actor_since',
  'props',
  // plain operational fields
  'port',
  'url',
  'code',
  'status',
  'duration_ms',
]);

/** Keys allowed one level down, for the structured parents. `props` allows any key (see below). */
const ALLOWED_CHILD: Record<string, ReadonlySet<string>> = {
  http: new Set(['method', 'route', 'status', 'duration_ms']),
  err: new Set(['type', 'message', 'stack']),
};

const MAX_STRING = 4096;

// Credential shapes inside free text. The token class stops at whitespace or a quote, never at a
// comma: `Bearer abc,scope=all` is one token.
const BEARER = /\b(bearer|basic)\s+[^\s"'`]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}(?:\.[A-Za-z0-9_-]*)?/g;
// `authorization: x`, `"api_key":"x"`, `{ token = 'x' }` and util.inspect output of the same.
const SECRET_PAIR =
  /((?:authorization|password|passwd|pwd|token|secret|cookie|set-cookie|api[_-]?key|x-api-key|client[_-]?secret|private[_-]?key|credential)s?['"`]?\s*[:=]\s*)(?:'[^']*'|"[^"]*"|`[^`]*`|[^\s,;}&#]+)/gi;
// Anything after `?` or `#` in a URL: query values and fragments carry tokens and emails.
const URL_TAIL = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'`]*)[?#][^\s"'`]*/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
// Prefixed API secrets (`sk_live_...`, `whsec_...`) and long opaque tokens (32+ letters and digits).
const API_SECRET = /\b(?:sk|pk|rk|whsec|ghp|gho|xox[abprs])_[A-Za-z0-9_-]{8,}/gi;
const OPAQUE_TOKEN = /\b(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{32,}\b/g;
// Phones: `+` and 8 or more digits (spaces, dashes and brackets inside), a bare run of 9 or more
// digits, or the US `(555) 123-4567` shape. Not preceded or followed by a word character or `-`, so
// a UUID group or an ISO date is left alone.
const PHONE =
  /(?<![\w-])(?:\+\d[\d ()-]{7,}\d|\d{9,}|\(?\d{3}\)?[ -]\d{3}[ -]\d{2,4}(?:[ -]\d{2})?)(?![\w-])/g;

/** Scrub credential and PII shapes out of a string that is allowed to be written. */
export function scrubString(value: string): string {
  const clipped = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  return clipped
    .replace(URL_TAIL, `$1?${REDACT_CENSOR}`)
    .replace(BEARER, `$1 ${REDACT_CENSOR}`)
    .replace(SECRET_PAIR, `$1${REDACT_CENSOR}`)
    .replace(JWT, REDACT_CENSOR)
    .replace(API_SECRET, REDACT_CENSOR)
    .replace(OPAQUE_TOKEN, REDACT_CENSOR)
    .replace(EMAIL, REDACT_CENSOR)
    .replace(PHONE, REDACT_CENSOR);
}

/** A `props` value: scalars only, strings scrubbed, a phone-length number censored. */
function scrubPropValue(value: unknown): unknown {
  if (typeof value === 'number' && looksLikePhoneNumber(value)) return REDACT_CENSOR;
  return scrubScalar(value);
}

function scrubScalar(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return REDACT_CENSOR;
}

/** Duck-typed: an Error from another realm (a VM context, a test runner) is not `instanceof Error`. */
export function isErrorLike(v: unknown): v is Error {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { message?: unknown }).message === 'string' &&
    typeof (v as { name?: unknown }).name === 'string'
  );
}

function errorShape(err: Error): Record<string, unknown> {
  return {
    type: err.name,
    message: scrubString(err.message),
    ...(err.stack ? { stack: scrubString(err.stack) } : {}),
  };
}

/** A key that is not on the allow-list: the structure stays visible, every leaf is censored. */
function censorDeep(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 4) return REDACT_CENSOR;
  if (Array.isArray(value)) return value.map((v) => censorDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = censorDeep(v, depth + 1);
  return out;
}

function scrubChild(parent: string, value: unknown, validatedProps = false): unknown {
  if (parent === 'err' && isErrorLike(value)) return errorShape(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return parent === 'err' ? scrubScalar(value) : REDACT_CENSOR;
  }
  const allowed = ALLOWED_CHILD[parent];
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (parent === 'props') {
      // Validated product-event props keep their keys; any other `props` is an unvalidated map.
      out[key] =
        validatedProps || ALLOWED_LOG_PROP_KEYS.has(key) ? scrubPropValue(v) : REDACT_CENSOR;
    } else {
      out[key] = allowed?.has(key) ? scrubScalar(v) : REDACT_CENSOR;
    }
  }
  return out;
}

/**
 * The log-object choke point (pino `formatters.log`). Allowed key: value scrubbed. Any other key:
 * value censored, key kept. Never throws.
 */
export function sanitizeLogObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue; // JSON drops it anyway
    if (!ALLOWED_TOP.has(key)) {
      out[key] = censorDeep(value);
    } else if (key === 'props') {
      const validated =
        obj['kind'] === 'product_event' && ProductEventProps.safeParse(value).success;
      out[key] = scrubChild(key, value, validated);
    } else if (key in ALLOWED_CHILD) {
      out[key] = scrubChild(key, value);
    } else if (
      (key === 'trace_id' && typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)) ||
      (key === 'span_id' && typeof value === 'string' && /^[0-9a-f]{16}$/.test(value))
    ) {
      out[key] = value; // OpenTelemetry ids: hex, not a credential, and the join key to the trace
    } else {
      out[key] = scrubScalar(value);
    }
  }
  return out;
}
