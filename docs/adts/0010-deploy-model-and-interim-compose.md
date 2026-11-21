# Deploy model: manifest is the contract; Deckhand owns the prod compose

> Status: accepted.
> Date: 2026-09-05.
> Deciders: starter maintainers / AI.
> Confidence: HIGH (matches the Deckhand deploy-manifest + shared-edge contracts).

## Context

The starter ships `.deckhand/deploy.yml` — a thin, stack-agnostic manifest that
declares how the app builds and rolls out (images, services + strategy + health,
public routing, env inventory, migration step). Deckhand is the external delivery
system: images build in CI and push to a registry, and Deckhand rolls them out
blue-green behind one shared, multi-tenant edge (a Caddy proxy on `:80/:443` that
fronts every project on the host via a per-project site file). Public containers
join the shared external Docker network `edge`; stateful services are singletons
with named volumes and no host ports.

A downstream project deployed to a single VPS before Deckhand's engine automated
host rollout, so it hand-wrote a `deploy/compose.prod.yml` that built images **on
the VPS** and joined web to the shared `edge` network. That worked, but it was
explicitly a stopgap — its own README said "in prod Deckhand generates its own
compose," and Deckhand's roadmap has the engine materializing the prod compose +
Caddy site from the manifest.

## Decision

**The manifest is the durable contract; the prod compose is Deckhand's to
generate.** The starter does **not** generate a per-project `deploy/compose.prod.yml`.

Rationale:

- It would be a durable artifact for a temporary need — once Deckhand generates
  the compose from `.deckhand/deploy.yml`, a committed compose is a second,
  drifting source of truth.
- The generic, durable lessons from that stopgap are already captured elsewhere:
  the manifest encodes services/strategy/health/public-routing/migrations, the
  app images carry their own HEALTHCHECKs and bind `0.0.0.0`, migrations run as a
  deploy step (ADR-0009), and the edge/volume conventions are recorded below.
- Porting the downstream file verbatim risked leaking its project name, domain,
  self-signed certs, and app-specific mounts into a product-independent starter.

## Interim build-on-VPS recipe (until Deckhand automates the host)

To deploy today, an operator can build on the VPS with a compose that follows
these conventions (product-neutral skeleton — adapt names/services to the stack;
secrets come from a gitignored env file, never the repo):

```yaml
name: <project-slug>
services:
  db: # singleton, named volume, no host port; healthcheck (pg_isready / mongosh ping)
    image: postgres:16
    volumes: ['<slug>_db_data:/var/lib/postgresql/data']
    networks: [internal]
  # redis: same shape when the redis dimension is on
  migrate: # one-shot: reuse the api image, run the migration, then exit
    image: <slug>-api:prod
    build: { context: .., dockerfile: apps/api/Dockerfile }
    restart: 'no'
    env_file: [./prod.env]
    depends_on: { db: { condition: service_healthy } }
    command: ['pnpm', '--filter', 'api', 'exec', 'prisma', 'migrate', 'deploy']
    networks: [internal]
  api: # public → joins the shared edge; HEALTHCHECK ships in the image
    image: <slug>-api:prod
    build: { context: .., dockerfile: apps/api/Dockerfile }
    env_file: [./prod.env]
    depends_on:
      db: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    networks: [internal, edge]
  web: # public → joins the shared edge (domain-agnostic image — no build args)
    image: <slug>-web:prod
    build:
      context: ..
      dockerfile: apps/web/Dockerfile
    env_file: [./prod.env] # SSR reads API_URL=http://api:4000; the browser is same-origin
    depends_on: [api]
    networks: [internal, edge]
  # worker: internal singleton when the queue dimension is on
networks:
  internal: {}
  edge: { external: true, name: edge } # the shared Deckhand edge (created by `edge up`)
volumes:
  <slug>_db_data: {}
```

Key points that are easy to get wrong: public services must join the **external**
`edge` network (Deckhand's Caddy resolves them there); the migrate step is a
**one-shot** service (`restart: 'no'`, `service_completed_successfully`) reusing
the api image so it never builds twice; volumes are compose-managed for a fresh
VPS (mark them `external` only when adopting volumes from a previous bring-up);
and the app images already declare HEALTHCHECKs, so compose only adds them for
`db`/`redis`.

**TLS to the datastores is required** — the API/worker reject a non-TLS
`DATABASE_URL`/`REDIS_URL` in production. Prefer a managed TLS datastore. When
self-hosting the internal `db`/`redis`: Postgres accepts a **self-signed** cert
with `sslmode=require` (it encrypts without verifying), but Redis (ioredis)
**verifies** the `rediss://` cert, so Redis needs a trusted (not self-signed)
cert. Durable local file storage is out (S3 for a public/blue-green API, per the
manifest warning), so the only durable volume here is the singleton `db`.

## Consequences

- **Good:** one source of truth (`.deckhand/deploy.yml`); no drift against
  Deckhand's generated compose; the starter stays product-independent.
- **Bad:** projects that must deploy before Deckhand's host rollout ships have to
  hand-write the interim compose from the recipe above (or wait for Deckhand).
- **Follow-up:** revisit if Deckhand's engine timeline slips — a documented
  `deploy/compose.prod.example.yml` (an example, not a per-project generated file)
  could be added without becoming a second source of truth.

## Options considered

### Document the model + interim recipe; don't generate (chosen)

- Good, because it avoids a temporary, Deckhand-owned artifact drifting in every
  repo, and keeps the starter product-independent.
- Bad, because there is no turn-key `up -d` file in the VPS today.

### Generate a per-project `deploy/compose.prod.yml` from the manifest

- Good, because turn-key deploy today.
- Bad, because it duplicates what Deckhand will generate (drift), and rendering a
  correct compose across every stack (db provider, redis, worker, auth env) is
  significant surface for an interim artifact. Rejected for now; revisit per the
  follow-up.
