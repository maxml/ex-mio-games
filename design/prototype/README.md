# MIO Games design prototype v2

Clickable prototype of the three surfaces: player widget, operator console, platform admin. Vite, React, TypeScript, Tailwind v4, CSS-variable tokens. Everything is mock data; there is no backend. It is the owner's pre-code design gate (MIO-121).

Since v2 the prototype is restructured by role, the same way as the web app (IA spec, T2 and T3), and every UI element comes from `@ex-mio/ui` (`packages/ui`).

## Run

```sh
cd design/prototype
pnpm install --ignore-workspace   # the prototype is outside the pnpm workspace and has its own lockfile
pnpm dev        # http://localhost:5173
pnpm test       # vitest: store/reducer (money rules)
pnpm build      # contrast gate, raw-colour gate, typecheck, tests, production build into dist/
```

The root `pnpm install --frozen-lockfile` must have run too: the prototype reads the sources and the dependencies of `packages/ui` through the alias below.

## Roles and pages

The header has a role switcher (`session/role` in the app store, not localStorage, so a test can set it). Each role sees only its own pages and nav, and no page mixes roles. Pages are hash routes; `#/operator` redirects to the role's landing, and a page the role may not open redirects to the landing with `?denied=<page>` and an access notice.

| Role                     | Pages (nav)                                              | Landing                                                                |
| ------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| Admin (`operator_admin`) | Setup, Rules, Wheel, Store, Redemptions, Insights, Team  | `#/operator/setup`, then `#/operator/operations/redemptions` once live |
| Staff (`operator_staff`) | Store, Redemptions, Insights, Team (all read-only)       | `#/operator/operations/redemptions`                                    |
| Support (acting session) | Insights, Team (read-only), under a reason banner        | `#/operator/insights`                                                  |
| Platform admin           | `#/admin` only: tenants, MRR, funnel, act-as with reason | `#/admin`                                                              |
| Player                   | `#/player` only: the widget and the demo casino controls | `#/player`                                                             |

Routes: `#/operator/setup[/step]` (steps: signup, plan, keys, reward-api, sandbox, golive), `#/operator/engagement/{rules,wheel,store}`, `#/operator/operations/redemptions`, `#/operator/insights`, `#/operator/team`, `#/admin`, `#/player`.

- Read roles get the template with `readOnly`: the write controls (Add item, price, visibility, Resolve, Pay, invite) are not rendered at all.
- Support is a platform admin with an acting session. Start one from `#/admin` (Act as an operator, reason of 3 to 500 characters); the Support role then shows the reason in a banner. Support cannot read redemptions or the store (engagement refuses `platform_admin`), so it sees Insights and Team only.
- Elements with no service behind them yet (key list, reward API, sandbox, go live, resolve, player funnel, team and audit) carry the `PreviewNotice` text, as in the web app.
- Setup counts only the six steps the store (or the reward-API draft) says are done. Rules, wheel, store, redemptions and billing are pages of their own.
- **Shared state**: one in-memory store (`src/state/`) backs all surfaces. Saved rules, published weights and catalog edits made by an admin are what the player widget uses on its next deposit, spin or store view. It is lost on reload.

## Structure

- `src/config/operator-pages.ts`: the page registry (ids, groups, hrefs, role access) and `landing`. It is a copy, as data, of `apps/web/src/layers/shared/config/operator-pages.ts`; the two must stay equal (IA spec A-PROTO-3).
- `src/router.ts`: hash parsing and the pure `resolveRoute` guard.
- `src/screens/operator/*Screen.tsx`: one thin screen per page. Each reads the store and renders one `@ex-mio/ui` template. `src/screens/PlayerWidget.tsx` and `AdminConsole.tsx` do the same for the other two surfaces.
- `src/App.tsx`: skip link, site header with the theme and role switchers, and `<main>`.

## Design system

The old `src/components/*`, `src/theme/*`, `screens/operator/Checkout.tsx` and `StepNav.tsx` are gone; they duplicated `packages/ui`.

- `vite.config.ts` and `tsconfig.json` alias `@ex-mio/ui` to `../../packages/ui/src/index.ts`, and pin one copy of React.
- `src/index.css` imports `@ex-mio/ui/tokens.css` and `base.css`.
- **Tailwind: stayed on v4.** The ui package's v3 preset (`tailwind-preset.cjs`) loads in Tailwind v4 through `@config '../../../packages/ui/tailwind-preset.cjs'`, and `@source '../../../packages/ui/src'` makes v4 scan the ui sources. No move to Tailwind 3 was needed.
- The contrast gate in `pnpm build` is the ui package's `scripts/check-contrast.mjs` (tokens and tenant themes live in `packages/ui`).
- Tokens and tenant theming: see `TOKENS.md` (the source is `packages/ui/src/tokens.css` and `packages/ui/src/theme/`).

## Accessibility basics

Skip link (focuses the main), visible focus ring, labelled form fields with 3:1 borders, a busy Spin button that keeps keyboard focus, an always-mounted `aria-live` result region, status never by colour alone, `prefers-reduced-motion` respected, AA contrast enforced per theme in the build. These come from the ui components.

## What is mocked

All data (`src/mock/data.ts`), signup, plans and payment (fake provider), keys (fake strings), the sandbox test (timed list), go live, the acting session, spin outcomes (client-side weighted random standing in for the server: a result has an id and is credited once in the store; the wheel only animates it), redemption lifecycle (timers in the store), versioned wheel publishing, invoices and the funnels. Unit tests cover the store; the UI flows were checked with a headless browser script outside the repo.
