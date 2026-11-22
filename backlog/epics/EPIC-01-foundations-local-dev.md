---
id: EPIC-01
title: Foundations and local development
priority: P0
status: todo
---

# EPIC-01 Foundations and local development

## Goal

Anyone can clone the repository, run `docker compose up`, and watch the sellable demo scenario pass,
with no cloud accounts and no manual steps. CI proves this on every change.

## Why it matters for money

The demo is what we sell. If a prospect or a reviewer cannot run it in minutes, nothing else counts.

## Tasks

| ID | Title | Priority |
|---|---|---|
| MIO-001 | Bootstrap the product from the monorepo starter (microservices layout) | P0 |
| MIO-002 | Docker Compose stack: one container per service plus infrastructure | P0 |
| MIO-003 | Clean-clone check in CI: clone, compose up, demo passes, no accounts | P1 |
| MIO-004 | Seed data: platform tenant, two operator tenants, wheel, store | P1 |
| MIO-005 | One-command demo of the first sellable slice (signup to paid plan, with the 8-step player flow) | P0 |
| MIO-006 | CI pipeline: lint, typecheck, test, build on affected projects | P1 |
| MIO-007 | Nx module boundaries enforced in lint | P1 |
| MIO-008 | MVC layering convention and its lint check | P1 |
| MIO-009 | Fail-fast configuration and `.env.example` that needs no cloud keys | P1 |
| MIO-204 | CI proven on the default stack slot with the tagged images | P1 |

## Exit criteria

- A fresh clone on a machine with only Docker and Node passes `MIO-005`'s scenario script.
- CI runs the same check and it is a required status.
