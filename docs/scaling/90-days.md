# First 90 days: plan by phase

Targets, not measurements. Reasoning is in [README.md](README.md) section 4. The percentages and latency figures are proposals; the latency and throughput targets come from the SLO table of backlog task MIO-193 (EPIC-18) once it exists and replace the proposals here.

The slice already exists: P0 is implemented, demoed and deployed to a pre-production server with Deckhand. So the plan starts with taking it to production, which is code work of days. The rest of the 90 days is set by things that are not code.

## What sets the calendar

- A real casino partner: API access, a sandbox account and a signed contract. Nothing can be tested against a real casino before these exist, so the conversation starts on day 1 and runs alongside everything else.
- Real payments: a Stripe account in the company's name, legal entity details and tax set-up.
- First paying operators: onboarding, their feedback, and iterating on real data from the Varta analytics panel.
- Security review and gambling-compliance requirements in each target market.
- Hiring: the people in the team answer (README section 5) have to be found and started.

The AI-assisted, reviewed process shortens the coding share of each phase. It does not shorten any of the five items above.

## Weeks 1 and 2: take the existing slice to production

- Close the follow-ups MIO-198 to MIO-216 and the known gaps in `docs/submission/known-gaps.md`: guards that fail open (migrations, deploy defaults, environment defaults), log redaction and auth-refusal logs, console screens still answered by a mock in live mode, outbox rows with no queue, spin key upgrade and seed secrecy, CI on the default stack slot.
- Real secrets: one secrets file per service on the server, separate database owner and runtime credentials, production identity provider behind the existing interface.
- Monitoring and alerts on the SLO table (MIO-193) with a load-test baseline (MIO-194), runbooks for the dead-letter queue, `NEEDS_REVIEW`, casino down and broker down.
- Backups with a measured restore drill.
- Repeat on the production host the deploy that is already proven on the pre-production server.

Exit: the production deploy drill passes (service A cannot read service B's secret); a restore is measured; an induced broker outage alerts and recovers with a clean ledger reconciliation; a fresh tenant gets a spin from a signed deposit with no SQL.

## Days 15 to 30: first real casino integration

Starts as soon as the partner's sandbox access exists. An adapter built on the canonical model and the how-to in `docs/how-to/where-to-change.md`, passing the contract suite.

Exit: contract suite green against the casino's sandbox; one test deposit gives one spin credit, once; zero double rewards across a replayed-webhook run; Stripe sandbox charge, refund and replay give one ledger effect each; security review started.

## Days 31 to 60: first paying operators

Pilot on the real casino, self-serve operator signup, billing live, per-tenant rate limits, the signup-to-first-redemption funnel in Varta, fixes from the pilot's findings.

Exit: at least one operator live on a real casino and paying (first invoice paid); real deposits processed with each credited once; redemption success rate at or above 99% reaching a final status within 2 minutes; p95 latency inside the EPIC-18 SLOs; zero double rewards; two weeks with no ledger reconciliation mismatch; security review findings closed.

## Days 61 to 90: second operators and the new mechanics

A second operator by configuration only. Then the mechanics from Part E question 3, in the same reviewed process: Missions on canonical events (module boundary check in CI) enabled for one tenant through a flag; PvP (coins only, versioned seed an auditor can replay) and Kingdom Builder as separate services in staging.

Exit: at least two paying tenants; the second onboarded with no code change in the shared repository; Missions live for a paying tenant with completion rate and coin cost visible in Varta; PvP matches and Kingdom Builder buildings settled in staging with zero double rewards; the money and trust numbers above held for the whole phase; retrospective published (review findings per change, escaped defects, onboarding time) and the team size for months 4 to 6 confirmed or changed.

Not in the 90 days: real-money PvP, multi-region, RNG certification, moving existing modules to services, websocket journal replay.
