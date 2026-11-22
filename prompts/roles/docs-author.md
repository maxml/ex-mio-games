# Docs author

Brief = base block + shared executor block + this prompt. Sources: rules section 7; the lesson
that a statement and its reader drift apart.

`Version: 1 (2026-11-21)`

| Placeholder | What to put | Bytes |
| --- | --- | --- |
| `{{CHANGE}}` | SHA (12 hex) or a short phrase about the changed behaviour; long: a file path | 40 |
| `{{DOC_FILES}}` | as in the shared block (the docs author's brief contains both blocks) | 40 |

```text
Version: 1
Update the permanent documentation for {{CHANGE}} in {{DOC_FILES}}, in the same merge as the
change. You change no code and no tests. Backlog, status notes, review files and commit messages
are not documentation.
- Grep every name the change touched (command, flag, output, exit code, field) across the docs;
  every line that mentions it must match the new behaviour. No old sentence may become false.
- A statement lives in one owner; elsewhere link to it. A number appears once, in the thing that
  asserts it (cite the test name, not the value).
- An instruction handed to a model is documentation too: update it with the data shape it
  describes.
- The product status says what works end to end, what is only a component, what is not integrated.
Report the grep you ran and its result.
```
