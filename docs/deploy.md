# Deploying MIO with Deckhand

The manifest is `.deckhand/deploy.yml`; the contract is in the Deckhand repo (`docs/contracts/deploy-manifest.md`).
Validate it with the Deckhand engine: `validate --manifest .deckhand/deploy.yml` and `schema-check --manifest .deckhand/deploy.yml`.
The `services.*.env` secret warnings it prints are the per-service mappings and the `db` role passwords described below and are accepted.

## Shape

| Service         | Kind / strategy      | Public | Notes                                                                     |
| --------------- | -------------------- | ------ | ------------------------------------------------------------------------- |
| `web`           | app, blue-green      | yes    | the only public service, path `/*`; proxies `/socket.io` to engagement    |
| `identity`      | app, blue-green      | no     | reached as `http://identity:4001`                                         |
| `engagement`    | app, blue-green      | no     | `http://engagement:4002`                                                  |
| `payments`      | app, blue-green      | no     | `http://payments:4003`                                                    |
| `casino-sim`    | app, singleton       | no     | test double of a casino for the demo; fault injection is on, never public |
| `firebase-auth` | app, singleton       | no     | identity provider emulator (`fake` is refused in production); in memory   |
| `db`            | datastore, singleton | no     | project-built `docker/postgres/Dockerfile`: 3 databases, 6 roles          |
| `rabbitmq`      | datastore, singleton | no     | credentials from `RABBITMQ_DEFAULT_USER` / `RABBITMQ_DEFAULT_PASS`        |

Redis is not deployed (production requires `rediss://`, and engagement only reports it in its health output).
Local compose still runs it.

Images are `<registry>/ex-mio/<image>:<sha>` with the server-local registry (`127.0.0.1:5000`) as `build.registry`;
`version.source` is `auto`. The `db` and `firebase-auth` images are built from the repo root.

## Secrets

Deckhand delivers one secrets file to every service (`env.required`; values live on the server, never in the repo).
Names shared by several services are mapped per service, inline, from distinct names:

- `DATABASE_URL` of each service from `IDENTITY_DATABASE_URL`, `ENGAGEMENT_DATABASE_URL`, `PAYMENTS_DATABASE_URL`
  (app roles `<svc>_app`); the migration step uses `<SVC>_MIGRATION_DATABASE_URL` (owner roles `<svc>_owner`);
- `SERVICE_CLIENT_SECRET` of engagement and payments from `ENGAGEMENT_SERVICE_CLIENT_SECRET` and
  `PAYMENTS_SERVICE_CLIENT_SECRET`; identity reads the registry `SERVICE_CLIENT_SECRETS` (JSON) and its two entries must
  equal those values.

Other required names: `POSTGRES_USER`, `POSTGRES_PASSWORD`, the six `<SVC>_OWNER_DB_PASSWORD` / `<SVC>_APP_DB_PASSWORD`,
`DATABASE_SSL` (`disable` for the self-hosted Postgres), `RABBITMQ_DEFAULT_USER`, `RABBITMQ_DEFAULT_PASS`, `AMQP_URL`,
`BASE_DOMAIN` (identity and web, same value), `CREDENTIALS_KEK`, `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`,
`WHEEL_SEEDS` (JSON), `USAGE_KEY_SALT`, `FAKE_PROVIDER_WEBHOOK_SECRET` (32+ characters), `PAYMENTS_URL`.
Generate every secret fresh (hex, no `$`, no quotes, no spaces); never reuse the development values. The file is
`root:root`, mode `0640`. Values are read by `--env-file` in the migration step, so they must be unquoted there.

## Database bootstrap

`docker/postgres/init.sh` creates the three databases and six roles on the first start of an empty data directory.
It has no password defaults: a missing `<SVC>_OWNER_DB_PASSWORD` / `<SVC>_APP_DB_PASSWORD` aborts the init. Each value
is taken from the environment, else (fallback only, when readable) from the mounted secrets file
(`/run/secrets/deckhand_secrets.env`). The postgres entrypoint runs the script as uid `postgres` and drops supplementary
groups, so it cannot read the `root:root` `0640` secrets file: the manifest therefore passes the six role passwords to
the `db` service as inline `env:` entries (like `POSTGRES_PASSWORD`; accepted validator warnings, visible to
`docker inspect`). Local compose keeps the stock `postgres` image, mounts the script and passes its development values explicitly.

The `db` service has a healthcheck that passes only after `init.sh` has finished: the postgres entrypoint runs the
init scripts on a temporary server that listens on the unix socket only, so the probe connects over TCP
(`-h 127.0.0.1`) and queries the `payments` database, the last one the script creates. Deckhand's `up --wait` (and so the
pre-migration backup) therefore cannot run while the databases and roles are still being created.
`docker-compose.yml` uses the same probe.

## First deploy: edge site

This is a multi-service, single-host project (`domains.single_host: true`, only `web` public, path `/*`), so the
first deploy on a server needs the engine-rendered edge route installed once:
`deckhand edge site --from-manifest .deckhand/deploy.yml` (see Deckhand `docs/operations/onboarding.md`, "Edge").
Without it the shared edge has no route to the project.

## Migrations and backup

`migrations.run` starts one container per service from `DECKHAND_IMAGE_<NAME>` on the network `ex-mio_backend`, with the
rendered `.env` as `--env-file`, and runs `node dist/migrate.js` with the service's owner-role URL. The first failure
stops the deploy.

`deploy/backup.sh` replaces the single-database Deckhand template: one `pg_dump` per database into
`<data-dir>/ex-mio/backups/<snapshot>-<database>.sql`, failing on an error or an empty dump. Install it as
`<data-dir>/ex-mio/backup.sh` and pass `--backup-cmd "sh <data-dir>/ex-mio/backup.sh"` to the deploy.

A change to a datastore definition (for example the db healthcheck) makes Deckhand run the deploy in a
maintenance window. That requires a `--pause-writers-cmd` hook that stops the project's writer services
(identity, engagement, payments) before the db is recreated.

## Demo against a deployment

`scripts/demo.sh` takes `IDENTITY_URL`, `ENGAGEMENT_URL`, `PAYMENTS_URL`, `CASINO_SIM_URL`, `WEB_URL` and
`DEMO_BASE_DOMAIN` (the identity `BASE_DOMAIN`) from the environment, and needs the deployment's
`FAKE_PROVIDER_WEBHOOK_SECRET`. Only `web` is public, so run it from a container on the project network
(`ex-mio_backend`) that has bash, curl, jq and openssl. Without the variables it behaves as before, against localhost.

## Pre-prod values

The host name, base domain and server address are not stored in this repository. They are passed to Deckhand at deploy time
(`--base-domain <base-domain>`), and the public host is `ex-mio.<base-domain>`.
