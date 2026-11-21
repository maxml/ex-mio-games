import type { StoreErrorCode } from '@ex-mio/contracts';

/** Errors the saga and its services throw on purpose. `code` is a stable `STORE_ERROR_CODES` key. */
export class SagaError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'SagaError';
  }
}
