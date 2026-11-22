---
id: MIO-215
title: A large amount in a product event prop does not drop the whole event
epic: EPIC-10
priority: P2
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-101]
size: S
estimate_hours_base: 4
estimate_hours: 5
---

## Goal

A big deposit still shows up in the funnel. Today a numeric prop of 10 or more digits is refused as if it
were a phone number, and the event is lost (for example 1e9 minor units).

## Scope

- Separate the phone-number rule from amounts: the rule applies to string props and to numbers under a
  key that is not in a small allow-list of amount keys (for example `amount_minor`, `coins`).
- Amounts above 2^53 are sent as strings, and the schema says so.
- Interacts with MIO-210: the value rules stay in one shared module.

## Acceptance criteria

- An event with `amount_minor: 1000000000` (10 digits) and one with `amount_minor: 12345678901234` is
  accepted and emitted with the value unchanged.
- A phone number of 10 digits under a non-amount key is still refused, as a string and as a number.
- A refused event is counted (no silent drop): a counter or a log line names the reason code.
- Mutation: remove the amount-key exception. The large-amount test goes red.

## Notes

Source: the second re-review of the fix round (finding F10: analytics only, no money effect, but the
largest deposits are exactly the ones the funnel should show).
