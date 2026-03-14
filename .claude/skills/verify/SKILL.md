---
name: verify
description: |
  Verify task completion by demonstrating real value: run the new code on real
  data, show visible results, find gaps between plan and reality. Not about
  tests/builds — about proving the feature WORKS end-to-end.
author: Claude Code
version: 2.0.0
date: 2026-03-12
user_invocable: true
trigger: >
  User says "/verify", "verify", "проверь результат", "покажи что получилось".
---

# /verify — Demonstrate Value, Find Gaps

## Philosophy

"It builds" proves nothing. "Tests pass" proves nothing. The only proof that a feature works is **running it on real data and showing visible results**.

This skill is the adversarial self-audit: take what was planned, run it for real, and report what actually works vs. what was quietly skipped, stubbed, or broken.

## Steps

### 1. Extract the Plan

Determine what was supposed to be delivered. Sources (in order):
- Active plan in conversation context
- Linear issue (extract from branch name, fetch with `mcp__linear__get_issue`)
- Task list (`TaskList`)
- `_tasks/REG-XXX/plan.md` if exists

Extract the **concrete deliverables** — not "add C++ support" but the specific capabilities the plan promised (e.g., "parser emits 75 JSON node types", "analyzer produces 30 node types", "resolver creates 12 edge types").

### 2. Choose a Demo Target

Pick a **real project** to run the new feature against. Priority:

1. **Grafema itself** — if the feature applies to its own codebase
2. **Well-known open-source repo** — clone a small, representative project from GitHub
3. **Synthetic fixture** — create a minimal but realistic file that exercises the feature

**For language support tasks**: create or find a file that covers the language's key constructs. Not a toy hello-world — something that exercises classes, functions, imports, templates/generics, error handling, etc.

**For analysis/enrichment tasks**: use an existing analyzed project and run the new capability against its graph.

### 3. Execute End-to-End

Run the full pipeline on the demo target. For each component in the plan, actually invoke it and capture output:

**Parser** (if applicable):
- Run the parser on a real source file
- Show the JSON AST output (or a representative sample)
- Verify: does the output cover the constructs present in the file?
- Count: how many of the planned node types actually appear?

**Analyzer** (if applicable):
- Feed the parser output to the analyzer
- Show the FileAnalysis output (nodes, edges, deferred refs)
- Count: how many of the planned node types / edge types are actually emitted?
- Verify: do semantic IDs look correct?

**Resolver** (if applicable):
- Feed the analysis output to the resolver
- Show the resolved edges
- Verify: do cross-file references actually resolve?

**MCP tools / CLI** (if applicable):
- Run the MCP query or CLI command
- Show the actual output
- Compare against what the user would expect

### 4. Planned vs. Actual Matrix

Build a concrete comparison table. This is the heart of /verify.

```
## Planned vs. Actual

| Planned Capability              | Status      | Evidence |
|--------------------------------------|-------------|----------|
| Parser: FunctionDecl nodes           | WORKS     | Seen in output for demo.cpp:10 |
| Parser: TemplateTypeParam nodes      | NOT TESTED  | No template in demo file |
| Parser: MacroExpansion nodes         | MISSING     | Macro present in file but not in output |
| Analyzer: CALL nodes from CallExpr   | WORKS     | 5 CALL nodes emitted |
| Analyzer: LAMBDA nodes               | STUBBED     | Handler exists but emits empty node |
| Resolver: EXTENDS edges              | WORKS     | MyDerived -> MyBase resolved |
| Resolver: virtual dispatch           | NOT TESTED  | Need polymorphic call site in fixture |
```

Status legend:
- **WORKS** — demonstrated on real data, output is correct
- **NOT TESTED** — demo target doesn't exercise this; need a better fixture
- **MISSING** — should be there but isn't; gap found
- **STUBBED** — code exists but produces empty/dummy output
- **WRONG** — produces output but it's incorrect
- **DEFERRED** — explicitly out of scope per plan (with justification)

### 5. Gap Drill-Down

For every MISSING, STUBBED, or WRONG item:

1. **Locate the code** that should handle this case
2. **Diagnose**: is it a missing handler? Wrong pattern match? Silent fallthrough?
3. **Classify**:
   - **Quick fix** (< 20 lines, obvious what to do) — fix it now
   - **Needs investigation** (root cause unclear) — describe the symptom
   - **Design gap** (feature not designed for this case) — note as limitation
4. **Record** in the report with specific file:line references

### 6. Produce the Report

```markdown
## Verification Report: [Task ID / Title]

### Demo Target
[What was tested: file name, project, or fixture description]

### Value Demonstrated
[2-3 bullet points of what ACTUALLY works end-to-end, with real output snippets]

### Planned vs. Actual
[The matrix from Step 4]

### Gaps Found
[For each MISSING/STUBBED/WRONG item:]
- **[item]**: [diagnosis] — [file:line] — [quick fix | needs investigation | design gap]

### Deferred (per plan)
- [item]: [reason]

### Verdict: [DELIVERS VALUE | PARTIAL VALUE | NO VALUE YET]

### Recommended Next Steps
[Prioritized list of what to do next to close gaps]
```

### 7. Fix Quick Wins (Optional)

If there are quick fixes (< 20 lines each) and fewer than 5 of them — fix them now and re-run the demo to update the report. Don't ask for permission on trivial fixes that close real gaps.

For larger fixes — leave them as "Recommended Next Steps" in the report.

---

## Choosing Good Demo Targets

### For language support (parser/analyzer/resolver)

Create a single file that covers the breadth of the language. Checklist:
- [ ] Function/method declarations (various signatures)
- [ ] Class/struct/type definitions
- [ ] Inheritance / interfaces / traits
- [ ] Imports / includes / modules
- [ ] Generics / templates
- [ ] Lambdas / closures
- [ ] Error handling (try/catch/throw)
- [ ] Control flow (if/for/while/switch)
- [ ] Variable declarations (various storage classes)
- [ ] Calls (free function, method, static, constructor)

### For analysis features

Use the Grafema codebase itself via MCP tools — it's always available and already analyzed.

### For enrichment / resolver features

Run `grafema analyze` on a small open-source project, then query the graph for the new edge types / enrichments.

---

## Anti-Patterns

- **Declaring victory from line counts** — "6741 lines created" means nothing if the lines don't produce correct output
- **Demo on trivial input** — "hello world" parsing proves nothing; use realistic code
- **Skipping the matrix** — the planned-vs-actual table is mandatory, not optional
- **"It should work because it follows the pattern"** — run it and see
- **Hiding NOT TESTED behind "out of scope"** — if the plan said it, it's in scope; if you can't test it, say NOT TESTED, not DEFERRED
- **Fixing gaps silently** — if you find and fix gaps, report them as "gap found and fixed", not as if they never existed
