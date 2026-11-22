// Log redaction as an ALLOW-list (final review, starter item 10). A deny-list of secret key
// names leaks every key it does not know (`x-api-key`, `api_key`, a header two levels deep) and
// never reads a value. This module inverts it: only the keys listed below keep their value;
// every other key stays visible (so an operator sees that something was logged) with the value
// replaced by the censor. Strings that do pass are scrubbed for credential and PII shapes.

export const REDACT_CENSOR = '[redacted]';

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

/** Scrub credential and PII shapes out of a string that is allowed to be written. */
export function scrubString(value: string): string {
  const clipped = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  return clipped
    .replace(URL_TAIL, `$1?${REDACT_CENSOR}`)
    .replace(BEARER, `$1 ${REDACT_CENSOR}`)
    .replace(SECRET_PAIR, `$1${REDACT_CENSOR}`)
    .replace(JWT, REDACT_CENSOR)
    .replace(EMAIL, REDACT_CENSOR);
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

function scrubChild(parent: string, value: unknown): unknown {
  if (parent === 'err' && isErrorLike(value)) return errorShape(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return parent === 'err' ? scrubScalar(value) : REDACT_CENSOR;
  }
  const allowed = ALLOWED_CHILD[parent];
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    // `props`: any key, scalar values only. The contracts schema already refused unknown shapes.
    out[key] = parent === 'props' || allowed?.has(key) ? scrubScalar(v) : REDACT_CENSOR;
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
    } else if (key in ALLOWED_CHILD || key === 'props') {
      out[key] = scrubChild(key, value);
    } else {
      out[key] = scrubScalar(value);
    }
  }
  return out;
}
