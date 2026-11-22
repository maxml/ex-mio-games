# Screens

Screenshots of the web app (`apps/web`) running in its built-in mock mode, so the player widget and the operator console can be reviewed without running anything. All data is invented. Desktop shots are 1280 px wide, widget shots also at 390 px (phone).

How they were taken: a production build of `apps/web`, served locally, driven by headless Chromium through Playwright (the version pinned in the lockfile). The widget was clicked through the real flow: spin, open the store, redeem, wait for the casino to issue.

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
