# Log redaction

Varta telemetry section 3.1: no secrets or PII in logs. Redaction is an allow-list, applied in one
place: `packages/logger/src/redact.ts`, wired into pino as `formatters.log` (the object) and
`hooks.logMethod` (the message string).

## Rules

- **Keys.** Only the keys listed in `ALLOWED_TOP` (the Varta log-line fields, the product-event
  envelope, `port`, `url`, `code`, `status`, `duration_ms`) keep their value. Any other key stays in
  the line so an operator can see something was logged, but its value, however deeply nested, is
  `[redacted]`. A new field is therefore hidden until someone adds it to the list on purpose.
- **Nested.** `http` allows `method`, `route`, `status`, `duration_ms`; `err` allows `type`, `message`,
  `stack`; `props` allows any key with scalar values (the contracts schema has already vetted them).
- **Strings that pass** (`msg`, `err.message`, `err.stack`, allowed values) are scrubbed: `Bearer`/`Basic`
  tokens (up to the next whitespace or quote, so commas stay inside), `authorization|password|token|
secret|api_key|x-api-key|cookie ...: value` pairs (this covers `util.inspect` output), everything after
  `?` or `#` in a URL, JWTs, and email addresses. Strings are clipped at 4096 characters.
- **Errors** are rebuilt as `{ type, message, stack }` from any error-like value (including one from
  another realm); pino's own `err` serializer is replaced by the identity so it cannot rewrite the shape.
- **Product events** go through the same logger, and their `props` are vetted first by
  `ProductEventProps` (see `docs/analytics.md`).

## Spans

No code in the repo sets span attributes yet. When one does, pass each string through `scrubString`
and each attribute key through the same allow-list idea; do not copy request headers or bodies.

## Tests

`packages/logger/src/review-final-redaction.test.ts` (REDACT-_, PROPS-_) and `logger.test.ts`.
