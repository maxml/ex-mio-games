import { HttpException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

const IdempotencyKey = z.string().trim().min(8).max(128);

/** The `Idempotency-Key` header: 8..128 characters, or a 400 `idempotency_key_required`. */
export function requireIdempotencyKey(header: unknown): string {
  const parsed = IdempotencyKey.safeParse(header);
  if (!parsed.success) {
    throw new HttpException(
      {
        code: 'idempotency_key_required',
        message: 'Idempotency-Key header (8..128 chars) is required',
      },
      400,
    );
  }
  return parsed.data;
}

/** Answer with the stored status of an idempotent call and flag a replay. */
export function answer<T>(
  reply: FastifyReply,
  result: { status: number; body: T; replayed: boolean },
): T {
  void reply.status(result.status);
  if (result.replayed) void reply.header('idempotent-replayed', 'true');
  return result.body;
}
