---
name: gap-loop
description: |
  Cyclical dogfooding loop: test AI-AGENT-STORIES.md against the live graph,
  discover new stories, analyze gaps, fix root causes, re-test, write report.
  Use when: (1) user says "/gap-loop", (2) periodic dogfooding session,
  (3) after a release or major feature to re-validate stories,
  (4) before sprint planning to prioritize product gaps.
author: Claude Code
version: 1.0.0
date: 2026-03-11
user_invocable: true
trigger: >
  User says "/gap-loop", "dogfooding session", "test stories",
  "check gaps", "проверь stories", "закрой дырки".
---

# /gap-loop -- Grafema Dogfooding Gap Loop

## What This Is

A closed feedback loop: AI uses Grafema MCP tools -> discovers gaps -> fixes root causes -> re-tests -> AI can do more.

Every iteration closes the distance between "query the graph" and "read the code". The goal: make reading code unnecessary for understanding code.

## Usage

```
/gap-loop                    # Full cycle: test -> analyze -> fix -> re-test -> report
/gap-loop --test-only        # Only re-test stories, no fixes (quick health check)
/gap-loop --fix US-10        # Fix a specific story's root cause
/gap-loop --new              # Focus on discovering NEW stories from fresh exploration
```

## Prerequisites

- RFDB server running (`grafema server start` or auto-started via MCP)
- Graph loaded (`get_stats` returns nodeCount > 0). If not, run `analyze_project` first
- MCP tools available (loaded via ToolSearch)

## Cycle Overview

```
    [1. LOAD]
        |
        v
    [2. TEST] <----.
        |          |
        v          |
    [3. DISCOVER]  |
        |          |
        v          |
    [4. ANALYZE]   |
        |          |
        v          |
    [5. FIX]-------'
        |
        v
    [6. REPORT]
```

Each step is detailed below. Steps 2-5 form the inner loop -- repeat until no BROKEN stories remain or all remaining gaps require architectural changes beyond this session's scope.

---

## Step 1: LOAD -- Read Current State

### 1.1 Load MCP tools

MCP tools are deferred. Load them before any graph queries:

```
ToolSearch("+grafema get_stats find_nodes get_file_overview find_calls")
ToolSearch("+grafema trace_dataflow query_graph get_context query_knowledge")
ToolSearch("+grafema check_guarantees list_guarantees get_schema get_knowledge_stats")
```

### 1.2 Check graph health

```
get_stats -> confirm nodeCount > 0
```

If nodeCount is 0:
- Run `analyze_project` and wait for completion
- Re-check with `get_stats`
- If still 0: STOP, report infrastructure failure

### 1.3 Read existing stories

```
Read AI-AGENT-STORIES.md
```

Parse all stories: ID, title, status (WORKING/PARTIAL/BROKEN), last tested date.
Build a checklist of stories to re-test.

If the file doesn't exist: skip to Step 3 (DISCOVER) -- this is a fresh start.

---

## Step 2: TEST -- Re-test Every Story

**CRITICAL: Actually run the queries. Do not mark stories as WORKING without testing.**

For each story in AI-AGENT-STORIES.md:

### Test Protocol

1. Read the story's acceptance criteria
2. Run the MCP tool(s) specified in the story
3. Compare actual results against acceptance criteria
4. Update status:
   - **WORKING**: all criteria met, results correct
   - **PARTIAL**: some criteria met, some gaps remain
   - **BROKEN**: tool fails, returns empty, or produces wrong results

### Test Execution Principles

- **Parallelize**: independent stories can be tested simultaneously (use parallel MCP calls)
- **Use real data**: pick function/class/file names that exist in the current graph, not hypothetical ones
- **Test cross-language**: if a story claims multi-language support, test JS/TS AND Haskell AND Rust
- **Record exact queries**: save the MCP call and response summary for each test
- **Compare with previous**: if a story was BROKEN and is now WORKING, note what changed

### Regression Detection

If a previously WORKING story is now BROKEN or PARTIAL:
- Flag as **REGRESSION** in test results
- Priority: regressions are fixed FIRST in Step 5

### DSL Validation Tests

Test the `describe` tool (MCP) and `grafema describe` (CLI) notation rendering:

1. **Cross-type rendering**: Run `describe` on at least one FUNCTION, CLASS, and MODULE node from the graph. Verify each returns valid DSL notation with appropriate operators (`o-`, `>`, `<`, etc.).

2. **LOD progression**: Pick one node with edges. Run `describe` at depth=0, depth=1, depth=2. Verify:
   - depth=0: names only, no operators
   - depth=1: operators appear with target names
   - depth=2: nested children expanded with their own edges

3. **Perspective presets**: Test all 5 perspectives (security, data, errors, api, events) on one node with diverse edge types. Verify each perspective filters to its archetype set only.

4. **Budget enforcement**: Run `describe` with `budget=3` on a node with many edges. Verify output includes `+N more` summarization.

5. **Multi-language coverage**: If the graph contains nodes from multiple languages (JS/TS, Haskell, Rust, Python), run `describe` on one node per language. If only JS/TS exists, note multi-language gaps but do NOT treat as test failure.

6. **Empty case**: Find a leaf node with no edges. Run `describe` on it. Expect "No relationships found" message.

---

## Step 3: DISCOVER -- Find New Stories

### 3.1 Engineer Questions (Unfamiliar Codebase)

Pretend you're seeing this codebase for the first time. Ask and test:

- "What languages does this project use?" -> `get_schema`, `get_stats` node type breakdown
- "What are the main entry points?" -> `find_nodes(type="MODULE")`, `discover_services`
- "What does class X do?" -> `find_nodes(type="CLASS", name="X")`, `get_context`
- "How do these two modules connect?" -> `traverse_graph` with IMPORTS_FROM
- "Are there any security concerns?" -> `check_invariant` with eval/exec rules

### 3.2 Expert Engineer Questions (Familiar Codebase)

Ask questions a maintainer would ask:

- "What changed recently?" -> `git_churn`, `git_archaeology`
- "What's the blast radius of changing file X?" -> `git_cochange`, `traverse_graph`
- "What are the architectural rules?" -> `list_guarantees`, `query_decisions`
- "Are there known issues?" -> `query_knowledge(text="bug")`, `query_knowledge(text="limitation")`
- "What's the test coverage situation?" -> `get_coverage`

### 3.3 Non-Engineer Questions

Ask questions a PM or stakeholder would ask:

- "How big is this project?" -> `get_stats` node/edge counts
- "Is it healthy?" -> `check_guarantees`, `get_knowledge_stats` dangling refs
- "Who owns what?" -> `git_ownership`
- "What's the documentation status?" -> `get_knowledge_stats`, `query_decisions`

### 3.4 Stress Tests

Push the tools to their limits:

- Query with very common names (e.g., `find_nodes(name="get")`) -> pagination?
- Large Datalog queries with joins -> performance?
- `trace_dataflow` with max_depth=20 -> does it handle deep chains?
- `get_file_overview` on the largest file -> complete results?

### 3.5 DSL Coverage Tests

Dedicated stress tests for DSL notation coverage and correctness:

- **Cross-language comparison**: If multiple languages exist in the graph, `describe` similar constructs (e.g., a function with calls) in JS vs Python vs Rust. Compare operator usage and completeness.
- **Edge coverage audit**: Use `get_schema` to list all edge types in the graph. For each edge type, verify it maps to an archetype in the notation (check `EDGE_ARCHETYPE_MAP`). Any unmapped edge type is a gap.
- **Large file stress test**: Find the file with the most nodes (`find_nodes` sorted by file). Run `describe` on it at depth=2. Verify output is complete and doesn't truncate silently.
- **Deeply nested test**: Find a CLASS with methods. Run `describe` at depth=2. Verify methods appear as nested children with their own edges.
- **Empty graph test**: Run `describe` on a leaf node with no edges. Expect the "No relationships found" fallback message.

**Story templates to create if gaps are found:**
- US-XX: DSL Describes Functions Across Languages
- US-XX: DSL Edge Coverage (all edge types map to archetypes)
- US-XX: DSL Budget Enforcement (large edge sets are summarized)

### 3.6 Record New Stories

For each question that reveals a capability gap or a working capability not yet documented:
- Create a new US-XX story following the format in AI-AGENT-STORIES.md
- Test it immediately (don't just write it -- verify)
- Set initial status based on test results

---

## Step 4: ANALYZE -- Root Cause Analysis

For every BROKEN or PARTIAL story, determine the root cause. Do NOT skip to fixing.

### Classification

| Category | Description | Fix Location |
|----------|-------------|-------------|
| **MCP layer** | Tool doesn't expose underlying capability | `packages/mcp/src/` |
| **Query layer** | RFDB query doesn't return expected data | `packages/util/src/queries/` or rfdb-server |
| **Analysis pipeline** | Data not produced during analysis | `packages/grafema-orchestrator/` or enrichers |
| **Resolver** | Cross-file/cross-language edges not created | `packages/grafema-resolve/` |
| **Documentation** | Tool works but misleading description | MCP tool descriptions |
| **Design gap** | Feature doesn't exist yet | Needs Linear ticket |

### Root Cause Protocol

For each BROKEN/PARTIAL story:

1. **Reproduce** with a minimal query
2. **Trace the data path**:
   - Does the data exist in RFDB? -> `query_graph` or `check_invariant`
   - If YES: MCP layer or query layer bug
   - If NO: analysis pipeline or resolver issue
3. **Check the code** (yes, read source here -- this is implementation, not exploration):
   - Use `get_file_overview` + `get_context` to find the relevant code
   - Read the specific function that should produce the missing data
4. **Document the root cause** -- one sentence, specific: "GuaranteeManager.loadFromFile() is never called during MCP server init"
5. **Estimate scope**: single function fix? multiple files? architectural change?

### Scope Decision

- **Quick fix** (single function, < 20 lines): fix in Step 5
- **Multi-file fix** (2-3 files, tests needed): fix in Step 5 via coding subagent
- **Architectural change** (new subsystem, redesign): create Linear ticket, defer to sprint

---

## Step 5: FIX -- Root Cause Fixes

**CRITICAL: Fix the root cause, not the symptom. No patches, no workarounds.**

### Fix Protocol

For each fixable gap (quick fix or multi-file fix):

1. **Write the test FIRST** that demonstrates the gap:
   - The test should FAIL before the fix
   - The test should PASS after the fix
   - Place in appropriate test directory

2. **Implement the fix** via coding subagent:
   - Each subagent gets ONE atomic change (max 2-3 files)
   - Subagent receives: root cause, test file, files to modify
   - Subagent must: implement fix, verify test passes, lint clean

3. **Re-test the story** immediately after the fix:
   - Run the same MCP query from Step 2
   - Verify the story status improves (BROKEN -> PARTIAL or WORKING)

4. **Check for siblings**:
   - Does the same pattern exist elsewhere?
   - Will this fix help other BROKEN stories?
   - If yes: fix siblings too in the same pass

### Build & Test After Fixes

```bash
pnpm build                                              # Rebuild all packages
node --test --test-concurrency=1 'test/unit/*.test.js'  # Run all tests
```

**REMEMBER: Tests run against dist/, not src/.** Always rebuild.

### Inner Loop

After fixing a gap:
- Go back to Step 2 (TEST) for the fixed story
- If it's now WORKING: move to next BROKEN story
- If still PARTIAL: refine the fix
- When all fixable gaps are addressed: proceed to Step 6

---

## Step 6: REPORT -- Update Everything

### 6.1 Update AI-AGENT-STORIES.md

Rewrite the entire file with:
- Updated statuses for all re-tested stories
- New stories discovered in Step 3
- Updated test results with today's date
- Updated summary table
- Updated "Critical Product Gaps" section

### 6.2 Update _ai/gaps.md

For any NEW gaps discovered:
```markdown
## YYYY-MM-DD: Short description
- **Query attempted**: what MCP call was made
- **Expected**: what should have been returned
- **Actual**: what happened
- **Workaround**: how you worked around it
- **Severity**: critical / important / minor
- **Linear issue**: REG-XXX (if created)
```

### 6.3 Session Report

Output a summary:

```
## Gap Loop Report -- YYYY-MM-DD

### Stories
- Total: N
- Working: N (was N last run)
- Partial: N (was N last run)
- Broken: N (was N last run)
- New stories added: N
- Regressions detected: N

### Fixes Applied
- [US-XX] root cause -> fix description
- [US-YY] root cause -> fix description

### Deferred (needs architecture)
- [US-ZZ] root cause -> Linear ticket REG-XXX

### Score Trend
YYYY-MM-DD: X/Y WORKING (Z%)
YYYY-MM-DD: X/Y WORKING (Z%)  <- today
```

### 6.4 Create Linear tickets

For gaps that need architectural changes (deferred in Step 5):
- Team: Reginaflow
- Labels: `Improvement`, `v0.2`
- Include: root cause analysis, affected stories, acceptance criteria from stories

---

## Anti-Patterns

### DO NOT

- Mark stories as WORKING without running the actual query
- Patch symptoms instead of fixing root causes
- Create "improvement" tickets without root cause analysis
- Skip the test-first protocol in Step 5
- Read source files during exploration (Step 2-3) -- use graph queries
- Fix gaps that require architectural changes in this loop -- defer them
- Write more than 3 new stories per session without testing all existing ones first

### DO

- Run every test query against the live graph
- Fix the simplest BROKEN stories first (quick wins improve the score)
- Look for sibling bugs when fixing a root cause
- Rebuild (`pnpm build`) before re-testing after code changes
- Record exact MCP calls and results for reproducibility
- Update the dogfooding guide (_ai/dogfooding.md) if known limitations change
