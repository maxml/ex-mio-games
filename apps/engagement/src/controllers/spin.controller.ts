import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';
import { z } from 'zod';
import { MySpinsResponse, PublicWheel, SpinRequest, SpinResponse, Uuid } from '@ex-mio/contracts';
import { SpinService } from '../services/spin.service';

/** The engagement error contract answers a schema failure with 422, not the 400 of `parseInput`. */
function parse422<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new UnprocessableEntityException({
      message: 'validation failed',
      issues: result.error.issues,
    });
  }
  return result.data;
}

const IdempotencyKey = z.string().min(1).max(200);

/**
 * The tenant and the player come only from the verified access token (the shared service-kit auth
 * entry point sets the ambient context): no header, query parameter or body field names a user.
 * Every output is parsed with its strict contract, so a service that leaks a field is a 500.
 */
@Controller('v1')
export class SpinController {
  constructor(private readonly spins: SpinService) {}

  @Post('spins')
  @HttpCode(201)
  async spin(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<SpinResponse> {
    const request = parse422(SpinRequest, body ?? {});
    const idempotencyKey = IdempotencyKey.safeParse(key);
    if (!idempotencyKey.success) throw new BadRequestException('Idempotency-Key header required');
    const result = await this.spins.spin({
      idempotencyKey: idempotencyKey.data,
      ...(request.credit_id !== undefined ? { creditId: request.credit_id } : {}),
    });
    return SpinResponse.parse(result);
  }

  @Get('wheel/:wheelId')
  async wheel(@Param('wheelId') wheelId: string): Promise<PublicWheel> {
    const id = parse422(Uuid, wheelId);
    return PublicWheel.parse(await this.spins.wheel(id));
  }

  @Get('me/spins')
  async mySpins(): Promise<MySpinsResponse> {
    return MySpinsResponse.parse(await this.spins.availableSpins());
  }
}
