// Unified error envelope for the shared HTTP client (ADR-0005 §7, §8).
//
// Design choice: a single thrown `HttpError`, NOT a `Result<T>` union.
// Every failure mode — an HTTP non-2xx response, a network/`fetch` rejection, a
// JSON-parse failure, or a schema-validation failure — is normalised into one
// `HttpError`, so callers only ever catch a single type. This is the shape that
// lands in TanStack Query's `error` state (ADR-0005 §4): query functions throw, the
// library catches. A `Result<T>` union would force every query function to
// unwrap-and-rethrow, fighting that integration, so we keep the throw model.

/** Stable, machine-readable cause for a failure. */
export type HttpErrorCode =
  | 'http_error' //        non-2xx response from the server
  | 'network_error' //     `fetch` rejected (offline, DNS, CORS, abort)
  | 'parse_error' //       a 2xx body was not valid JSON
  | 'validation_error' //  the body failed the supplied schema
  | 'config_error'; //     client misconfiguration (e.g. missing base URL)

export interface HttpErrorInit {
  /** HTTP status code, or `0` for client-side / non-HTTP failures. */
  status: number;
  /** A {@link HttpErrorCode}, or a server-supplied code string. */
  code: HttpErrorCode | string;
  message: string;
  /** Optional field-level detail (schema issues, server validation errors). */
  issues?: unknown;
  /** The original error, preserved for debugging. */
  cause?: unknown;
}

/**
 * The single error type every `http` call rejects with. Carries the normalised
 * `{ status, code, message, issues? }` envelope.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: HttpErrorCode | string;
  readonly issues?: unknown;

  constructor(init: HttpErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'HttpError';
    this.status = init.status;
    this.code = init.code;
    this.issues = init.issues;
    // Restore the prototype chain so `instanceof HttpError` survives transpilation
    // to older targets (a well-known `extends Error` footgun).
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

/** Narrowing helper for `catch` blocks. */
export function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError;
}
