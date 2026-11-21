import * as publicApi from './index';
import {
  clearOAuthStateCookie,
  createOAuthStateCookie,
  getBearerToken,
  getOAuthStateVerifier,
  type AuthService,
  type AuthSession,
  type AuthUser,
  type PasswordLoginInput,
  type PasswordRegistrationInput,
} from './index';

describe('auth public contract waist', () => {
  it('exports every runtime helper documented as part of the facade', () => {
    expect(publicApi).toEqual(
      expect.objectContaining({
        clearOAuthStateCookie,
        createOAuthStateCookie,
        getBearerToken,
        getOAuthStateVerifier,
      }),
    );
  });

  it('keeps the AuthService facade shape consumable by the API layer', async () => {
    const user: AuthUser = {
      id: 'user-1',
      email: 'user@example.com',
      name: null,
      provider: 'custom',
    };
    const session: AuthSession = {
      token: 'session-token',
      user,
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      redirectOrigin: 'https://app.example.com',
    };
    const registerInput: PasswordRegistrationInput = {
      email: 'user@example.com',
      password: 'secret',
      name: 'User',
    };
    const loginInput: PasswordLoginInput = {
      email: 'user@example.com',
      password: 'secret',
    };
    const auth: AuthService = {
      verifyToken: jest.fn(async () => user),
      registerWithPassword: jest.fn(async () => session),
      loginWithPassword: jest.fn(async () => session),
      logout: jest.fn(async () => undefined),
      createGoogleAuthorizationUrl: jest.fn(async () => ({
        authorizationUrl: 'https://accounts.example.com/oauth',
        stateVerifier: 'state-verifier',
      })),
      completeGoogleOAuth: jest.fn(async () => session),
    };

    await expect(auth.verifyToken('session-token')).resolves.toEqual(user);
    await expect(auth.registerWithPassword?.(registerInput)).resolves.toEqual(session);
    await expect(auth.loginWithPassword?.(loginInput)).resolves.toEqual(session);
    await expect(auth.logout?.('session-token')).resolves.toBeUndefined();
    await expect(
      auth.createGoogleAuthorizationUrl?.({ redirectOrigin: 'https://app.example.com' }),
    ).resolves.toMatchObject({
      authorizationUrl: expect.any(String),
      stateVerifier: expect.any(String),
    });
    await expect(
      auth.completeGoogleOAuth?.({
        code: 'code',
        state: 'state',
        stateVerifier: 'state-verifier',
      }),
    ).resolves.toEqual(session);
  });
});
