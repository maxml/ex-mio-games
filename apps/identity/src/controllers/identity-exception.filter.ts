import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { reportError } from '@ex-mio/service-kit';
import { IdentityError } from '../errors';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'TOKEN_INVALID',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
};

/** Every error leaves as `IdentityErrorBody`: `{code, message, issues?}`. */
@Catch()
export class IdentityExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse();
    if (exception instanceof IdentityError) {
      reply.status(exception.status).send({ code: exception.code, message: exception.message });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const body = typeof res === 'string' ? { message: res } : (res as Record<string, unknown>);
      reply.status(status).send({
        ...body,
        code: typeof body.code === 'string' ? body.code : (CODE_BY_STATUS[status] ?? 'ERROR'),
        message: typeof body.message === 'string' ? body.message : exception.message,
      });
      return;
    }
    const fastifyStatus = (exception as { statusCode?: number })?.statusCode;
    if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
      reply.status(fastifyStatus).send({
        code: CODE_BY_STATUS[fastifyStatus] ?? 'ERROR',
        message: 'bad request',
      });
      return;
    }
    reportError(exception);
    reply.status(500).send({ code: 'INTERNAL', message: 'Internal server error' });
  }
}
