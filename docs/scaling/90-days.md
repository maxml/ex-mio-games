# First 90 days: week table

Estimates and targets, not measurements. Reasoning is in [README.md](README.md) section 4. Revenue is expected to be zero until week 8.

| Week | Goal                     | Deliverable                                                                                     | Metric                                                                  |
| ---- | ------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1    | Close the secrets gap    | Per-service secrets on deploy; separate database owner and runtime credentials                  | Deploy drill: service A cannot read service B's secret                  |
| 2    | Choose and wire identity | Production identity provider behind the existing interface                                      | Adapter contract test passes against the provider's staging project     |
| 3    | Take payments            | Stripe adapter behind `PaymentProvider`; self-serve operator signup                             | Sandbox charge, refund and replayed webhook give one ledger effect each |
| 4    | Backups and the funnel   | Backups with a restore drill; signup-to-first-redemption funnel in Varta; pilot operator agreed | Restore time measured; funnel visible; pilot agreed in writing          |
| 5    | Real casino, sandbox     | Adapter for the pilot's platform, passing the contract suite                                    | Contract suite green; staging run on the casino's test account          |
| 6    | Go to production         | Pilot on the real casino; sandbox flag on integration credential; metering                      | One real deposit produces one spin credit, once                         |
| 7    | Reliability              | SLOs, alerts, runbooks (DLQ, `NEEDS_REVIEW`, casino down, broker down); on-call named           | Induced broker outage alerts and recovers with clean reconciliation     |
| 8    | First money              | Billing live; per-tenant rate limits; operator console for rules and catalog                    | First invoice paid (revenue milestone: first paid pilot)                |
| 9    | Stabilise                | Fix pilot findings; security review follow-ups                                                  | Two weeks with no ledger reconciliation mismatch                        |
| 10   | Second operator          | Onboard a second operator on the same platform by configuration                                 | Zero code changes in the shared repository; onboarding hours recorded   |
| 11   | Missions, build          | Missions module on canonical events; module boundary check in CI                                | Forbidden import to `integrations` fails the build                      |
| 12   | Missions, pilot          | Missions enabled for one tenant through a flag                                                  | Mission completion rate and coin cost per mission visible in Varta      |
| 13   | Measure and decide       | Retrospective: review findings per change, escaped defects, onboarding time                     | Numbers published; team size for months 4 to 6 confirmed or changed     |

Not in the 90 days: PvP, Kingdom Builder, multi-region, RNG certification, moving modules to services, websocket journal replay.
