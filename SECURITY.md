# Security policy

## Reporting a vulnerability

Do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on this
repository (Security tab, "Report a vulnerability"). Include:

- what the issue is and what an attacker gains;
- steps to reproduce;
- the branch or commit affected.

You can expect an acknowledgement within 7 days, and we will coordinate disclosure with you.

## Supported versions

Fixes are applied on `main` only.

## What the code enforces

- **Tenant isolation:** row-level security on every tenant table, with `FORCE` so the table owner is bound
  too. Service database roles are not superusers and do not bypass RLS. A request without a tenant is
  refused (401); a query without a tenant reads nothing.
- **Input:** every controller parses body, params, query and headers with a zod schema before use.
- **Money paths:** retried writes are idempotent per key; the stored result is committed with the effect.
- **Transport:** Postgres TLS is explicit (`DATABASE_SSL`); in production it must be stated. Redis must use
  `rediss://` in production.
- **Logs:** the logger redacts `authorization`, `password`, `token` and `cookie`; product events carry no
  personal data beyond ids.
- **Config:** a development-only value (for example the platform admin token prefix `dev-`) is rejected in
  production at boot.

## Secrets

No real secret is committed. The credentials in `docker-compose.yml` and in each `.env.example` are
development values for a stack that never leaves your machine. Production secrets are supplied at deploy
time through the deploy plane, never baked into an image or the repository.

## Dependencies

Dependabot is enabled (`.github/dependabot.yml`). CI installs with a frozen lockfile.
