import * as publicApi from './index';
import { CreateUserInput, DependencyHealth, HealthCheck, HealthStatus, User } from './index';

describe('shared-types HTTP public contract waist', () => {
  it('exports every documented HTTP schema from the package barrel', () => {
    expect(publicApi).toEqual(
      expect.objectContaining({
        User,
        CreateUserInput,
        HealthStatus,
        DependencyHealth,
        HealthCheck,
      }),
    );
  });

  it('keeps the documented HTTP wire schemas stable', () => {
    expect(
      User.parse({
        id: 'user-1',
        email: 'user@example.com',
        name: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toMatchObject({
      id: 'user-1',
      email: 'user@example.com',
      name: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(CreateUserInput.safeParse({ email: 'invalid', name: '' }).success).toBe(false);
    expect(CreateUserInput.safeParse({ email: 'new@example.com', name: 'New User' }).success).toBe(
      true,
    );

    expect(
      HealthCheck.parse({
        status: 'degraded',
        uptime: 123,
        version: '1.0.0',
        gitSha: 'deadbeefcafebabe',
        checks: {
          db: { status: 'ok', latencyMs: 12 },
          cache: { status: 'down', error: 'unreachable' },
        },
      }),
    ).toMatchObject({
      status: 'degraded',
      gitSha: 'deadbeefcafebabe',
      checks: {
        db: { status: 'ok', latencyMs: 12 },
        cache: { status: 'down', error: 'unreachable' },
      },
    });

    // `gitSha` is optional: a project without the deploy plane omits it and the
    // payload still validates, with `gitSha` left undefined.
    const withoutGitSha = HealthCheck.parse({
      status: 'ok',
      uptime: 1,
      version: '1.0.0',
      checks: {},
    });
    expect(withoutGitSha.gitSha).toBeUndefined();
  });
});
