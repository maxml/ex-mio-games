# 0011. One container per service, deployment through Deckhand

- Status: accepted
- Deciders: product owner (maxml), architecture session
- Date: 2026-11-21
- Confidence: medium-high for the local setup, low for production claims

## Context and problem statement

Services must start separately in Docker, so that one can be rebuilt, restarted or failed without touching the others. Deployment to a server needs a repeatable blue-green flow. Deckhand is the owner's deployment tool for docker-compose projects.

## Decision drivers

- Each service builds and runs as its own container with its own database.
- A clean clone starts the whole stack with one command and no accounts.
- Deployment is delegated to Deckhand; the product does not invent its own.

## Considered options

1. One image with several entry points.
2. One image and one compose service per deployable (including workers), plus infrastructure containers.
3. Kubernetes manifests.

## Decision outcome

Option 2.

- Compose services: `identity`, `engagement`, `payments`, `web`, `casino-sim`, a worker per service where needed, RabbitMQ, Redis (append-only persistence), one Postgres instance with a database per service, and the identity emulator.
- Each service has health and readiness endpoints, and fails fast on invalid configuration.
- Deployment goes through Deckhand's blue-green flow for docker-compose projects. Observability goes to Varta.
- Production claims are limited. Isolation of services at deployment level, in particular per-service secret delivery, is **not claimed** by this submission: it is designed only and depends on deployment tooling work that has not been done. Database-level isolation (roles, RLS) is built and tested regardless.

### Consequences

Good: independent restart and failure testing; the local stack mirrors the deployed one.

Bad: a larger stack to start; one Postgres instance for several databases is a local convenience and a shared failure domain; the deployment-level secret model is a known limit.

## Built vs designed

- Built: container per service, compose stack, health checks, a Deckhand manifest.
- Designed only: per-service deploy secrets, production sizing, multi-host topology.
