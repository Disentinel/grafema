# REG-507: Datalog count() aggregation predicate

**Source:** Linear REG-507
**Date:** 2026-02-19
**Config:** Mini-MLA

## Problem

No way to get result count — only the full list. For questions like "how many unresolved calls?" you have to get the whole array and count `.length`.

## Acceptance Criteria

1. `count(N) :- node(X, "CALL"), \+ edge(X, _, "CALLS").` returns `{N: "42"}`
2. Or alternative syntax: `query_graph` tool accepts `count: true` parameter and returns a number
3. Tests cover count with and without filters

## Implementation Notes (from task)

* Option A: built-in predicate `count(Var, N)` — harder but cleaner
* Option B: `limit: 0` + response includes `totalCount` — simpler
* Option C: `count: true` at MCP/CLI level — simplest
