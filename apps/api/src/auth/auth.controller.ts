import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AUTH } from '../app.tokens';
import { DuplicateUserError } from '../db';
import {
  authSessionOpenApiSchema,
  authUserOpenApiSchema,
  messageOpenApiSchema,
  passwordLoginInputOpenApiSchema,
  passwordRegisterInputOpenApiSchema,
  validationErrorOpenApiSchema,
} from '../common/openapi';
import { parseBody } from '../common/parse-body';
import {
  clearOAuthStateCookie,
  createOAuthStateCookie,
  getBearerToken,
  getOAuthStateVerifier,
  type AuthService,
  type AuthUser,
} from './index';

const PasswordRegisterInput = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(100).optional(),
});
const PasswordLoginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

@ApiTags('auth')
@Controller('/api/auth')
export class AuthController {
  constructor(@Inject(AUTH) private readonly auth: AuthService) {}

  @Get('/me')
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      required: ['user'],
      properties: { user: authUserOpenApiSchema },
    },
  })
  @ApiResponse({ status: 401, schema: messageOpenApiSchema })
  async me(@Headers('authorization') authorization?: string): Promise<{ user: AuthUser }> {
    const token = getBearerToken(authorization);
    const user = token ? await this.auth.verifyToken(token) : null;
    if (!user) {
      throw new HttpException({ message: 'unauthorized' }, 401);
    }
    return { user };
  }

  @Post('/register')
  @HttpCode(201)
  @ApiBody({ schema: passwordRegisterInputOpenApiSchema })
  @ApiResponse({ status: 201, schema: authSessionOpenApiSchema })
  @ApiResponse({ status: 400, schema: validationErrorOpenApiSchema })
  @ApiResponse({ status: 404, schema: messageOpenApiSchema })
  @ApiResponse({ status: 409, schema: messageOpenApiSchema })
  async register(@Body() body: unknown) {
    if (!this.auth.registerWithPassword) {
      throw new HttpException({ message: 'custom auth flow unavailable' }, 404);
    }

    try {
      return await this.auth.registerWithPassword(parseBody(PasswordRegisterInput, body));
    } catch (err: unknown) {
      if (err instanceof DuplicateUserError) {
        throw new HttpException({ message: 'email already exists' }, 409);
      }
      throw err;
    }
  }

  @Post('/login')
  @HttpCode(200)
  @ApiBody({ schema: passwordLoginInputOpenApiSchema })
  @ApiResponse({ status: 200, schema: authSessionOpenApiSchema })
  @ApiResponse({ status: 400, schema: validationErrorOpenApiSchema })
  @ApiResponse({ status: 401, schema: messageOpenApiSchema })
  @ApiResponse({ status: 404, schema: messageOpenApiSchema })
  async login(@Body() body: unknown) {
    if (!this.auth.loginWithPassword) {
      throw new HttpException({ message: 'custom auth flow unavailable' }, 404);
    }

    const session = await this.auth.loginWithPassword(parseBody(PasswordLoginInput, body));
    if (!session) {
      throw new HttpException({ message: 'invalid credentials' }, 401);
    }
    return session;
  }

  @Post('/logout')
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Logged out' })
  @ApiResponse({ status: 401, schema: messageOpenApiSchema })
  @ApiResponse({ status: 404, schema: messageOpenApiSchema })
  async logout(@Headers('authorization') authorization?: string): Promise<void> {
    if (!this.auth.logout) {
      throw new HttpException({ message: 'custom auth flow unavailable' }, 404);
    }

    const token = getBearerToken(authorization);
    if (!token) {
      throw new HttpException({ message: 'unauthorized' }, 401);
    }
    await this.auth.logout(token);
  }

  @Get('/google/start')
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      required: ['authorizationUrl'],
      properties: { authorizationUrl: { type: 'string', format: 'uri' } },
    },
  })
  @ApiResponse({ status: 400, schema: messageOpenApiSchema })
  @ApiResponse({ status: 404, schema: messageOpenApiSchema })
  async googleStart(
    @Query('redirectOrigin') redirectOrigin?: string,
    @Res({ passthrough: true }) response?: { header(name: string, value: string): void },
  ) {
    if (!this.auth.createGoogleAuthorizationUrl) {
      throw new HttpException({ message: 'custom auth flow unavailable' }, 404);
    }
    try {
      const { authorizationUrl, stateVerifier } = await this.auth.createGoogleAuthorizationUrl({
        redirectOrigin,
      });
      response?.header('set-cookie', createOAuthStateCookie(stateVerifier));
      return { authorizationUrl };
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('redirect origin')) {
        throw new HttpException({ message: err.message }, 400);
      }
      throw err;
    }
  }

  @Get('/google/callback')
  @ApiResponse({ status: 200, schema: authSessionOpenApiSchema })
  @ApiResponse({ status: 302, description: 'Redirects when redirectOrigin is present' })
  @ApiResponse({ status: 400, schema: messageOpenApiSchema })
  @ApiResponse({ status: 404, schema: messageOpenApiSchema })
  async googleCallback(
    @Res()
    response: {
      header(name: string, value: string): void;
      status(code: number): { send(body?: unknown): void };
    },
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Headers('cookie') cookie?: string,
  ) {
    if (!this.auth.completeGoogleOAuth) {
      throw new HttpException({ message: 'custom auth flow unavailable' }, 404);
    }
    const stateVerifier = getOAuthStateVerifier(cookie);
    if (!code || !state || !stateVerifier) {
      throw new HttpException({ message: 'missing Google OAuth callback parameters' }, 400);
    }
    let session;
    try {
      session = await this.auth.completeGoogleOAuth({ code, state, stateVerifier });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Google OAuth state')) {
        throw new HttpException({ message: err.message }, 400);
      }
      throw err;
    }
    response.header('set-cookie', clearOAuthStateCookie());
    if (session.redirectOrigin) {
      const redirectUrl = new URL(session.redirectOrigin);
      redirectUrl.hash = new URLSearchParams({ auth_token: session.token }).toString();
      response.header('location', redirectUrl.toString());
      response.status(302).send();
      return;
    }
    response.status(200).send(session);
  }
}
