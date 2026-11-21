import { PAYMENTS_ERROR_CODES, type PaymentsErrorCode } from '@ex-mio/contracts';

/**
 * A domain failure with a defined code and HTTP status (the codes of `PAYMENTS_ERROR_CODES`).
 * Anything else that is thrown is a defect and surfaces as a 500, never as a stored success.
 */
export class LedgerError extends Error {
  readonly httpStatus: number;

  constructor(
    readonly code: PaymentsErrorCode,
    message?: string,
  ) {
    super(message ?? code.replace(/_/g, ' '));
    this.name = 'LedgerError';
    this.httpStatus = PAYMENTS_ERROR_CODES[code];
  }
}
