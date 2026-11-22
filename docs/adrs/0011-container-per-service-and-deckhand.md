# 0011. One container per service, deployment through Deckhand

Diagram: section [1](../../docs/architecture/README.md#1-context-and-containers) of the diagram hub (why each diagram exists: [table](../../docs/architecture/README.md#why-each-diagram-exists)).

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

- Compose services: `identity`, `engagement`, `payments`, `web`, `casino-sim`, RabbitMQ, Redis (append-only persistence), one Postgres instance with a database per service, and the identity emulator (nine containers). Workers run inside the service process; there is no separate worker container.
- Each service has health and readiness endpoints, and fails fast on invalid configuration.
- Deployment goes through Deckhand's blue-green flow for docker-compose projects. Observability goes to Varta.
- Production claims are limited. Isolation of services at deployment level, in particular per-service secret delivery, is **not claimed** by this submission: it is designed only and depends on deployment tooling work that has not been done. Database-level isolation (roles, RLS) is built and tested regardless.

### Consequences

Good: independent restart and failure testing; the local stack runs the same images; the deployment drops Redis and exposes only `web`. (Corrected 2026-11-23: the first text said the local stack mirrors the deployed one.)

Bad: a larger stack to start; one Postgres instance for several databases is a local convenience and a shared failure domain; the deployment-level secret model is a known limit.

## Built vs designed

- Built: container per service, compose stack, health checks, a Deckhand manifest (`.deckhand/deploy.yml`) and a migration script.
- Built on pre-prod: a blue-green deploy through Deckhand and Varta ingestion (demo 40 steps, 194 checks passed there; Varta received 57 events of 10 kinds); not production, there is no production deployment.
- Next: per-service deploy secrets, production sizing, multi-host topology.
