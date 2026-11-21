import { BadRequestException } from '@nestjs/common';
import type { ZodError, ZodType } from 'zod';

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (err: unknown) {
    if (isZodError(err)) {
      throw new BadRequestException({ message: 'validation failed', issues: err.issues });
    }
    throw err;
  }
}

function isZodError(err: unknown): err is ZodError {
  const maybeError = err as { name?: unknown; issues?: unknown };
  return maybeError.name === 'ZodError' && Array.isArray(maybeError.issues);
}
