# MIO Games design prototype v1

Clickable prototype of the three surfaces: player widget, operator console, platform admin. Vite, React, TypeScript, Tailwind v4, CSS-variable tokens. Everything is mock data; there is no backend. It is the owner's pre-code design gate (MIO-121); its components move to Storybook later (MIO-124).

## Run

```sh
cd design/prototype
pnpm install
pnpm dev        # http://localhost:5173
pnpm test       # vitest: store/reducer (money rules) and Wheel mount behaviour
pnpm build      # contrast gate, raw-colour gate, typecheck, tests, production build into dist/
```

Screens are hash routes: `#/player`, `#/operator`, `#/admin`. The header has a tenant theme switcher (MIO default, Lucky Star Casino, Northbet); the choice is kept in localStorage.

## Screens

- **Player widget** (`#/player`): casino page mock with the widget embedded; a phone-width (375 px) toggle. Wheel with spin animation, spins available, coin balance, Bonus Store grid, redemption status (pending, issuing, issued, failed then refunded), history. "Simulate a deposit" adds spins under the operator's saved rules; a store checkbox makes the casino fail the next reward to show the refund path.
- **Operator console** (`#/operator`): ten steps, each with Back and Continue, and a step bar that ticks only finished steps: signup, plan with a mock checkout (fake provider, test-mode banner, card form; test card 4242 4242 4242 4242, 4000 0000 0000 0002 is declined) that activates the plan and pays the invoice, integration keys, sandbox casino test, go live (live keys, first live deposit), spin rules (Save persists), wheel reward table (draft versus published weights, publish a new version), store catalog, redemptions, usage and invoice (an open invoice has a Pay action and moves to Paid).
- **Shared state**: one in-memory store (`src/state/`) backs all three screens. Saved rules, published weights and catalog edits made in the operator console are what the player widget uses on its next deposit, spin or store view. It is lost on reload.
- **Platform admin** (`#/admin`): tenants, MRR, usage per operator, operator funnel.

## Components (`src/components/`)

Button, Card, StatusPill (and Badge), Table, StatTile, Wheel, CoinBalance, StoreItemCard, Stepper, Input / Select / Field, Tabs / TabPanel, Alert / Toast. The player widget root applies the tenant theme with `themeStyle()`. Tokens and tenant theming: see `TOKENS.md`.

## Accessibility basics

Skip link (focuses the current page's main), visible focus ring (also on plan cards), labelled form fields with 3:1 borders, tab pattern where arrows, Home and End move focus with the selection, a busy Spin button that keeps keyboard focus, an always-mounted `aria-live` region for the spin result, toasts, status never by colour alone, `prefers-reduced-motion` respected (wheel finishes without the long animation), AA contrast enforced per theme in the build.

## What is mocked

All data (`src/mock/data.ts`), signup, plans and payment (fake provider), keys (fake strings, copy does nothing), the sandbox test (timed list), go live, spin outcomes (client-side weighted random standing in for the server: a result has an id and is credited once in the store; the wheel only animates it), redemption lifecycle (timers in the store), versioned wheel publishing (in memory, lost on reload), invoices and the funnel. Unit tests cover the store and the Wheel mount rule; the UI flows are checked by a headless browser script outside the repo.
