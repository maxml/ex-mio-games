# ex-mio-games

A multi-tenant engagement platform for online casinos: players spin a wheel and earn coins, operators run it
from a console. This repository is the full stack as a monorepo of small services, built from the monorepo
starter and extended with tenancy, an event bus and idempotent money handling.

This README covers running it. For the product and the decisions behind it start at [`AGENTS.md`](AGENTS.md)
and [`docs/README.md`](docs/README.md).

## Run it

You need Docker (with compose v2), Node 24 and pnpm 9. No external account is needed.

```sh
pnpm install --frozen-lockfile
docker compose up -d --wait      # builds the images and waits until every container is healthy
pnpm test:compose                # health, database roles, tenant isolation, idempotency, bus
docker compose down -v           # stop and delete the data
```

## What runs

| Container       | Host port          | Purpose                                                 |
| --------------- | ------------------ | ------------------------------------------------------- |
| `web`           | 3000               | Next.js app (player widget, operator console)           |
| `identity`      | 4001               | tenants, users, authorization (own database `identity`) |
| `engagement`    | 4002               | rules, wheel, store (own database `engagement`)         |
| `payments`      | 4003               | the only place coins change (own database `payments`)   |
| `casino-sim`    | 4004               | two fake partner casinos with fault injection           |
| `postgres`      | 54329              | one database and one non-superuser role per service     |
| `rabbitmq`      | 55672, UI on 15672 | event bus (user `mio`)                                  |
| `redis`         | 56379              | cache, append-only persistence                          |
| `firebase-auth` | 9099               | Firebase Auth Emulator, project `demo-ex-mio`           |

The infrastructure ports are deliberately not the defaults, so a database already running on your machine
does not collide. Override any port with the variable shown in `docker-compose.yml`
(`POSTGRES_PORT`, `RABBITMQ_PORT`, `REDIS_PORT`, `WEB_PORT`, ...). All credentials are local-development
values.

Each service starts only after what it needs reports healthy (`depends_on: service_healthy`), applies its own
migrations (`node dist/migrate.js`), then serves. Probes: `GET /healthz/live` (process is up) and
`GET /healthz/ready` (dependencies answer; 503 otherwise).

## Try it

```sh
# sign up an operator (creates the tenant and its first admin)
curl -s -X POST localhost:4001/v1/operators/signup \
  -H 'content-type: application/json' \
  -d '{"tenant_name":"Acme Casino","slug":"acme","email":"boss@acme.test","password":"correct horse battery"}'

# sign in: the tenant comes from the Host (<slug>.mio.localhost), never from the body
curl -s -X POST localhost:4001/v1/auth/login \
  -H 'content-type: application/json' -H 'host: acme.mio.localhost' \
  -d '{"email":"boss@acme.test","password":"correct horse battery","audience":"engagement"}'

# engagement received the event over RabbitMQ and built its own copy
curl -s localhost:4002/v1/tenant-projection -H 'authorization: Bearer <access_token>'
```

Every service trusts only tokens identity signed (RS256, keys at `/.well-known/jwks.json`); the tenant comes
from the verified `tid` claim. There is no header that names a tenant.

## Develop

```sh
pnpm nx run-many -t lint         # eslint, including layering and package boundaries
pnpm nx run-many -t typecheck
pnpm nx run-many -t test         # unit tests
pnpm storybook                   # the design system, on :6006
```

Layout and patterns: [`memory/systemPatterns.md`](memory/systemPatterns.md). Contracts between components:
[`docs/CONTRACTS.md`](docs/CONTRACTS.md).

## Production notes

- Postgres TLS is explicit: set `DATABASE_SSL` to `disable`, `require` or `verify-full`. It is off by default
  locally; in production the service refuses to start unless it is stated. A self-hosted Postgres without
  TLS sets `disable` on purpose.
- Migrations are a separate step: `node dist/migrate.js` in each service image (exit 0 applied, 1 failed).
  The images contain no pnpm. `scripts/migrate-all.sh` runs the three; the deploy manifest
  (`.deckhand/deploy.yml`) points at it.
- Identity refuses to start in production with a development `CREDENTIALS_KEK` or `PLATFORM_ADMIN_PASSWORD`
  (values containing `dev-`) or with the `fake` identity provider.

## Next

- Refresh tokens and family revocation (backlog MIO-042 tail). For now an access token lives 15 minutes
  and there is no refresh: a player or operator signs in again when it expires. Deferred on purpose for the
  first submission.
- Sign-in rate limit and lockout (MIO-043).

## License

MIT, see [`LICENSE`](LICENSE).
