# Role prompts and process rules

This directory holds the process this project uses to build with agents: seven roles (spec author,
test author, coder, reviewer, re-reviewer, docs author, coordinator), the order they work in, and
the brief templates a coordinator fills in. The rules in sections 1 to 7 below are what every brief
points to through `{{PROCESS_RULES}}`.

Provenance: derived from the maintainer's process notes, which are maintained outside this
repository. This copy is derived, not the source. If it and the source disagree, the source wins and
this copy is regenerated; changes to the rules are made at the source first, not edited here.

## Files

| File | What it is |
| --- | --- |
| `README.md` | this file: how to use the prompts, and the process rules (sections 1 to 7) |
| `roles/base.md` | base block: goes first in every brief |
| `roles/executor-shared.md` | shared block for the executor roles |
| `roles/spec-author.md`, `test-author.md`, `coder.md`, `docs-author.md` | executor role prompts |
| `roles/reviewer.md`, `re-reviewer.md` | review role prompts |
| `roles/coordinator.md` | coordinator prompt, for when the coordinator is started as an agent |
| `briefs/task.md`, `review.md`, `re-review.md` | which blocks make a brief, and in what order |
| `evidence-table.md` | the per-task table the reviewer fills before merge |
| `../.claude/agents/<role>.md` | thin agent wrappers that limit each role's tools (tracked in git) |
| `../ci/check-prompts.sh` | structural check: Version line, placeholders match their tables, filled briefs fit 3072 bytes, every role has a tracked wrapper with the right tools |

`ci/check-prompts.sh` runs in the `ci` workflow and in the pre-commit hook when `prompts/`,
`.claude/agents/` or the script changed.

## Process in one paragraph

A spec author writes the contract (one property, out-of-scope list, "works" on a real input, the
single choke point). A test author writes failing acceptance tests from it and freezes them. For a
risky class (guard, identity, admission, budget, locks, concurrency, ownership, isolation boundary)
the reviewer also commits red tests before any code. The coder implements until the frozen tests
pass. A fresh reviewer then tries to break the change on a committed SHA, writes a regression test
per finding, and applies one mutation per claimed guard. A re-reviewer on the new SHA asks "What did
this fix move?" of every fix. A third round that still finds a defect class ends in a restart through a
new spec; there is no "one more round". A docs author updates
the permanent documentation in the same merge. Each role is a fresh agent for each step, round and
task; its only input is files.

## How a coordinator assembles a brief

1. Pick the brief file: `briefs/task.md` for an executor role, `briefs/review.md` for the reviewer,
   `briefs/re-review.md` for round 2 and later. The coordinator itself starts from
   `roles/coordinator.md` after `roles/base.md`.
2. Concatenate the code blocks in the order that file gives, as one message. Each role file has a
   `Version: N` line (the date of that version is in the line above its placeholders table) and a
   table that lists every placeholder with the largest value it may take, in bytes.
3. Fill every `{{...}}`. An unfilled placeholder means the brief is not ready; a value that does not
   exist is the word "none", not a blank. Set `{{PROCESS_RULES}}` to the absolute path of this file.
4. Size: the finished brief is at most 3072 bytes (`wc -c`). The byte ceilings in the tables are
   design limits that size the template; the binding check is `wc -c` of the finished brief. Where
   a value has several members, such as the risk classes in `{{RISK_CLASS}}`, use the highest class
   or a short comma list as long as the total fits. A longer value (the owner's
   permissions verbatim, a long file list) goes into a file and the brief carries its path. Do not
   edit a block to fit; if a block cannot fit with its documented values, the block is shortened at
   the source.
5. Paths in a brief are absolute. The brief does not restate policy; it names this file. A reviewer
   gets code and requirements, never the author's conclusions.
6. Changing the meaning of a prompt raises its `Version` and its date; a typo fix does not. Copies
   of a prompt are updated by their owner.

## Variants

This is the minimal variant: the prompts, the three brief files and the evidence table. The full
variant is deferred to backlog tasks MIO-175 to MIO-179 (low priority) and is not an instruction
here. It adds: prompt layers (role core without stack, agent adapter, language, framework, target,
lens, task), a role registry (version, layers, model, judge family), builds signed as
`role/vN@sha8` in the commit and PR, immutable `vN`, evals (sets with seeded defects, dev and
held-out; a new version ships only if held-out is no worse), and a separate security check against
prompt injection in the input. None of that exists until those tasks are done.

## 1. Product before code

- **Define "works" before the first test.** In the task's spec (or ticket), before the work starts,
  on a real input: which inputs must change; what must improve so that a person sees it, not a
  counter; what must stay unchanged; two examples of a useful change and two of correct restraint.
  The number of changes and a low error count do not prove usefulness. Failure: twenty review rounds
  asked whether the code was right and none asked what the pipeline does to the text; 2 of 56 texts
  changed and refusals were read as safety. Check: contract review refuses without these five
  items; the reviewer writes a separate line "does / does not do its job" on a real input.
- **A baseline before the work.** Compare the key design hypothesis with a simple baseline on the
  same inputs; the numbers are in the log before the first task starts. A negative result stops the
  design instead of adding another guard: it is a product decision that goes to the owner in words
  ("what does this give a person"), with options. Failure: a plain instruction to the model won
  with readers, 99% against a built pipeline. Check: a "baseline" line with numbers in the log
  before the first task starts.
- **Contract review before code.** 15 to 20 minutes of a fresh reviewer: the five items above, the
  allowed files, and the list of blockers every later round carries: false green, data loss, secret
  leak, hang, regression. A contract too big for about 1000 changed lines is cut; one merge is up to
  about 1000 lines. Failure: one task had 11 blockers before code; without the contract they would
  have become rounds. Check: the task log has a contract review entry earlier than the first code
  commit.
- **When the owner disagrees with the numbers,** start by checking the inputs, the versions, the way
  of running, and what exactly was measured; find the cause, do not assign it. A conclusion about a
  tool comes only after running the tool itself, not a port of it. Check: the log lists what was
  checked.

## 2. The subagent brief

The brief is the agent's only context, so it carries the constraints; what it does not name does not
exist. A brief is not above the project's rules: an agent that sees a conflict between the brief and
the rules stops and returns the conflict to the coordinator, it does not choose. The brief names, by
absolute paths: the worktree (created and checked by the coordinator), the role (section 5), the
allowed files, the behaviour with one real example, the suites that may run (never the full suite),
the documentation file next to the tests, and the report shape: ONE message at the end, a summary of
at most 1 KB (SHA, suites with results, mutations, job and run identifiers the project keeps, what
was skipped and why, every open item with its state) plus the path to a full report in the task
directory or in the ticket. Findings with file:line, repro condition and consequence live in the full
report and are never cut to fit the limit. The brief forbids `git stash`, commits and pushes nobody
asked for, and background processes alive at report time. It links policy instead of restating it. A
reviewer gets code and requirements, never the author's conclusions.

Working language: every agent works and writes in English (briefs, reports, review files, code,
comments, commit messages, test names, logs); no other language is allowed in them. Messages to the
owner are in the owner's language. The language of a product's content or test corpus is product
data, not the agents' working language.

- Failure: a brief saying "run all 1141 manifests" overrode the scoped-test rule; one agent's
  `git stash pop` applied and dropped another agent's stash.
- Check: the coordinator reads the report against the brief; a report without SHA, suites, or the
  states of open items is returned, not accepted.

Repositories that are not yours are read-only. Never pass keys or secrets; never disable TLS
verification. Before the report, mutate each guard you added and show that its test fails.

## 3. Tests and the long check

- Run only the tests the change reaches; the full suite runs once per series on the integration
  branch; tests whose code did not change are not re-run. Check: the report names suites and SHA.
- **Every test family has one of four results:** passed (with scope: which suites, which SHA),
  failed, not run, not applicable. "Not run" is never hidden in green; "not applicable" only when
  the project has no such family; a level the project has that did not run before the series merge
  is a failure, not "absent". Merge is blocked when a family required for the change set (the
  touched suites, their consumers, end-to-end or live smoke where the change touches the seam they
  run) did not run. Failure: five tasks merged after the fast level while the whole end-to-end suite
  was red and nobody wrote "e2e: not run". Check: before merge, one row per family.
- **One long integration check per part.** The unit of integration is an epic or a large shared part
  (a subsystem or a seam), not a number of tickets: all its tickets go on one integration branch,
  one long check for the whole part; the next part is built while it runs. A tracker without epics:
  group the tickets into modules first. Failure: series of 2 or 3
  tickets, each followed by a check of about ten hours. Check: the log names the part, its tickets
  and the duration before the check.
- **The machine is shared.** Before a heavy run, look at `uptime`, pressure stall info and
  `MemAvailable` of the whole machine, not only your processes. Several full runs at once are
  allowed; the limit is memory: the run's peak fits in `MemAvailable`; announce start and end. A
  lock only protects the machine: it waits while the measured load is out of bounds; a lock that
  merely queues runs is forbidden. Failure: four agents and a three-part end-to-end run at load 47.
  Check: `uptime` in the log before the run.
- **Take duration from the tool, not from the start time,** and know what it measures: a tool's step
  time field versus process age, which includes machine sleep. A long unattended run goes under
  `systemd-inhibit --what=sleep:idle` or the platform equivalent. Failure: "the run takes 10 hours"
  was 40 minutes and a night of sleep. Check: a number given to the owner has a source field.
- **A fix of the check itself, CI or a hook is merged separately and first,** after a proven cause
  (what exactly changed between green and red), not a guessed one; the coordinator's own "small"
  edits run the tests they reach. Failure: two small edits broke a test (a changed message text, a
  missing import). Check: such a fix is its own commit and its own merge.
- **Hosted CI of a private repository is paid.** Every job rounds up, shards multiply the bill; on
  hosted CI run only the hermetic minimum; the full suite, mutations and the red suite run locally;
  no `push: main` trigger for a fast-forward of an already verified commit. Only the coordinator
  runs hosted CI, never an executor.

## 4. Review: rounds, findings, evidence

- **A separate agent, not the author; on a committed SHA; in its own worktree.** The reviewer does
  not trust green tests and looks for a concrete scenario they miss. It works in its own throwaway
  worktree cut from the branch, so the author's staged, unstaged and new files never reach it: the
  candidate is committed first, and the verdict names the SHA and holds only while that SHA is the
  branch head. A fix after review is committed again and checked at the new SHA. Accepted reviewer
  tests move into the branch unchanged and are compared byte by byte. Failure: an audit found 20 of
  30 tasks accepted in the first round with a single mutation. Check: the verdict has a SHA; the
  author's worktree has no reviewer edits.
- **Scope is fixed at the start:** one property and an explicit out-of-scope list. A fix that needs a
  new mechanism (a thread, a lock change, a new RPC, a new record field) stops at a spec. Guard,
  identity, admission, budget, locks, concurrency, ownership, isolation boundary: a spec checked
  before code and the reviewer's red tests before code. The spec, tests and code are written by the
  executor roles (section 5), with no author on a stronger model; the coordinator only supervises;
  the risks are checked by the reviewer on the strongest model available. For executor mistakes the
  third round rewrites the ticket (the next item); the model is not changed. Failure: seven rounds of
  patching a symptom because no spec preceded the code; a spec and 50 red tests closed 12 holes
  before code. Check: the ticket has the property and the out-of-scope list before the first commit.
- **Every finding is sorted before the next brief** into one of three classes: caused by this change,
  so another round; old or neighbouring, so its own task in the same series, not a follow-up after
  the series; a documentation line, an error text, a test rename, so the executor of the same round
  writes it, not the coordinator. Only the owner defers, with a concrete reason; the coordinator
  carries it as a package (section 6). Moving an item into a task of a series started in the same turn
  is not deferral. Failure: rounds grew because every finding went back into the same task; after 26
  closed tickets six carried follow-ups made the ticket transfer unusable. Check: every fix in
  `review.md` has a class; the final report has no open follow-up, or each deferred one carries the
  owner's decision.
- **A third round that still finds a defect class stops the patching.** The coordinator decides, not
  the author and not the reviewer: a restart of the series from a spec. The open findings go into a
  ticket, a spec is written (property, out of scope, the one place that decides it), and the new
  design starts a new series with its own rounds; the decision and its reason are recorded in
  `review.md`. The round count runs through the whole series, and "minor, one more round" does not
  exist. A fix that did not close its own findings is redone and is not counted as a round. The owner
  is informed; asked only when product direction or price changes. A defect found after the limit is
  recorded and blocks. Failure: seven rounds in one first version. Check: after round three
  `review.md` has the record of the restart from a spec with the reason; a fourth round without it
  blocks merge.
- **The reviewer writes the regression test for a finding before the fix,** at the point where the
  bad value cannot be constructed, not at the symptom; the finding is phrased as a property at that
  point, not as a symptom. A fix that only moves the symptom is the usual case, not the exception;
  re-review asks "What did this fix move?". Failure: on a seven-ticket epic, three of four fixes
  moved the defect. Check: the test for the finding is in the suite before the fix commit; the test
  author is not the fix author.
- **One mutation per claimed guard (a fix may carry several), re-applied by the reviewer** in its own
  worktree and reverted after: revert the guard, see that exactly this test goes red, and confirm the
  mutation really applied; including the widening of each allowlist and the disabling of each limit.
  Failure: twice a mutation did not apply and the green result meant nothing. Check: the evidence
  table has a row per guard: mutation, the test that went red, who wrote it.
- **Every durable record has a reader test:** what is written is read by its consumer and described
  correctly. Failure: a statistics command showed 0 results all night with 37 records written. Check:
  a row per record in the evidence table.
- **The reviewer re-runs the author's numbers and conclusions** with its own commands (some of the
  author's numbers and conclusions did not reproduce). A check that reports problems is scored both
  ways: misses as much as false alarms; every real miss already seen becomes a required test.
  Failure: four rounds removed false flags while the report was silent about the loss that started
  everything. Check: the review report has a set of known losses and the checker's result on it.
- **An evidence table before merge,** in the place the project's rules name (`review.md` of the task,
  or a ticket comment; see `evidence-table.md`): a row per guard (mutation, test, test author), per
  record (reader test), per number and conclusion (re-run yes/no). An empty cell in a blocker row:
  do not merge.

## 5. Agents, waiting, background processes

- **One role, one fresh agent per step.** Spec author, test author, coder, docs author and reviewer
  are separate agents; the next step, fix round or task is a new agent; the only input is files. Each
  role has its own constraints and lessons. Check: in the task log every step has its own agent id.
- Every background command runs under `timeout N`; the harness deadline does not replace it. Where
  the harness allows it, wait in the foreground in steps of up to about 9 minutes. A subagent reports
  without live processes of its own; every open item in a report has a state (below) and returns to
  the coordinator. Failure: shells and monitors outlived the agent's report four times. Check: the
  harness's list of background tasks at the end of the turn has none of yours.
- Wait for background work by the harness signal or the tool's own watcher, never by a loop over
  process names or `ps`. Failure: `until ! pgrep -f ...` matched itself and waited 90 minutes after
  the work was over. Check: no `pgrep` or `sleep` loops in the transcript.
- Stop an agent with the harness stop verb; never run kill, pkill, killall or systemctl stop. The
  verbs are Claude Code `TaskStop` and Codex `interrupt_agent`. Stop it
  right after its report. Do not act on a parent process read from `ps`. A process outside the
  harness: the project's own tool, or `kill PID` of your own process after `ps -o args -p PID`;
  `pkill` is forbidden. Failure: this is how the owner's own session was once stopped. Check: every
  `kill PID` is preceded by a `ps` of that PID.
- A hook or a permission check blocked a command: report it, do not bypass it with another shell, a
  wrapper or an agent. Collect missing permissions at the start in one message with the exact lines.
  Failure: four separate blocks in a day; a reviewer reformatted commands to get around a hook.
  Check: permission requests are in the session's first message.
- **A turn that ended does not mean the task ended.** Every open item is in exactly one written state:
  **running** (a live process or agent, owner, deadline), **waiting** (on whom, since when, what
  unblocks it, and the wait deadline), **deferred** (a concrete reason and the owner's decision,
  section 4). An item without a state is lost work. Before the end of a turn nothing in running is
  left standing, and waiting does not stop independent work: start the next item. Failure: a ticket
  stayed `in_progress` for several turns while nobody started an agent. Check: the request-to-status
  map has every open item with its state; running names a live worktree, pid or agent.
- Temporary files only in the session scratchpad or the project's task directory, never in `$HOME`;
  what must survive a reboot is never only in `/tmp`; a test that creates directories uses `TMPDIR`.
  Check: `ls ~` has no test directories.

## 6. Talking to the owner

- **What to ask about:** money, secrets, irreversible actions, product direction, and the approvals
  the project's rules name (a full long check, merge or push to the main branch, deleting someone
  else's worktree), in one package. Decide the rest yourself within the permissions, and write what
  you decided and why. **Who asks:** only the coordinator, the session that started the work. It
  collects the questions of agents, decides what is within permissions, and brings the owner only
  these classes, as a package; executors and reviewers do not ask the owner, they return a blocker to
  the coordinator. Failure: questions about a review round and about trivia. Check: every question in
  a report belongs to one of these classes and comes only from the coordinator.
- **Check the state yourself first.** Before reminding or asking, check with a command that it is not
  already done, and name the command. Failure: a reminder about an item already done.
- **Plain words**, without jargon; options when the decision is really the owner's.
- **Status from real data:** how many tasks landed in the main branch in the period, hours since the
  last merge, what each task is doing now, then a table of tasks and what went wrong; more than 8
  hours without a merge: write the reason yourself. Check: every number in a status has a command.

## 7. Documentation and closing

- **A behaviour change arrives in the same merge as permanent documentation** (README, API section,
  design doc, contracts). The backlog, status notes, review files and commit messages are not
  documentation. The reviewer checks that the description exists and that no old sentence became
  false. Failure: two items lived only in the backlog while the README still said "parked" instead
  of "refusal 429". Check: the brief names the documentation file next to the tests.
- **When a tool changed, the notes change too.** A change of a command, flag, output or exit code
  merges together with an edit of every document that describes it: grep the name across the docs,
  every line matches the new behaviour. Failure: about 60 stale statements in one audit. Check: a
  grep of the name finds no line with the old behaviour.
- **A merged phase is not a finished ticket.** A ticket closes against the whole definition of done,
  line by line, and the product status says what works end to end, what is only a component, and what
  is not integrated. Check: closing a ticket comes with the definition of done passed.
- **A ticket moves with every step, and the coordinator moves it:** start, in progress; block, a
  comment with the question; done, done with a comment carrying the merge SHA, the test run and what
  was verified live; abandon, back to the queue with the reason. The description is only the task's
  statement and changes only when the task changes; the summary of the work goes into a comment. A
  project without a tracker records the same in its docs or log. Failure: five tickets were done in
  code for weeks while the tracker showed them open. Check: every start, block, done or abandon event
  has a matching ticket comment; the description holds no merge SHA.
- **Closeout with explicit states:** every step is done or "deferred and why"; at the end a
  request-to-status map where each item of the request is done or deferred with a reason. What is
  unfinished is visible, not lost. Check: the map is in the task's last message.
- **The coordinator verifies the end state live, not by the commands that ran.** At the end of a
  feature the coordinator runs it on a real input (a real ticket, file, request), repeats exactly what
  was broken, and measures the effect; an action with no effect (0 changed, nothing freed, the metric
  unchanged) is a failure, not "done". The report separates VERIFIED (seen by the coordinator, with
  the command) from ASSUMED (only expected). Failure: a pipeline was "offline-proven only": tests
  green, never run live, and the owner moved the tickets by hand in an hour. Check: the last report of
  a feature has a verified/assumed section with commands.
