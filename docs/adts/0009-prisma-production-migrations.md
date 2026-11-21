# Prisma production migrations (deploy-step, not `db push`)

> Status: accepted.
> Date: 2026-09-05.
> Deciders: starter maintainers / AI.
> Confidence: HIGH (explicit in code + validated against the Deckhand engine validator).

## Context

The starter's baseline is Prisma + PostgreSQL. Until now the only schema tool it
shipped was `prisma db push` (`prisma:push`). `db push` diffs the schema straight
onto the database with no migration history — fine for local prototyping, unsafe
for production (it can drop columns to reconcile drift, and leaves no auditable,
repeatable record of what changed).

Two concrete gaps made this urgent:

1. The generated **Deckhand deploy manifest** already declared a migration step,
   `migrations.run: 'pnpm --filter api prisma migrate deploy'`. But there was no
   such package script, and `pnpm --filter api prisma …` is **not** how pnpm runs
   a binary: it treats `prisma` as a script name, prints _"None of the selected
   packages has a 'prisma' script"_ and **exits 0**. Deckhand would record the
   no-op as a successful migration and cut blue-green traffic over to an **empty
   schema**. Silent, and worst at the worst time (first deploy of a fresh
   database).
2. The TypeORM path already had a real production migration story (a tracked
   initial migration + `migrationsRun` on boot). Prisma-Postgres — the baseline —
   did not, so every downstream Prisma project inherited the `db push` anti-pattern.

## Decision

Ship a real Prisma migration baseline and make the deploy command honest:

- Commit an initial migration at `apps/api/prisma/migrations/20260101000000_init/`
  plus `migration_lock.toml`. It is **auth-aware**, exactly like the schema:
  Firebase omits `passwordHash` and the `AuthSession`/`AuthAccount` tables, so
  `migrate dev` never scaffolds a DROP of unused tables on first run (the
  scaffolder re-emits the matching variant, see `dimensions/database`).
- Add package scripts: `prisma:migrate` (`prisma migrate dev`, development) and
  `prisma:migrate:deploy` (`prisma migrate deploy`, production/human use).
- Point the Deckhand manifest at `pnpm --filter api exec prisma migrate deploy`
  (note the `exec`). The old `pnpm --filter api prisma migrate deploy` treated
  `prisma` as a script name → pnpm warned and exited 0 → Deckhand recorded a no-op
  as success and cut over to an empty schema. Under `--filter`, a missing _script_
  also exits 0, so pointing at `prisma:migrate:deploy` would not be self-guarding
  either; `exec` runs the binary and fails loudly if prisma is absent.
- Keep `prisma:push` for quick local prototyping only.

The migration is applied as a **deploy step** (expand-before-cutover), never on
app boot — blue and green both run against the expanded, backward-compatible
schema, matching the manifest's `migrations.when`/`backward_compatible` contract.

## Consequences

- **Good:** a fresh production database gets the correct schema; the deploy
  command can no longer succeed while doing nothing; Prisma projects get the same
  auditable migration history TypeORM already had.
- **Bad:** contributors editing the Prisma schema must now create a migration
  (`prisma:migrate`) rather than only `prisma:push`; the baseline carries a
  migrations directory.
- **Per-ORM behaviour** (applied at setup): TypeORM removes the whole
  `apps/api/prisma/` dir (it owns `src/migrations` + `migrationsRun`); MongoDB
  keeps `schema.prisma` but drops `prisma/migrations` and the migrate scripts
  (Prisma Migrate has no MongoDB support — it stays on `prisma:push`).
- **Follow-ups:** an optional boot-time schema-drift guard (refuse to serve when a
  required migration is unapplied, naming the gap) is a possible future hardening,
  not shipped here.

## Options considered

### Ship real migrations + fix the deploy command (chosen)

- Good, because the deploy contract becomes true, and the baseline stops teaching
  `db push` as the production path.
- Bad, because it adds a migration-authoring step to the Prisma dev loop.

### Keep `db push` and point the manifest at `prisma:push`

- Good, because zero new files.
- Bad, because `db push` in production risks data loss on drift and keeps no
  history — the exact anti-pattern this ADR removes.

### Leave the manifest command as-is

- Rejected: it silently exits 0 and deploys an empty schema.
