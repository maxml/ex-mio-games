import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { IdempotencyInFlightError, IdempotencyMismatchError } from '@ex-mio/idempotency';
import { reportError } from '@ex-mio/service-kit';
import { LedgerError } from '../services/ledger.errors';
import { WebhookSignatureError } from '../services/providers/payment-provider';

interface Reply {
  status(code: number): { send(body: unknown): void };
}

/** Maps every failure to a defined status and `{ code, message }` body; the rest is a generic 500. */
@Catch()
export class PaymentsExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<Reply>();
    const send = (status: number, body: unknown) => reply.status(status).send(body);

    if (exception instanceof LedgerError) {
      return send(exception.httpStatus, { code: exception.code, message: exception.message });
    }
    if (exception instanceof WebhookSignatureError) {
      return send(401, { code: 'invalid_signature', message: exception.message });
    }
    if (exception instanceof IdempotencyInFlightError) {
      return send(409, { code: 'idempotency_in_progress', message: exception.message });
    }
    if (exception instanceof IdempotencyMismatchError) {
      return send(422, { code: 'idempotency_key_reused', message: exception.message });
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const body =
        typeof response === 'object' && response !== null
          ? (response as Record<string, unknown>)
          : { message: response };
      if (typeof body.code === 'string') return send(status, body);
      if (status === 400) return send(status, { ...body, code: 'validation_failed' });
      if (status === 403) return send(status, { ...body, code: 'forbidden' });
      return send(status, body);
    }
    reportError(exception);
    return send(500, { message: 'Internal server error' });
  }
}
