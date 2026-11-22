# 0012. Diagrams as code: archify, with a Mermaid copy

- Status: accepted
- Deciders: product owner (maxml), architecture session
- Date: 2026-11-21
- Confidence: medium

## Context and problem statement

The submission needs an architecture diagram that stays true as the code changes. Hand-drawn images drift. Reviewers also need to read the diagrams on a plain git host without opening a generated page.

## Decision drivers

- Diagrams must be reproducible from text and checked in CI.
- Owner: try archify; it is a git submodule in the product and not needed in the starter; Mermaid is required too.
- Readable on GitHub without running anything.

## Considered options

1. Mermaid only.
2. Archify only.
3. Archify as the interactive source, with a Mermaid copy for each diagram.

## Decision outcome

Option 3.

- Archify is the submodule `tools/archify`, pinned to a commit; its version is recorded in `docs/architecture/README.md`.
- Each diagram has a typed IR file (`docs/architecture/*.json`) validated by `archify validate`, and a rendered HTML next to it.
- `docs/architecture/README.md` links the HTML and embeds a Mermaid copy of each diagram, which GitHub renders inline.
- `tools/archify-render.sh` re-renders and validates all IR files. CI runs it and fails on a validation error.
- The IR and the Mermaid copy are written by hand and must agree; a reviewer compares them when either changes.

### Consequences

Good: validated, layout-checked interactive diagrams, plus a fallback that renders anywhere.

Bad: two representations to keep in step; archify is a third-party tool with its own release cadence, so the version is pinned and upgrades are deliberate; the submodule is large.

## Built vs designed

- Built: five IR diagrams, rendered HTML, Mermaid copies, the render script.
- Designed only: an automated check that the Mermaid copy and the IR describe the same nodes.
