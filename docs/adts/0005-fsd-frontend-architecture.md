# Frontend architecture — Feature-Sliced Design on the Next App Router

> Status: accepted — the FSD skeleton, module boundaries, state stack, and the
> reference slices are in the baseline `apps/web` with passing tests.
> Date: 2026-06-30.
> Deciders: template maintainers + Claude (Opus 4.8).
> Confidence: HIGH — the structure below is what `apps/web` actually ships
> (`src/layers/{app,views,widgets,features,entities,shared}`, ESLint
> `import/no-restricted-paths` + Steiger boundaries, TanStack Query + Zustand +
> react-hook-form/Zod, a typed HTTP client + error envelope, next-intl, and a
> singleton realtime client). Domain features are layered on top of this seed.

## 1. Context

`apps/web` is a Next.js App Router app that must stay disciplined as it grows into
a real product: many features, shared server-state, forms, i18n, real-time, and a
design system. A blank `app/` tree with ad-hoc folders drifts into a
client-heavy, tangled import graph within a few features. This ADR fixes the
organizing architecture, the render/state rules, the folder skeleton, and the
scaffold Definition of Done so every feature is added the same way.

Version constraints (Next 14 / React 18 / Tailwind 3.4) are inherited from the
monorepo baseline; this ADR is about _architecture_, not version policy.

## 2. Decision (TL;DR)

| Aspect                       | Decision                                                                        | Section |
| ---------------------------- | ------------------------------------------------------------------------------- | ------- |
| Organizing architecture      | **Feature-Sliced Design (FSD)**, pragmatic                                      | §3      |
| FSD ↔ Next `app/` collision | **Variant A**: `app/**` = Next routes only; FSD lives under `src/layers`        | §3.1    |
| Render strategy              | **Server Components by default**; `"use client"` islands only where interactive | §4.1    |
| Server-state                 | **TanStack Query** (interactive/authed/WS-synced data)                          | §4.2    |
| Client/UI-state              | **Zustand** (modals, filters, presence, connection status)                      | §4.2    |
| Forms / validation           | **react-hook-form + Zod** (schemas from the shared-types package)               | §4.2    |
| Real-time                    | WebSocket-first; see the realtime ADR/dimension                                 | §5      |
| Layer boundaries             | Enforced: ESLint `import/no-restricted-paths` + Steiger                         | §3, §7  |

## 3. Organizing architecture — Feature-Sliced Design

Adopt **Feature-Sliced Design (FSD), pragmatic**. It maps cleanly to
`ui / features / entities / shared`, disciplines dependencies at scale, and is the
dominant convention in the React ecosystem.

- Layers: `app → views → widgets → features → entities → shared`. Imports flow
  **downward only**; slices in the same layer do not import each other; every
  slice is reached through its Public API (`index.ts`).
- **Hooks are the de-facto ViewModel** — no separate MVVM layer.
- From Clean Architecture take **only** the _dependency rule_ plus a thin
  `model`/domain segment; a "heavy" domain is reserved for genuinely complex
  features, not introduced up front.
- **Boundaries are enforced from day one** (otherwise FSD decays): ESLint
  `import/no-restricted-paths` for import direction + the Steiger FSD linter.

### 3.1 FSD ↔ Next App Router — Variant A (the `app/` collision)

The Next special directory `app/` and the FSD `app` layer share a name. To avoid
confusion, **Variant A** is chosen:

- **`apps/web/app/**`** holds **Next routes only** (route segments, `layout`/`loading`/`error`) and stays **thin** — each route file imports a ready-made
  view.
- The **entire FSD hierarchy** lives under
  **`apps/web/src/layers/{app,views,widgets,features,entities,shared}`**.
- The FSD **`pages`** layer is renamed **`views`** to avoid clashing with Next
  routing.
- The FSD **`app`** layer (`src/layers/app`) holds providers / store
  initialization / config — **not** a Next route.
- Path alias: `@/*` → `apps/web/src/*` (imports like `@/layers/views/home`).

Next features stay available: private folders (`_folder`), route groups
`(group)`, and safe colocation (nothing is public until `page.tsx`).

## 4. Render strategy and state management

### 4.1 Server Components vs client islands

- **Server Components / server-fetch are the default** for SEO pages, public
  landings, detail pages, and any read-mostly content — fetch on the server,
  ship HTML.
- **`"use client"` + TanStack Query only for** interactive/authed flows,
  dashboards, forms, optimistic updates, and WS-sync — i.e. _client-side
  server-state_, not the primary render of content.
- Allowed pattern: an RSC paints first, with client islands (Query/WS) inside a
  hydration boundary. Avoid collapsing a page into one large client component.

### 4.2 State libraries

- **Server-state → TanStack Query** — caching/invalidation/refetch; maps natively
  onto REST + WS updates. It does not replace client state; it coexists with
  Zustand.
- **Client/UI-state → Zustand** — global/ephemeral UI (modals, filters, presence,
  connection status).
- **Redux Toolkit is not the default** — consider it only if a feature needs
  replay/undo/action-log.
- **Forms → react-hook-form + Zod**, with schemas shared from the
  `packages/shared-types` package so web and api validate the same shapes.

## 5. Real-time

WebSocket-first, with a singleton multiplexed client mounted in the app-layer
provider. The transport choice, gateway placement, handshake auth, and
client→state mapping are their own decision — see the realtime architecture ADR
and the optional `realtime` setup dimension. In FSD terms the client is a
`shared/api/ws` singleton and connection status is ephemeral Zustand state
(§4.2), never the query cache.

## 6. Other integrations

- **i18n** — next-intl on the App Router; the locale set + routing strategy live
  in the `shared/config` segment, and the message source is app-specific (wire
  your translation export into the config).
- **Maps** — a maps library belongs in `features/map` or `shared/ui/map`;
  app-specific, not part of the baseline.
- **Design system** — Tailwind + an atomic-ish component library in `shared/ui`,
  token-driven via `tailwind.config.ts` + `app/globals.css`. The shipped token
  values are a **seed**; a project replaces them with its own design tokens.

## 7. Folder skeleton (`apps/web`)

```
apps/web/
  app/                       # Next App Router — ROUTES ONLY (thin layer)
    [locale]/                #   locale-routed segments
      layout.tsx             #   wires providers from src/layers/app
      page.tsx               #   import { HomePage } from '@/layers/views/home'
    globals.css
  src/
    layers/                  # ← the whole FSD hierarchy (no second "app")
      app/                   #   FSD app: providers (QueryClient, WS, i18n, theme), config
      views/                 #   FSD "pages" → renamed views (screen composition)
      widgets/               #   self-contained UI blocks (header, list grids, panels)
      features/              #   user actions (auth-login, create-*, ...)
        <feature>/ ui/ model/ api/ lib/
      entities/              #   business entities (user, ...)
        <entity>/ ui/ model/ api/       # model/ = domain (Clean-lite) only when complex
      shared/                #   reusable, domain-agnostic
        ui/                  #     atomic-ish design system (Tailwind)
        api/ http/           #     typed fetch wrapper + error envelope
            ws/              #     singleton WS client + reconnect/backoff
        config/ lib/ types/  #     types/ ← the shared-types package (Zod)
  .eslintrc.cjs              # import/no-restricted-paths (layer boundaries)
  tsconfig.json              # paths: "@/*" → "src/*"
```

Import rule (enforced): `app(Next) → src/layers/{app → views → widgets → features
→ entities → shared}` — downward only, through each slice's Public API
(`index.ts`). Steiger config lives in `steiger.config.mjs`.

## 8. Scaffold Definition of Done

The baseline `apps/web` satisfies all of the following; new features extend it
without changing the skeleton:

- **FSD layers** — `src/layers/{app,views,widgets,features,entities,shared}` +
  the `@/*` alias.
- **Module boundaries** — `import/no-restricted-paths` zones over `src/layers`
  (downward-only) plus the Steiger FSD linter.
- **Providers** — the app-layer `Providers` + realtime `WSProvider`.
- **Query key factory** — a typed `queryKeys` in `shared/api`, consumed by a
  reference widget.
- **HTTP client** — `shared/api/http` with a unified error envelope.
- **WS client** — `shared/api/ws` singleton behind the provider.
- **Forms + Zod** — a reference `create-*` feature (react-hook-form + Zod).
- **Test minimum** — Vitest + MSW, Playwright e2e smoke, Storybook.
- **Design-system seed** — Tailwind tokens + base components in `shared/ui`
  (token values are a seed until a project supplies its own).

## Consequences

- **Good:** a scalable, disciplined structure from day one; DRY validation via
  shared Zod; a clean, opinionated starting point that resists client-heavy
  drift.
- **Cost:** FSD has the highest onboarding curve of the mainstream options —
  it needs the linters as guardrails and a short team ramp-up.

## Options considered

- **Bulletproof React** (`features/` + ESLint boundaries) — the mainstream
  feature-based baseline; FSD is its stricter, layered generalization.
- **MVP / MVVM** — rejected/not formalized: imperative presenters and two-way
  binding conflict with React's declarative, unidirectional flow (hooks already
  serve as the ViewModel).
- **Full Clean Architecture** — overkill for most features; only the dependency
  rule and a thin extracted domain are worth keeping.
- **Atomic Design** — a UI-layer taxonomy only; combined here at the `shared/ui`
  level, not used as the whole architecture.

## References

- Feature-Sliced Design — feature-sliced.design ; the Steiger FSD linter.
- Bulletproof React — github.com/alan2207/bulletproof-react.
- Next.js App Router project structure & Route Handlers — nextjs.org/docs.
- Related decisions in this starter: the real-time / WebSocket ADR (0003), the
  baseline-auth ADR (0004), and the Nx/pnpm tooling ADR (002) — some are
  starter-internal and may not ship to a generated project.
