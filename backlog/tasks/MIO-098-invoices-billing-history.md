---
id: MIO-098
title: Invoices and billing history in the operator console
epic: EPIC-09
priority: P1
money_impact: direct
risk_class: ownership
status: todo
depends_on: [MIO-093, MIO-095]
size: S
estimate_hours_base: 6
estimate_hours: 8
---

## Goal

Operators see what they pay for, which reduces churn and support load.

## Scope

- Current plan, period usage against included amounts, projected bill, past invoices with status.
- Link to the provider's hosted invoice when `stripe` is active; a generated summary with `fake`.

## Acceptance criteria

- Projected bill equals base fee plus overage computed from MIO-095 meters (unit test with fixtures).
- An operator sees only their own tenant's invoices.
