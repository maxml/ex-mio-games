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
# create a tenant (platform endpoint, guarded by a token)
curl -s -X POST localhost:4001/v1/tenants \
  -H 'content-type: application/json' -H 'x-platform-admin-token: dev-platform-token-0000' \
  -d '{"name":"Acme Casino","slug":"acme"}'

# engagement received the event over RabbitMQ and built its own copy (use the id from above)
curl -s localhost:4002/v1/tenant-projection -H 'x-tenant-id: <tenant id>'

# credit coins, safely retried with the same key
curl -s -X POST localhost:4003/v1/credits \
  -H 'content-type: application/json' -H 'x-tenant-id: <tenant id>' -H 'x-principal-id: operator-1' \
  -H 'idempotency-key: first-credit-0001' \
  -d '{"player_id":"<a uuid>","amount":10}'
```

The `x-tenant-id` header is a placeholder: the identity service will issue tokens, and the tenant will then
come from a verified claim.

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
- `PLATFORM_ADMIN_TOKEN` must not start with `dev-` in production.

## License

MIT, see [`LICENSE`](LICENSE).
