import { HttpException } from '@nestjs/common';

/*
 * D-26 INV-AUD: every authorization refusal, from a guard or from a policy check inside a service,
 * is thrown as this error. ServiceAuthInterceptor marks the request when the handler's stream errors
 * with it, and `auditDecision` reads the mark, so the audit `decision` is `refused`.
 *
 * The status is 403, or 404 for a tenant-boundary refusal that must not reveal the resource.
 */
export class AuthorizationRefused extends HttpException {
  readonly code: string;

  constructor(input: { code: string; message?: string; status?: 403 | 404 }) {
    const status = input.status ?? 403;
    if (typeof input.code !== 'string' || input.code.length === 0) {
      throw new Error('AuthorizationRefused: a code is required');
    }
    if (status !== 403 && status !== 404) {
      throw new Error('AuthorizationRefused: the status is 403 or 404');
    }
    super({ code: input.code, message: input.message ?? input.code }, status);
    this.code = input.code;
  }
}
