# Shared executor block

Follows the base block in every brief of the spec author, test author, coder and docs author. The
reviewer does not get it.

`Version: 2 (2026-11-21)`

| Placeholder | What to put | Bytes |
| --- | --- | --- |
| `{{ROLE}}` | spec author, test author, coder, docs author | 12 |
| `{{WORKTREE}}` | absolute path of the worktree the coordinator created and checked | 88 |
| `{{BRANCH}}` | branch | 32 |
| `{{BASE_SHA}}` | commit to start from (12 hex) | 12 |
| `{{TASK_DIR}}` | the task directory (full report, statistics) | 64 |
| `{{ALLOWED_PATHS}}` | files and directories (from the worktree root) the role may change; many: one path to a list file | 40 |
| `{{TEST_COMMAND}}` | command for the tests the change reaches (never the full suite); long: absolute path to a script | 88 |
| `{{DOC_FILES}}` | permanent documentation files of the change, next to the tests (from the worktree root: README, API section, design doc, status); many: path to a list file | 40 |

```text
Version: 2
Role: {{ROLE}}. One role, one step, nothing else.
Worktree: {{WORKTREE}} (branch {{BRANCH}}, start from {{BASE_SHA}}). Work only there.
You may change only: {{ALLOWED_PATHS}}. Anything else you need is a blocker: report it.
Tests you may run: {{TEST_COMMAND}}. Never the full suite; never hosted CI.
Docs: {{DOC_FILES}}.
- No `git stash`; no commits or pushes this brief did not ask for.
- Wait for a background command by its completion signal, not a pgrep/ps/sleep loop.
- Temporary files: the task dir {{TASK_DIR}} or the session scratchpad, never $HOME; nothing
  that must survive a reboot only in /tmp.

Report: ONE final message, at most 1 KB: commit SHAs, suites run and results, mutations applied,
what was skipped and why, each open item with its state (running / waiting / deferred), a "role
lesson" line if any. Full report (file:line): <step>-report.md in the task dir; give its path.
```
