# MIO Games design prototype v1

Clickable prototype of the three surfaces: player widget, operator console, platform admin. Vite, React, TypeScript, Tailwind v4, CSS-variable tokens. Everything is mock data; there is no backend. It is the owner's pre-code design gate (MIO-121); its components move to Storybook later (MIO-124).

## Run

```sh
cd design/prototype
pnpm install
pnpm dev        # http://localhost:5173
pnpm build      # contrast gate, raw-colour gate, typecheck, production build into dist/
```

Screens are hash routes: `#/player`, `#/operator`, `#/admin`. The header has a tenant theme switcher (MIO default, Lucky Star Casino, Northbet); the choice is kept in localStorage.

## Screens

- **Player widget** (`#/player`): casino page mock with the widget embedded; a phone-width (375 px) toggle. Wheel with spin animation, spins available, coin balance, Bonus Store grid, redemption status (pending, issuing, issued, failed then refunded), history. "Simulate a deposit" adds spins; a store checkbox makes the casino fail the next reward to show the refund path.
- **Operator console** (`#/operator`): stepper through signup, plan, integration keys and webhook secret, sandbox casino test, spin rules (deposit at least X earns N spins), wheel reward table with editable weights, probabilities, expected payout and published versions, store catalog, redemptions with status filter, usage and invoice.
- **Platform admin** (`#/admin`): tenants, MRR, usage per operator, operator funnel.

## Components (`src/components/`)

Button, Card, StatusPill (and Badge), Table, StatTile, Wheel, CoinBalance, StoreItemCard, Stepper. Tokens and tenant theming: see `TOKENS.md`.

## Accessibility basics

Skip link, visible focus ring, labelled form fields, tab pattern with arrow keys in the widget, `aria-live` for balance, spin result and toasts, status never by colour alone, `prefers-reduced-motion` respected (wheel finishes without the long animation), AA contrast enforced per theme in the build.

## What is mocked

All data (`src/mock/data.ts`), signup, plans and payment, keys (fake strings, copy does nothing), the sandbox test (timed list), spin outcomes (client-side weighted random standing in for the server), redemption lifecycle (timers), versioned wheel publishing (in memory, lost on reload), invoices and the funnel. Verified: production build passes, and headless Chrome renders all three routes from `vite preview`. Not verified: interactions (spin, redeem, publish) were not click-tested, and there are no automated UI tests.
