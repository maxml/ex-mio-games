# Re-review brief

For round 2 and later, given to a fresh agent. One message, in this order:

1. `../roles/base.md` (code block)
2. `../roles/reviewer.md` (code block, then its risk-class line), placeholders filled at the new SHA
3. `../roles/re-reviewer.md` (code block)

Input: the new SHA, the requirements, the previous round's findings file. Not the author's replies.
The finished brief is at most 3072 bytes (`wc -c`). A round 3 that still finds a defect class
means a restart through a new spec, recorded by the coordinator; there is no "one more round".
