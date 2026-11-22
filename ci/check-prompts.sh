#!/usr/bin/env bash
# Structural checks of prompts/roles/*.md and .claude/agents/*.md. No word lists, no project-specific values.
#  1. every role file has a "Version:" line, and the block's N equals the header's N
#  2. placeholders used in its text blocks equal those in its table, and each has a byte ceiling
#  3. each assembled brief, filled with ceiling-sized values, is at most 3072 bytes
#  4. every role (except base and executor-shared) has a tracked agent wrapper: name = file stem,
#     a description, an exact tool list for that role, and a pointer to an existing role prompt
set -u
cd "$(dirname "$0")/.." || exit 1
for f in prompts/roles/*.md; do
  grep -q '^Version:' "$f" || { echo "no Version: in $f"; exit 1; }
done
python3 -I - prompts/roles .claude/agents <<'PY'
import os, re, subprocess, sys
d = sys.argv[1] + "/"
W = sys.argv[2] + "/"
F = "`" * 3
SHARED = ("base", "executor-shared")
bad = []
names = sorted(f[:-3] for f in os.listdir(d) if f.endswith(".md"))
def load(name):
    t = open(d + name + ".md", encoding="utf-8").read()
    blocks = re.findall(F + r"text\n(.*?)" + F, t, re.S)
    ceil = {k: int(v) for k, v in re.findall(r"(?m)^\| `\{\{(\w+)\}\}` \|.*\| (\d+) \|$", t)}
    return blocks, ceil, t
data = {}
for n in names:
    blocks, ceil, t = load(n)
    used = set(re.findall(r"\{\{(\w+)\}\}", "".join(blocks)))
    table = set(re.findall(r"(?m)^\| `\{\{(\w+)\}\}` \|", t))
    if used != table:
        bad.append(n + ": placeholders differ from the table: " + ", ".join(sorted(used ^ table)))
    bad += [n + ": no byte ceiling for " + k for k in sorted(used - set(ceil))]
    head = re.findall(r"`Version: (\d+) \(", t)
    inner = re.findall(r"(?m)^Version: (\d+)\s*$", "".join(blocks))
    if len(head) != 1 or len(inner) != 1 or head != inner:
        bad.append(n + ": block Version " + str(inner) + " differs from header " + str(head))
    data[n] = (blocks, ceil)
def fill(n):
    blocks, ceil = data[n]
    return "".join(re.sub(r"\{\{(\w+)\}\}", lambda m: "x" * ceil.get(m.group(1), 0), b) for b in blocks)
brief = {
    "spec-author": ["base", "executor-shared", "spec-author"],
    "test-author": ["base", "executor-shared", "test-author"],
    "coder": ["base", "executor-shared", "coder"],
    "docs-author": ["base", "executor-shared", "docs-author"],
    "reviewer": ["base", "reviewer"],
    "re-reviewer": ["base", "reviewer", "re-reviewer"],
    "coordinator": ["base", "coordinator"],
}
roles = [n for n in names if n not in SHARED]
for n in roles:
    if n not in brief:
        bad.append(n + ": role file has no brief composition in check-prompts.sh")
for k, parts in brief.items():
    if k not in data:
        bad.append(k + ": brief composition names a role file that does not exist")
        continue
    size = len("".join(fill(p) for p in parts).encode())
    print("%5d bytes  %s" % (size, k))
    if size > 3072:
        bad.append(k + ": filled brief is " + str(size) + " bytes, limit 3072")

# Wrappers. Exact tool set per role: a wrapper without a tools line inherits every tool.
RW = {"Read", "Grep", "Glob", "Write", "Edit"}
TOOLS = {
    "spec-author": RW,
    "docs-author": RW,
    "test-author": RW | {"Bash"},
    "coder": RW | {"Bash"},
    "reviewer": RW | {"Bash"},
    "re-reviewer": RW | {"Bash"},
    "coordinator": RW | {"Bash", "Agent", "TaskStop"},
}
try:
    tracked = set(subprocess.run(["git", "ls-files", W], capture_output=True, text=True,
                                 check=True).stdout.split())
except Exception:
    tracked = None
files = set(os.listdir(W)) if os.path.isdir(W) else set()
for extra in sorted(files - {r + ".md" for r in roles}):
    bad.append(W + extra + ": wrapper without a role file")
for r in roles:
    p = W + r + ".md"
    if r not in TOOLS:
        bad.append(r + ": no tool allowlist for this role in check-prompts.sh")
        continue
    if not os.path.isfile(p):
        bad.append(r + ": no wrapper " + p)
        continue
    if tracked is not None and p not in tracked:
        bad.append(p + ": not tracked by git (ignored?)")
    t = open(p, encoding="utf-8").read()
    m = re.match(r"---\n(.*?)\n---\n(.*)", t, re.S)
    if not m:
        bad.append(p + ": no frontmatter")
        continue
    fm = dict(re.findall(r"(?m)^(\w+):[ \t]*(.*)$", m.group(1)))
    body = m.group(2)
    if fm.get("name") != r:
        bad.append(p + ": name is not " + r)
    if not fm.get("description", "").strip():
        bad.append(p + ": empty description")
    if "tools" not in fm:
        bad.append(p + ": no tools line (inherits every tool)")
    else:
        got = {x.strip() for x in fm["tools"].split(",") if x.strip()}
        if got != TOOLS[r]:
            bad.append(p + ": tools differ from the role: extra " + str(sorted(got - TOOLS[r]))
                       + " missing " + str(sorted(TOOLS[r] - got)))
    refs = re.findall(r"prompts/roles/([\w-]+)\.md", body)
    if r not in refs:
        bad.append(p + ": body does not point to prompts/roles/" + r + ".md")
    bad += [p + ": points to missing prompts/roles/" + x + ".md" for x in sorted(set(refs)) if x not in names]
    for k in sorted(set(fm) - {"name", "description", "tools", "model"}):
        bad.append(p + ": frontmatter key not allowed: " + k)
    want = "opus" if r in ("reviewer", "re-reviewer") else None
    if fm.get("model") != want:
        bad.append(p + ": model is " + str(fm.get("model")) + ", must be " + str(want))
    if r == "coordinator":
        # No sentence may grant writing code, tests, specs or docs. A sentence that names those
        # artifacts and carries a grant word, with no negation, is red.
        for s in re.split(r"(?<=[.;:,])\s+", " ".join(body.split())):
            if (re.search(r"\b(code|tests?|specs?|documentation|docs)\b", s, re.I)
                    and re.search(r"\b(may|can|could|allowed|permitted|free to|also|when it is quicker|you (write|edit|fix|implement|author))\b", s, re.I)
                    and not re.search(r"\b(no|not|never|cannot|without|nothing)\b", s, re.I)):
                bad.append(p + ": sentence may grant code/test/spec writing: " + s)
if "coder" in data:
    cd = " ".join(data["coder"][0][0].split())
    bad += ["coder block lost a rule: " + p for p in ("{{FROZEN_TESTS}}", "for a risky class the reviewer's",
            "Never edit, delete or skip", "blocker you report to the coordinator") if p not in cd]
    if cd.count("reviewer's") != cd.count("for a risky class the reviewer's"):
        bad.append("coder block: the reviewer's tests are named outside the risky-class condition")
print("\n".join(bad) or "prompts ok")
sys.exit(1 if bad else 0)
PY
