import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { reportError } from './error-reporter';

@Catch()
export class ReportingExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).send(exception.getResponse());
      return;
    }

    reportError(exception);
    // Do not leak the raw error text (SQL/driver/config detail) to the client;
    // the exception is already reported for operators. Unhandled = 500 = generic.
    response.status(500).send({ message: 'Internal server error' });
  }
}
