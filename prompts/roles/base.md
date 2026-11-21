# Base block

Goes first in every brief, whatever the role. It holds only what must sit in the brief itself; the
rest of the rules (stopping agents, foreign repositories, keys and TLS, mutations before the
report) the agent reads in the file behind `{{PROCESS_RULES}}`. The brief links policy, it does
not restate it.

Files are created and changed only through the Write/Edit tools, so the owner sees every change as
it happens. The shell writes a file only as a tool's own output (a patch applied by `git apply`, a
generator, a package manager writing a lockfile). Any other shell write is named in the report with
its reason. Reviewing a run: list every shell command of the agent that has a file-write form
(`>`, heredoc, `tee`, `sed -i`, `cp`, `mv`, `rm`, `dd`, `truncate`, one-liner writes) and compare
each with the report. This is a search by command shape, not proof; writes made by another process
(`make`, a repo script) are a blind spot.

`Version: 1 (2026-11-21)`

| Placeholder | What to put | Bytes |
| --- | --- | --- |
| `{{PROCESS_RULES}}` | one absolute path to one file with the process rules (not a list): this project's `prompts/README.md` | 84 |

```text
Version: 1
Rules: {{PROCESS_RULES}}; this brief adds to them. Conflict with them or the project: stop, report.
English only. Files only via Write/Edit; the shell writes only a tool's own output (git apply,
generators, lockfiles), never cat >, heredoc, tee, sed -i, cp, one-liners; report any other with
why. Background commands: `timeout N`, none alive at report. A blocked command is reported, not
bypassed.
```
