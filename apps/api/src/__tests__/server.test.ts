import { buildServer } from '../server';
import { reportError } from '../error-reporter';
import type { AppDatabase } from '../db';
import type { AuthService } from '../auth';

jest.mock('../error-reporter', () => ({
  reportError: jest.fn(),
}));

const reportErrorMock = jest.mocked(reportError);

const fakeDatabase: AppDatabase = {
  connect: jest.fn(),
  disconnect: jest.fn(),
  ping: jest.fn().mockResolvedValue('ok'),
  listUsers: jest.fn().mockResolvedValue([]),
  createUser: jest.fn(),
};
const fakeAuth: AuthService = {
  verifyToken: jest.fn().mockResolvedValue({
    id: 'user_123',
    email: 'user@example.com',
    provider: 'custom',
  }),
  registerWithPassword: jest.fn().mockResolvedValue({
    token: 'session-token',
    user: {
      id: 'user_123',
      email: 'user@example.com',
      provider: 'custom',
    },
    expiresAt: new Date('2026-06-03T00:00:00.000Z'),
  }),
  loginWithPassword: jest.fn().mockResolvedValue({
    token: 'session-token',
    user: {
      id: 'user_123',
      email: 'user@example.com',
      provider: 'custom',
    },
    expiresAt: new Date('2026-06-03T00:00:00.000Z'),
  }),
  logout: jest.fn().mockResolvedValue(undefined),
  createGoogleAuthorizationUrl: jest.fn().mockResolvedValue({
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
    stateVerifier: 'test-state-verifier',
  }),
  completeGoogleOAuth: jest.fn().mockResolvedValue({
    token: 'google-session-token',
    user: {
      id: 'user_google',
      email: 'google@example.com',
      provider: 'google',
    },
    expiresAt: new Date('2026-06-03T00:00:00.000Z'),
    redirectOrigin: 'http://localhost:3000',
  }),
};

describe('NestJS server', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /healthz returns ok when DB ping succeeds', async () => {
    const app = await buildServer({
      database: fakeDatabase,
      auth: fakeAuth,
      corsOrigin: '*',
      logLevel: 'silent',
    });
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/healthz',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.db.status).toBe('ok');
    expect(typeof body.checks.db.latencyMs).toBe('number');
    expect(body.version).toBeTruthy();
    expect(typeof body.uptime).toBe('number');
    await app.close();
  });

  it('GET /healthz surfaces the deploy gitSha when GIT_SHA is set', async () => {
    const previous = process.env.GIT_SHA;
    process.env.GIT_SHA = 'abc1234def5678';
    try {
      const app = await buildServer({
        database: fakeDatabase,
        auth: fakeAuth,
        corsOrigin: '*',
        logLevel: 'silent',
      });
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: '/healthz',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().gitSha).toBe('abc1234def5678');
      await app.close();
    } finally {
      if (previous === undefined) delete process.env.GIT_SHA;
      else process.env.GIT_SHA = previous;
    }
  });

  it('GET /healthz/live returns ok without touching dependencies', async () => {
    const database: AppDatabase = {
      ...fakeDatabase,
      ping: jest.fn(),
    };
    const app = await buildServer({
      database,
      auth: fakeAuth,
      corsOrigin: '*',
      logLevel: 'silent',
    });
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/healthz/live',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    expect(database.ping).not.toHaveBeenCalled();
    await app.close();
  });

  it('GET /healthz/ready returns 503 when DB is down', async () => {
    const downDatabase: AppDatabase = {
      ...fakeDatabase,
      ping: jest.fn().mockResolvedValue('down'),
    };
    const app = await buildServer({
      database: downDatabase,
      auth: fakeAuth,
      corsOrigin: '*',
      logLevel: 'silent',
    });
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/healthz/ready',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.db.status).toBe('down');
    await app.close();
  });

  it('GET /api/users returns the list', async () => {
    const app = await buildServer({
      database: fakeDatabase,
      auth: fakeAuth,
      corsOrigin: '*',
      logLevel: 'silent',
    });
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/users',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ users: [] });
    await app.close();
  });

  it('POST /api/users returns 400 for invalid input without reporting an error', async () => {
    const app = await buildServer({
      database: fakeDatabase,
      auth: fakeAuth,
      corsOrigin: '*',
      logLevel: 'silent',
    });
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/users',
        payload: { email: 'not-an-email' },
      });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('validation failed');
    expect(res.json().issues[0].path).toEqual(['email']);
    expect(reportErrorMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('GET /api/auth/me returns the current auth user', async () => {
    const app = await buildServer({
      database: fakeDatabase,
      auth: fakeAuth,
      corsOrigin: '*',
      logLevel: 'silent',
    });
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: 'Bearer test-token' },
      });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe('user_123');
    await app.close();
  });

  it('POST /api/auth/register creates a custom auth session', async () => {
    const app = await buildServer({
      database: fakeDatabase,
      auth: fakeAuth,
      corsOrigin: '*',
      logLevel: 'silent',
    });
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'user@example.com',
          password: 'password123',
          name: 'User',
        },
      });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toBe('session-token');
    await app.close();
  });

  it('POST /api/auth/login returns a custom auth session', async () => {
    const app = await buildServer({
      database: fakeDatabase,
      auth: fakeAuth,
      corsOrigin: '*',
      logLevel: 'silent',
    });
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'user@example.com',
          password: 'password123',
        },
      });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBe('session-token');
    await app.close();
  });

  it('GET /api/auth/google/start returns an authorization URL', async () => {
    const app = await buildServer({
      database: fakeDatabase,
      auth: fakeAuth,
      corsOrigin: '*',
      logLevel: 'silent',
    });
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/auth/google/start?redirectOrigin=http%3A%2F%2Flocalhost%3A3000',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authorizationUrl).toContain('accounts.google.com');
    expect(res.headers['set-cookie']).toContain('oauth_state_verifier=test-state-verifier');
    await app.close();
  });

  it('GET /api/auth/google/callback redirects with the token in the URL fragment', async () => {
    const app = await buildServer({
      database: fakeDatabase,
      auth: fakeAuth,
      corsOrigin: '*',
      logLevel: 'silent',
    });
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/api/auth/google/callback?code=code&state=state',
        headers: { cookie: 'oauth_state_verifier=test-state-verifier' },
      });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://localhost:3000/#auth_token=google-session-token');
    await app.close();
  });

  it('OpenAPI docs route exposes request and response schemas', async () => {
    const app = await buildServer({
      database: fakeDatabase,
      auth: fakeAuth,
      corsOrigin: '*',
      logLevel: 'silent',
    });
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/docs/json',
    });

    expect(res.statusCode).toBe(200);
    const spec = res.json();
    const createUser = spec.paths['/api/users'].post;
    expect(createUser.requestBody.content['application/json'].schema.required).toContain('email');
    expect(
      createUser.responses['201'].content['application/json'].schema.properties.email.format,
    ).toBe('email');
    expect(
      createUser.responses['400'].content['application/json'].schema.properties.issues,
    ).toBeTruthy();
    expect(spec.paths['/api/auth/register'].post.requestBody).toBeTruthy();
    await app.close();
  });
});
