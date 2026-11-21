import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { STORE_ERROR_CODES, type ErrorBody, type StoreErrorCode } from '@ex-mio/contracts';
import { ReportingExceptionFilter } from '@ex-mio/service-kit';

const MESSAGES: Record<StoreErrorCode, string> = {
  item_price_invalid: 'price must be a positive whole number of coins',
  item_not_found: 'item not found',
  item_inactive: 'item is not available',
  out_of_stock: 'item is out of stock',
  limit_reached: 'per-player limit reached',
  insufficient_funds: 'not enough coins',
  idempotency_key_reused: 'this idempotency key was already used for another item',
  idempotency_in_progress: 'a request with this key is still being processed, retry shortly',
  redemption_not_found: 'redemption not found',
  forbidden: 'not allowed',
  illegal_transition: 'this redemption cannot move to that state',
  release_not_allowed: 'the casino does not confirm that the reward was not issued',
};

const isStoreCode = (code: unknown): code is StoreErrorCode =>
  typeof code === 'string' && Object.hasOwn(STORE_ERROR_CODES, code);

/**
 * The error table of the store API: anything that carries a stable `code` of STORE_ERROR_CODES
 * (StoreRejection from the store, SagaError from the saga and services) becomes its HTTP status
 * and `{ message, code }`. Everything else goes to the shared filter (HTTP exceptions as they
 * are, anything else reported and answered 500 without internals).
 */
@Catch()
export class StoreErrorFilter implements ExceptionFilter {
  private readonly fallback = new ReportingExceptionFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    const code = (exception as { code?: unknown } | null)?.code;
    if (!(exception instanceof HttpException) && isStoreCode(code)) {
      const body: ErrorBody = { message: MESSAGES[code], code };
      host.switchToHttp().getResponse().status(STORE_ERROR_CODES[code]).send(body);
      return;
    }
    this.fallback.catch(exception, host);
  }
}
