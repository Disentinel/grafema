# Workflow Reference

**Workflow version: v3.0** (2026-03-01)

Changelog:
- **v3.0** — Simplified workflow. Removed MLA pipeline with named personas for planning/implementation. Top-level Claude plans iteratively in plan mode, unnamed coding agents implement atomic changes, Dijkstra verifies edge cases, 3-Review checks quality.
- **v2.2** (archived in `_ai/archive/mla-workflow-v2.2.md`) — Previous MLA-based workflow.

**CRITICAL: NO CODING AT TOP LEVEL!**

All implementation happens through coding subagents. Top-level agent only plans and coordinates.

## Pipeline

```
1. Plan Mode (mandatory, exhaustive)
   → Top-level Claude explores code, builds plan
   → Plan must be exhaustive on first presentation (see Exhaustive Planning below)
   → User approves or gives feedback

2. Dijkstra Verification (for non-trivial tasks)
   → Edge case verification of approved plan (Opus subagent)
   → REJECT → back to plan mode with specific gaps

3. Implementation (NO CODING AT TOP LEVEL)
   → Top-level splits plan into minimal atomic changes
   → Each change → separate coding subagent (Opus, no persona)
   → One subagent = one atomic change (tests + code)
   → Top-level coordinates, does not write code

4. 3-Review (Steve ∥ Вадим auto ∥ Uncle Bob, all Opus)
   → ANY REJECT → fix + re-run ALL 3
   → ALL approve → present to user

5. Вадим (human) → final confirmation

6. Knowledge Extraction (mandatory for non-trivial tasks)
   → Run /extract-knowledge skill
   → SESSION + DECISIONs + FACTs + edges
   → Invalidation check on affected code refs
```

## Plan Mode Protocol — Exhaustive Planning

Plan mode is **mandatory** for all non-trivial tasks. Trivial tasks (typo, single-line fix) may skip.

**The plan presented to the user must already be exhaustive.** No back-and-forth "anything missing?" iterations — think deeply during exploration, search the graph thoroughly, and present a complete plan that already accounts for everything below. When the user sees the plan, the answer to "anything missing? siblings? out of scope?" should already be "I thought about it, here's what I found and decided."

### What "exhaustive" means concretely

**Completeness — search, don't assume:**
- Search the graph for ALL callers/usages of functions/types being changed — not just the ones in the task description
- Check error handling paths (null, undefined, empty, wrong type)
- Check async/timing paths (races, ordering, cleanup on failure)
- If touching a public API — check all consumers, not just the obvious ones
- Use `find_nodes`, `find_calls`, `query_graph`, `trace_dataflow` — real search, not "I think there are no other callers"

**Siblings — same pattern, same fix, same plan:**
- If fixing a bug in one visitor/handler/resolver — search for the same anti-pattern in ALL siblings (every visitor, every handler, every resolver)
- If fixing a type/interface — find ALL implementations
- If fixing a resolution path — find ALL resolution paths with shared logic
- **Include siblings in the plan.** One task that fixes everything > N tasks with N planning overheads

**Scope bias — include by default:**
- Default is INCLUDE, not exclude
- Exclude only if: genuinely different root cause, fundamentally different approach needed, or risk of destabilizing unrelated subsystem
- "Different file" is NOT a reason to exclude
- Any exclusion must be listed explicitly with reasoning

**Coverage — specific, not vague:**
- For each change — name the specific test scenarios (not "we'll add tests")
- Search for existing tests that will break
- If task involves resolution — trace the FULL chain (nested, re-exported, aliased cases)
- Graph invariants must actually catch the bug — would a regression pass them?

### Plan content

1. Problem analysis and approach (with alternatives considered and why rejected)
2. Files to modify and nature of changes
3. Edge cases found — with proposed handling for each
4. Sibling occurrences found — included or excluded with reasoning
5. Intentional exclusions — what's related but out of scope, and why
6. Grafema invariants → live guarantees (see "Invariants → Live Guarantees" section)
7. Test strategy — specific scenarios, not placeholders; note which tests are replaced by guarantees
8. Design decisions made autonomously — and which ones need user input

### Decision authority

Claude makes decisions autonomously in favor of:
- **More complete resolving** over partial
- **Broader coverage** over narrow
- **Larger cohesive scope** over fragmented tasks
- **Real graph search results** over assumptions

Only escalate to user via AskUserQuestion when:
- Genuine architectural trade-off with no clear winner
- Scope expansion would more than double the implementation effort
- Multiple valid approaches with meaningfully different trade-offs

## Invariants → Live Guarantees

**Plan invariants are NOT documentation. They become live Datalog guarantees that catch regressions automatically.**

### Pipeline

1. **Plan** formulates invariant in human terms (e.g., "every CALL with a resolved target must have a CALLS edge")
2. **Implementation** includes `create_guarantee` with the Datalog rule:
   ```
   violation(X) :- node(X, "CALL"), attr(X, "resolvedName", _), not edge(X, _, "CALLS").
   ```
3. **Guarantee exported** to `.grafema/guarantees.yaml`, committed with the code
4. **`grafema check`** validates on every run — `process.exit(1)` on violation
5. **Regressions caught automatically** — Datalog query over the entire graph, not one fixture

### What guarantees replace

Guarantees replace **graph-structural unit tests** — tests asserting "node X has edge Y" on a specific fixture. The guarantee checks the same invariant across ALL analyzed code.

**Still need unit tests for:**
- Logic/behavior (functions return correct values, error handling)
- Edge cases in implementation (null inputs, empty arrays, async)
- Integration tests (pipeline end-to-end with real files)

**Replace with guarantees:**
- "Nodes of type X always have property Y" → `violation(X) :- node(X, "TYPE"), not attr(X, "prop", _).`
- "Every A→B edge has valid target" → `violation(X) :- edge(X, Y, "A_TO_B"), not node(Y, _).`
- "No orphan nodes of type X" → `violation(X) :- node(X, "TYPE"), not edge(_, X, _), not edge(X, _, _).`

### In the plan — each invariant MUST include

1. Human description of what it guarantees
2. The Datalog rule (or sketch if exact syntax depends on implementation)
3. Severity: `error` (blocks CI) / `warning` / `info`
4. What unit test(s) it replaces or makes redundant (if any)

## Implementation Protocol

- Maximally small atomic changes
- One subagent touches no more than 2-3 files
- Each subagent receives: specific files, specific change, existing patterns to follow
- No personas — just "coding agent"
- Each coding agent writes tests + code for its atomic change
- Top-level verifies each change builds and tests pass before proceeding

## Model Assignment

| Role | Model | Rationale |
|------|-------|-----------|
| Coding agents | **Opus** | Writing production code requires top reasoning |
| Dijkstra (plan verification) | **Opus** | APPROVE/REJECT decisions require top reasoning |
| Steve (vision review) | **Opus** | APPROVE/REJECT decisions require top reasoning |
| Вадим auto (completeness review) | **Opus** | APPROVE/REJECT decisions require top reasoning |
| Uncle Bob (code quality review) | **Opus** | APPROVE/REJECT decisions require top reasoning |
| Research (exploring phase) | **Sonnet** | Information gathering, search, summarization |
| Research (reasoning phase) | **Opus** | Analysis, conclusions, recommendations |
| Report formatting | **Haiku** | Template-based markdown |

## 3-Review Protocol

Three independent reviewers run as **1 batch of 3 parallel subagents:**

- **Steve Jobs** (Vision) — Does this align with project vision? Architecture checklist. Would shipping this embarrass us?
- **Вадим auto** (Completeness) — Does the code do what the task requires? Edge cases, regressions, scope creep. Tests meaningful?
- **Uncle Bob** (Code Quality) — Structure, naming, duplication, readability. File/method size limits.

**Flow:**
1. Run all 3 in parallel
2. ANY reviewer REJECT → back to implementation, fix issues, re-run ALL 3 reviews
3. ALL 3 approve → present combined summary to user
4. **Вадим (human)** confirms or rejects with feedback
5. Loop until all 3 reviewers AND user ALL agree task is FULLY DONE

## Task Directory Convention

Tasks organized under `_tasks/` directory:
```
_tasks/
├── 2026-03-01-feature-name/
│   ├── 001-user-request.md
│   ├── 002-plan.md
│   ├── 003-dijkstra-verification.md
│   ├── 004-steve-review.md
│   ├── 005-vadim-review.md
│   ├── 006-uncle-bob-review.md
│   └── 007-metrics.md
```

## Task Metrics (REQUIRED for every task)

**Top-level agent MUST collect usage data from every subagent call** and write metrics report after completion.

Each `Task` tool call returns `total_tokens`, `tool_uses`, `duration_ms` in its output. Collect these.

**Blended cost rates** (input+output average):
| Model | $/M tokens |
|-------|------------|
| Haiku | $1.76 |
| Sonnet | $6.60 |
| Opus | $33.00 |

**Template** (`0XX-metrics.md`):
```markdown
## Task Metrics: REG-XXX

**Workflow:** v3.0
**Date:** YYYY-MM-DD
**Wall clock:** [start time] → [end time] = [duration]

### Subagents

| # | Agent | Model | Tokens | Tools | Duration | Est. Cost |
|---|-------|-------|--------|-------|----------|-----------|
| 1 | Dijkstra (verification) | Opus | 35,000 | 8 | 15s | $1.16 |
| 2 | Coding agent 1 | Opus | 50,000 | 12 | 30s | $1.65 |
| ... | ... | ... | ... | ... | ... | ... |

### Totals

| Metric | Value |
|--------|-------|
| Subagents total | N |
| By model | Haiku: N, Sonnet: N, Opus: N |
| Total tokens (subagents) | N |
| Est. subagent cost | $X.XX |
| Top-level overhead | ~20-30% (not tracked) |
| **Est. total cost** | **$X.XX** |
| 3-Review cycles | N (how many REJECT→retry across all 3 reviewers) |

### Grafema Dogfooding

**Planning phase (top-level, has MCP access):**

| Metric | Value |
|--------|-------|
| Graph queries used | N |
| File reads that could have been graph queries | N |
| Graph queries that failed (fallback to file read) | N |
| Product gaps found | N |

**Coding agents (no MCP access):**

| Metric | Value |
|--------|-------|
| File reads by coding agents | N |
| Of those, replaceable by graph query | N |

**Gaps found:**
- [what you tried or could have tried] → [why it failed / wasn't available] → [suggested fix]

**Verdict:** [graph-first / mixed / file-first] + [why]

### Notes
- [workflow observations, bottlenecks, what worked/didn't]
```

**Rules:**
- Metrics are NON-OPTIONAL. Every task gets a metrics report.
- If a subagent doesn't return usage data, note "N/A" and estimate.
- Wall clock = time from user request to user approval (not including PR/CI).
- 3-Review cycles count: 1 = all 3 passed first time, 2+ = had rejections.

## Execution Guards

**Any command: max 10 minutes.** No exceptions.

If command takes longer than 10 minutes:
1. Kill immediately
2. This is a design problem, not a waiting problem
3. Refactor to async with progress reporting
4. Split into subtasks with separate progress reports

**Tests:**
- Run atomically — only tests relevant to current change
- `node --test test/unit/specific-file.test.js` > `npm test`
- Single test file: max 30 seconds. Hanging = bug.
- Full suite — only before final commit

**When anything hangs:**
1. Kill, don't wait
2. Analyze: infinite loop? Waiting for input? Sync blocking?
3. Fix root cause — don't retry blindly, don't increase timeout

## When Stuck

1. Re-examine the plan — is the approach correct?
2. Do NOT keep trying random fixes
3. If architectural issue discovered → record it → discuss with user → possibly switch tasks
