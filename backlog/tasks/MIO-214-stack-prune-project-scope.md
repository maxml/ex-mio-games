---
id: MIO-214
title: Stack prune removes only this project's images, never another project's
epic: EPIC-01
priority: P2
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-002]
size: S
estimate_hours_base: 3
estimate_hours: 4
---

## Goal

Cleaning up leftover images on a shared machine cannot delete an unused image of another project.

## Scope

- The leftover pattern of the prune script matches names such as `demo-web` that other projects also use.
  Scope the match to this project's image prefix (and its compose project labels), not to service names.
- The script stays a dry run by default and never touches an image a container uses.

## Acceptance criteria

- With a fake image list (a function that lists images, replaced in the test) that holds `demo-web`,
  `other-project-web` and this project's own leftovers, the dry run lists only this project's.
- With `--yes`, the same list is removed and the others are not.
- An image used by a running container is skipped, as before.
- Mutation: restore the broad pattern. The other-project case goes red.

## Notes

Source: the second re-review of the fix round (finding F9; images unused and older than 30 minutes were
matched).
