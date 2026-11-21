import { IDENTITY_ERRORS, type IdentityErrorCode } from '@ex-mio/contracts';

/**
 * Every service error carries a `code` from IDENTITY_ERRORS. The exception filter maps it to the
 * HTTP status and the `IdentityErrorBody` shape; services never pick a status themselves.
 */
export class IdentityError extends Error {
  readonly status: number;
  constructor(
    readonly code: IdentityErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'IdentityError';
    this.status = IDENTITY_ERRORS[code];
  }
}

/** The data layer refused a duplicate: a unique key (named by `key`) already holds that value. */
export class UniqueViolationError extends Error {
  constructor(readonly key: string) {
    super(`unique violation: ${key}`);
    this.name = 'UniqueViolationError';
  }
}

/** The identity provider could not be reached or refused the call. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly conflict = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
