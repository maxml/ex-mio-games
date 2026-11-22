---
id: MIO-199
title: Product events take the environment from one source, not a required field nobody reads
epic: EPIC-10
priority: P2
money_impact: none
risk_class: isolation
status: todo
depends_on: [MIO-105, MIO-160]
size: S
estimate_hours_base: 6
estimate_hours: 8
---

## Goal

A product event always carries the environment of the request that caused it. Production and sandbox
funnels must never mix because two fields can disagree.

## Scope

- `ProductAuth.sandbox` in the logger package is required but never read by the emit helpers; the
  environment on the event comes from a separate `props.sandbox`. Make one of them the only source.
- The engagement helper that builds a player actor returns the current auth and ignores its `sandbox`
  argument; make it use, or drop, that argument.
- Update every emit site and the product-event docs.

## Acceptance criteria

- A test builds an event with an auth context of one environment and a conflicting `sandbox` input: the
  call is refused at the helper (a type error or a thrown error), or the conflict cannot be expressed.
- Every product event emitted in a sandbox request carries the sandbox flag, and every production one does
  not (one test per emit site listed in `docs/analytics.md`).
- Mutation: make the helper take the environment from the other source. The test above goes red.
- No field of `ProductAuth` is unread (a lint or scan test lists the fields and their readers).

## Notes

Source: the re-review of the fix round (finding R8: the field gives false assurance, and the two values
can disagree).
