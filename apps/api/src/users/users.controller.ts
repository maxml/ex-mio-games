import { Body, Controller, Get, HttpCode, HttpException, Inject, Post } from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CreateUserInput } from '@ex-mio/shared-types';
import type { CreateUserInput as CreateUserInputDto, User } from '@ex-mio/shared-types';
import { DATABASE } from '../app.tokens';
import { DuplicateUserError, type AppDatabase } from '../db';
import {
  createUserInputOpenApiSchema,
  messageOpenApiSchema,
  userOpenApiSchema,
  validationErrorOpenApiSchema,
} from '../common/openapi';
import { parseBody } from '../common/parse-body';

@ApiTags('users')
@Controller('/api/users')
export class UsersController {
  constructor(@Inject(DATABASE) private readonly database: AppDatabase) {}

  @Get()
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      required: ['users'],
      properties: { users: { type: 'array', items: userOpenApiSchema } },
    },
  })
  async listUsers(): Promise<{ users: User[] }> {
    return { users: await this.database.listUsers() };
  }

  @Post()
  @HttpCode(201)
  @ApiBody({ schema: createUserInputOpenApiSchema })
  @ApiResponse({ status: 201, schema: userOpenApiSchema })
  @ApiResponse({ status: 400, schema: validationErrorOpenApiSchema })
  @ApiResponse({ status: 409, schema: messageOpenApiSchema })
  async createUser(@Body() body: unknown): Promise<User> {
    const input: CreateUserInputDto = parseBody(CreateUserInput, body);

    try {
      return await this.database.createUser(input);
    } catch (err: unknown) {
      if (err instanceof DuplicateUserError) {
        throw new HttpException({ message: 'email already exists' }, 409);
      }
      throw err;
    }
  }
}
