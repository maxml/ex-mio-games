# Screens

There are two sets of screenshots, and **live mode is the default** of the compose stack.

- **Live** (`*-live.png`, listed first): the web app built with `NEXT_PUBLIC_MIO_API=http` (what `docker compose up` builds), taken against the running stack. The operator console and the player widget were driven through the browser like a user: the data is what identity, payments and engagement returned.
- **Mock** (the sections further down, files without the `-live` suffix): the web app in its built-in mock mode (`MIO_API=mock`), for review without running anything. All data is invented. These are not captures of the compose stack; to reproduce them, build with `MIO_API=mock docker compose build web`.

## Live mode

How they were taken: the stack up in a fresh compose project, the operator flow clicked through at `http://localhost:<web port>/en/operator`, then `scripts/web-live-player.sh` (plays the casino: reward API, signed deposits, a signed launch token) and the widget opened from the URL it prints. Playwright with headless Chromium, 1280 px wide.

| Image                                                                        | What is real                                                                                                      | What is still the mock                                                                            |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `operator-1-signup-live.png`                                                 | Account: identity signup and login (tenant `<slug>.mio.localhost` from the company name)                          | none                                                                                              |
| `operator-2-plan-live.png`                                                   | The plans and prices come from payments                                                                           | the selection highlight is held in the browser                                                    |
| `operator-3-plan-paid-live.png`                                              | A real payment attempt and subscription (fake provider, test card); the paid plan is read back from payments      | none                                                                                              |
| `operator-4-keys-live.png`                                                   | Sandbox credentials issued by identity (key id, API key and HMAC secret, shown once; the secrets are hidden here) | none                                                                                              |
| `operator-5-sandbox-live.png`                                                | nothing                                                                                                           | the sandbox check: no service route (known-gaps G-4)                                              |
| `operator-6-golive-live.png`                                                 | nothing                                                                                                           | go-live and the first live deposit: no service route (G-4). The keys shown are labelled `EXAMPLE` |
| `operator-7-rules-live.png`                                                  | `PUT /v1/operator/rules`: the rule is stored by engagement                                                        | reading it back into the console                                                                  |
| `operator-8-wheel-live.png`                                                  | `PUT /v1/operator/wheel`: the new reward table version is stored by engagement                                    | the versions table (no read-back route)                                                           |
| `operator-9-store-live.png`                                                  | A Bonus Store item created in engagement (`POST /v1/store/items`) and listed back                                 | none                                                                                              |
| `operator-10-redemptions-live.png`                                           | Redemptions of engagement (empty until a player redeems)                                                          | none                                                                                              |
| `operator-11-usage-invoice-live.png`                                         | Usage of the month and the invoice of payments                                                                    | the trend arrows and the per-day chart (G-6)                                                      |
| `widget-1-balance-live.png`                                                  | Launch token exchanged through identity; balance from payments, spins from engagement                             | none                                                                                              |
| `widget-2-spin-result-live.png`                                              | A spin decided by engagement; the coins arrive through payments                                                   | none                                                                                              |
| `widget-3-store-live.png`                                                    | Store items and prices from engagement                                                                            | none                                                                                              |
| `widget-4-redemption-pending-live.png`, `widget-5-redemption-final-live.png` | The redemption saga: coins held, the casino (casino-sim) issues the bonus, status Issued                          | none                                                                                              |
| `widget-6-history-live.png`                                                  | nothing                                                                                                           | the coin history: no ledger-history route (G-1)                                                   |

## Mock mode

Desktop shots are 1280 px wide, widget shots also at 390 px (phone). How the mock set was taken: a production build of `apps/web`, served locally, driven by headless Chromium through Playwright (the version pinned in the lockfile). The widget was clicked through the real flow: spin, open the store, redeem, wait for the casino to issue.

## Player widget

| Image                                                              | Caption                                                                                                                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `widget-1-balance.png`                                             | Daily Wheel at rest: coin balance, spins available, the three tabs.                                                                                   |
| `widget-2-spin-result.png`                                         | After a spin: the server-decided result is announced. The reward shows as "pending" next to the last confirmed balance until the credit is read back. |
| `widget-3-store.png`                                               | Bonus Store: affordable, too expensive ("N more coins needed") and sold-out items, each with the reason on the card.                                  |
| `widget-4-redemption-pending.png`                                  | A redemption was just made: coins are held and the order shows as Pending.                                                                            |
| `widget-5-redemption-final.png`                                    | The same redemption after the casino issued it: status Issued.                                                                                        |
| `widget-1-balance-390.png` ... `widget-5-redemption-final-390.png` | The same five states at 390 px width.                                                                                                                 |
| `widget-6-dark-theme-store.png`                                    | Tenant theme "Lucky Star" (dark, purple and gold): the same widget re-skinned only through design tokens.                                             |

## Operator console

| Image                            | Caption                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `operator-1-signup.png`          | Step 1, sign up: account created, sandbox ready.                                                                       |
| `operator-2-plan.png`            | Step 2, plan choice before payment (the test-mode card form follows).                                                  |
| `operator-3-keys-sandbox.png`    | Step 3, integration keys: the sandbox (test) keys and webhook secret, revealed.                                        |
| `operator-4-production-keys.png` | Step 5, go live: production keys unlocked after a paid plan and a passed sandbox test; the first live deposit arrived. |
| `operator-5-usage-invoice.png`   | Step 10, usage and invoice: spins per day and the monthly invoice.                                                     |

## Operator console by role (IA rework)

Mock mode, 1280 px, written by `apps/web/e2e/operator-roles.spec.ts` (`NEXT_PUBLIC_MIO_API=mock pnpm --filter @ex-mio/web e2e operator-roles`). The role is the shell's Role picker. A guard that denies a page sends the role to its landing page with `?denied=`, which is what the landing shots show.

| Image                               | Caption                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `operator-ia-admin-nav.png`         | Admin: all seven pages in the nav.                                                        |
| `operator-ia-admin-landing.png`     | Admin lands on Setup (the shop is not live yet).                                          |
| `operator-ia-admin-setup.png`       | Admin, Setup: the six steps and only the open one.                                        |
| `operator-ia-admin-rules.png`       | Admin, Rules.                                                                             |
| `operator-ia-admin-redemptions.png` | Admin, Redemptions: the queue, a review row with Resolve, and the resolve panel open.     |
| `operator-ia-admin-insights.png`    | Admin, Insights: usage, the player funnel (preview) and invoices with Pay.                |
| `operator-ia-staff-nav.png`         | Staff: Store, Redemptions, Insights, Team.                                                |
| `operator-ia-staff-landing.png`     | Staff lands on Redemptions after Rules was denied: the access notice, no Resolve button.  |
| `operator-ia-support-nav.png`       | Support: Insights and Team.                                                               |
| `operator-ia-support-landing.png`   | Support lands on Insights after Redemptions was denied: the access notice, no Pay button. |
