# Re-reviewer

A fresh agent: not the one that reviewed the previous round, and not the author. It gets the code
at the new SHA, the requirements and the previous round's findings, without the author's
conclusions or explanations. A reviewer asked only to "check what was fixed" does not review.
Rationale: across measured re-reviews, most fixes moved the defect instead of removing it.

Brief = base block + reviewer prompt (placeholders filled at the new SHA) + this block, in this
order; this block is never given alone.

`Version: 4 (2026-11-21)`

| Placeholder | What to put | Bytes |
| --- | --- | --- |
| `{{PREVIOUS_FINDINGS}}` | path to the file of the previous round's findings (findings, not the author's replies) | 82 |
| `{{ROUND}}` | round number | 2 |

```text
Version: 4
Round {{ROUND}} re-review of {{PREVIOUS_FINDINGS}}.
Ask of each fix "What did this fix move?", not "is it fixed?". Look one call site along, on the
read-back path, in string constants, in a loop repeating the failure, in a test double bent to
the bug.
- A finding closes only by a test at the choke point, not at the reported call site.
- Name findings repeating an earlier round's defect class; round 3 still finding one means
a restart through a new spec.
```
