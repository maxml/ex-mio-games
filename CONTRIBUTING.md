# Contributing

Thanks for considering a contribution.

## Development setup

```bash
nvm use
pnpm install
docker compose up -d
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local   # NEXT_PUBLIC_API_URL for the web app
pnpm --filter api migration:run
pnpm dev
```

## Workflow

1. Fork the repo and create a feature branch from `main`.
2. Make your changes. Keep commits focused; rebase before opening a PR.
3. Run `pnpm lint`, `pnpm test`, and `pnpm build` locally — CI runs the same.
4. Open a pull request. The PR template will guide you through what to include.

## Code style

- ESLint + Prettier are wired up. `pnpm format` rewrites; `pnpm format:check` only verifies.
- Husky runs `lint-staged` on `pre-commit`; bypassing hooks is discouraged.
- Add or update tests for behavior changes. We use Jest.

## Reporting bugs

Open an issue using the bug report template. Include reproduction steps, the
expected behavior, and the actual behavior. Attach logs where relevant.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Do not open a public issue for vulnerabilities.
