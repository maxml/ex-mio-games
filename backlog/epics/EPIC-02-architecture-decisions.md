---
id: EPIC-02
title: Architecture and decisions (assignment Part A)
priority: P1
status: todo
---

# EPIC-02 Architecture and decisions

## Goal

A short architecture document, a diagram that renders on GitHub, and ADRs for every decision that is
expensive to change later. Everything else is done the simplest way and is not documented as a decision.

## Tasks

| ID      | Title                                                                     | Priority |
| ------- | ------------------------------------------------------------------------- | -------- |
| MIO-010 | Architecture document covering every Part A area                          | P1       |
| MIO-011 | Architecture diagram (Mermaid, renders on GitHub)                         | P1       |
| MIO-012 | ADR: which components are modules and which are services                  | P1       |
| MIO-013 | ADRs for money and data one-way doors (contract task, before the schemas) | P0       |
| MIO-014 | ADRs for platform choices                                                 | P1       |
| MIO-015 | Event envelope and contracts package (one-way door)                       | P0       |
| MIO-016 | Threat model                                                              | P1       |
| MIO-017 | Technology choices explained                                              | P1       |

## Exit criteria

- Every Part A bullet has a section in `docs/architecture/README.md` and a link to the code or ADR behind it.
- ADRs live in `docs/adrs/` and follow one template with a Confidence field.
