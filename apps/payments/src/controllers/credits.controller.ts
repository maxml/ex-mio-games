import { Body, Controller, Get, Headers, HttpException, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CreateCreditRequest, HEADER_IDEMPOTENCY_KEY, type Credit } from '@ex-mio/contracts';
import { IdempotencyInFlightError, IdempotencyMismatchError } from '@ex-mio/idempotency';
import { parseInput } from '@ex-mio/service-kit';
import { z } from 'zod';
import { CreditsService } from '../services/credits.service';

const IdempotencyKey = z.string().trim().min(8).max(128);

@Controller('v1/credits')
export class CreditsController {
  constructor(private readonly credits: CreditsService) {}

  @Post()
  async create(
    @Body() body: unknown,
    @Headers(HEADER_IDEMPOTENCY_KEY) keyHeader: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Credit> {
    const input = parseInput(CreateCreditRequest, body);
    const key = parseInput(IdempotencyKey, keyHeader);
    try {
      const result = await this.credits.credit(input, key);
      void reply.status(result.status);
      if (result.replayed) void reply.header('idempotent-replayed', 'true');
      return result.body;
    } catch (err) {
      // 409 while the same key is in flight, 422 when the key is reused with another body.
      if (err instanceof IdempotencyInFlightError || err instanceof IdempotencyMismatchError) {
        throw new HttpException(err.message, err.httpStatus);
      }
      throw err;
    }
  }

  @Get()
  list(): Promise<Credit[]> {
    return this.credits.list();
  }
}
