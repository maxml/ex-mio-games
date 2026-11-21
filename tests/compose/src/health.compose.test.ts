import { HealthCheck } from '@ex-mio/contracts';
import { pgAs, urls } from './env';

describe('health smoke', () => {
  it.each([
    ['identity', urls.identity],
    ['engagement', urls.engagement],
    ['payments', urls.payments],
    ['casino-sim', urls.casinoSim],
  ])(
    '%s answers /healthz/live and /healthz/ready with the shared contract',
    async (_name, base) => {
      for (const path of ['/healthz/live', '/healthz/ready']) {
        const res = await fetch(`${base}${path}`);
        expect(res.status).toBe(200);
        const body = HealthCheck.parse(await res.json());
        expect(body.status).toBe('ok');
      }
    },
  );

  it('the services report their dependencies as ok on /healthz/ready', async () => {
    const res = await fetch(`${urls.engagement}/healthz/ready`);
    const body = HealthCheck.parse(await res.json());
    expect(Object.keys(body.checks).sort()).toEqual(['amqp', 'db', 'redis']);
    expect(Object.values(body.checks).every((c) => c.status === 'ok')).toBe(true);
  });

  it('web answers /health', async () => {
    const res = await fetch(`${urls.web}/health`);
    expect(res.status).toBe(200);
  });
});

describe('database roles', () => {
  it('each service role is not a superuser and does not bypass row-level security', async () => {
    const admin = await pgAs('postgres');
    try {
      const { rows } = await admin.query(
        `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles
         WHERE rolname IN ('identity', 'engagement', 'payments') ORDER BY rolname`,
      );
      expect(rows.map((r) => r.rolname)).toEqual(['engagement', 'identity', 'payments']);
      for (const r of rows) {
        expect([r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb]).toEqual([
          false,
          false,
          false,
          false,
        ]);
      }
    } finally {
      await admin.end();
    }
  });

  it('a service role cannot connect to another service database', async () => {
    await expect(
      (async () => {
        const { Client } = await import('pg');
        const c = new Client({
          host: 'localhost',
          port: Number(process.env.POSTGRES_PORT ?? 54329),
          user: 'identity',
          password: 'identity-dev',
          database: 'payments',
        });
        await c.connect();
        await c.end();
      })(),
    ).rejects.toThrow(/permission denied|not allowed/);
  });
});
