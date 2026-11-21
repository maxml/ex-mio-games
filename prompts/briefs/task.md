# Task brief (executor roles)

For the spec author, test author, coder and docs author. One message, in this order:

1. `../roles/base.md` (code block)
2. `../roles/executor-shared.md` (code block)
3. the role prompt: `../roles/spec-author.md`, `test-author.md`, `coder.md` (plus its risk-class
   block) or `docs-author.md`

Fill every `{{...}}` from its table. An unfilled placeholder means the brief is not ready; a value
that does not exist is written as the word "none", not left empty. The finished brief is at most
3072 bytes (`wc -c`); a longer value goes into a file and the brief carries its path.
