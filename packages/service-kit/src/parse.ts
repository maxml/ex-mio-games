import { BadRequestException } from '@nestjs/common';
import type { ZodError, ZodTypeDef, ZodType } from 'zod';

/**
 * Validate one controller input (body, params, query or header) against its zod
 * schema. A failure is a 400 with the zod issues; nothing reaches the service
 * layer unparsed.
 */
export function parseInput<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown): T {
  try {
    return schema.parse(value);
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
