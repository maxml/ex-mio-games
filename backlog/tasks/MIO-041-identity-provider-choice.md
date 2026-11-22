---
id: MIO-041
title: 'Identity provider choice: Firebase Identity Platform or AWS Cognito'
epic: EPIC-05
priority: P2
money_impact: none
risk_class: identity
status: blocked
depends_on: [MIO-040]
blocked_by: ['The team has not decided yet; local Firebase Auth Emulator meanwhile']
size: M
---

## Goal

Pick the production identity provider behind `IdentityProvider` and write the ADR.

## What the choice depends on

|                                         | Google Cloud Identity Platform (Firebase)                                       | AWS Cognito user pools                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Multi-tenancy                           | Native tenants in one project; the same email can exist in two tenants          | No tenant object; real isolation only with one user pool per tenant                 |
| Limits                                  | Unlimited tenants with billing enabled                                          | 1,000 pools per region by default (max 10,000)                                      |
| Price per MAU, password or custom token | 50k free, then from $0.0055 down to $0.0032                                     | Lite: 10k free, then $0.0055 to $0.0046; Essentials: $0.015                         |
| Price, SAML or OIDC federation          | 50 free, then $0.015                                                            | 50 free, then $0.015                                                                |
| Casino launch token                     | `createCustomToken` per tenant                                                  | CUSTOM_AUTH flow with three Lambda triggers                                         |
| EU data residency                       | Not listed among services with a configurable location (to confirm with Google) | Regional: the pool lives in the chosen region                                       |
| Local emulation without an account      | Firebase Auth Emulator, with tenant support                                     | Community emulator without CUSTOM_AUTH; the main alternative now needs a paid token |
| Password hash export                    | Yes (modified scrypt)                                                           | No; leaving needs lazy migration or a reset                                         |

Each `(tenant, user)` pair is one account, so one player on three casinos counts as three MAU. At 100k MAU:
about $275 per month on Identity Platform and $495 on Cognito Lite. Casino players via OIDC federation
cost about three times more than via launch token.

## One-way doors we keep regardless of the choice

1. Our own `user_id` (UUIDv7) and `tenant_id`, with a mapping to `(provider, provider_tenant, provider_subject)`.
2. Our own JWT; the provider's token never leaves identity.
3. Roles and permissions in our database.
4. Launch token as our own port `exchangeLaunchToken(tenant, signedToken)`.
5. Email unique per tenant.
6. Tenant provisioning as a saga or outbox step.

## Acceptance criteria (when unblocked)

- ADR `docs/adrs/NNNN-identity-provider.md` with the decision, cost at 10k, 100k and 1M MAU, residency
  answer from the vendor, and the migration path away from the chosen provider.
- A second adapter passes the MIO-040 contract suite.

## Notes

Prices and limits were read from the vendors' public pages on 2026-11-21; re-check before deciding.
