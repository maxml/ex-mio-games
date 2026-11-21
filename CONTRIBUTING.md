# Contributing

Thanks for considering a contribution.

## Development setup

```bash
nvm use                       # Node 24, see .nvmrc
pnpm install --frozen-lockfile
docker compose up -d --wait   # postgres, rabbitmq, redis, firebase auth emulator, every app
pnpm test:compose             # tests against the running stack
docker compose down -v
```

To work on one service with hot reload, start the infrastructure only
(`docker compose up -d --wait postgres rabbitmq redis`), copy that service's `.env.example` to `.env`, run
`pnpm --filter @ex-mio/<service> migrate` once, then `pnpm --filter @ex-mio/<service> dev`.

## Workflow

1. Fork the repo and create a feature branch from `main`.
2. Make your changes. Keep commits focused; rebase before opening a PR.
3. Run `pnpm lint`, `pnpm typecheck` and `pnpm test` locally; CI runs the same, plus the compose job.
4. Open a pull request. The PR template will guide you through what to include.

## Code style

Prettier and ESLint run on commit (Husky + lint-staged). Layering inside a service
(`controllers` -> `services` -> `model`) and package boundaries are enforced by lint; see
`memory/systemPatterns.md`.

## Reporting bugs and security issues

Open an issue using the bug report template. For a security problem use private vulnerability reporting
instead, see `SECURITY.md`.
