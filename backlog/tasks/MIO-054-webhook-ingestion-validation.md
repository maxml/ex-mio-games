---
id: MIO-054
title: "Webhook ingestion: signature, timestamp window, per-tenant secret, schema validation"
epic: EPIC-06
priority: P0
money_impact: direct
risk_class: admission
status: todo
depends_on: [MIO-050]
size: M
---

## Goal

Only real, fresh events from a tenant's own casino get in (assignment step 2: validate).

## Scope

- `POST /v1/integrations/{tenantSlug}/events`: the adapter verifies an HMAC signature with a timing-safe
  compare, using the tenant's webhook secret; the timestamp must be within five minutes.
- Two active secrets per tenant during rotation.
- Schema validation by the adapter; unknown event types are acknowledged and ignored, not errors.
- Rejections are logged with a reason code and counted as a metric, without the raw body.

## Acceptance criteria

- Missing, wrong or other-tenant signature: 401, no row written, no event published.
- Stale timestamp: 401 with reason `stale`.
- Valid signature with schema-invalid body: 422, nothing published.
- After rotation, events signed with the old secret are accepted until it is revoked, then rejected.
