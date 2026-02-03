# Don Melton - Plan for REG-326: Backend Value Tracing

## Executive Summary

REG-326 asks: "Given an http:route, can we trace the response value back to its data source (e.g., database query)?"

After analyzing the codebase, I recommend **Option 1: Extend `grafema trace`** - following ASSIGNED_FROM chain from the RESPONDS_WITH target node. This approach reuses existing infrastructure and aligns with Grafema's "graph-first" vision.

## Current State Analysis

### Existing Infrastructure

1. **RESPONDS_WITH edge** (ExpressResponseAnalyzer)
   - http:route -> RESPONDS_WITH -> response node (OBJECT_LITERAL, VARIABLE, CALL, etc.)
   - Response node is created at the location of `res.json({ data })` argument
   - Located at `/packages/core/src/plugins/analysis/ExpressResponseAnalyzer.ts`

2. **traceValues utility** (REG-244)
   - Core value tracing engine at `/packages/core/src/queries/traceValues.ts`
   - Follows ASSIGNED_FROM and DERIVES_FROM edges backward
   - Already handles: LITERAL, PARAMETER, CALL, OBJECT_LITERAL, EXPRESSION
   - Detects nondeterministic patterns (req.body, process.env, etc.)
   - Returns TracedValue[] with source locations

3. **CLI trace command**
   - Already has `--to` option for sink-based tracing (REG-230)
   - Uses traceValues internally
   - Located at `/packages/cli/src/commands/trace.ts`

4. **Database query tracking**
   - SQLiteAnalyzer creates `db:query` nodes
   - FUNCTION -> EXECUTES_QUERY -> db:query edges
   - Query nodes have: method, query, operationType, tableName

5. **Cross-service tracing**
   - HTTP_RECEIVES edges connect frontend CALL to backend RESPONDS_WITH target
   - traceValues already follows HTTP_RECEIVES for cross-service data flow

### Gap Analysis

The missing piece is connecting RESPONDS_WITH target to its data sources:

```
Current:
  http:route ──RESPONDS_WITH──> OBJECT_LITERAL (at res.json location)

Missing chain (example):
  OBJECT_LITERAL ──HAS_PROPERTY "invitations"──> VARIABLE formatted
  formatted ──ASSIGNED_FROM──> CALL invitations.map(...)
  map result ──DERIVES_FROM──> VARIABLE invitations
  invitations ──ASSIGNED_FROM──> CALL db.all(...)
  db.all ──[need link]──> db:query node with SQL
```

Key gaps:
1. Response OBJECT_LITERAL nodes created by ExpressResponseAnalyzer don't have HAS_PROPERTY edges to their properties
2. No edge from CALL (like `db.all()`) to the db:query node
3. Need to trace through object properties, not just direct assignment chains

## Recommended Approach: Extend Existing Trace

### Why Option 1 (Extend `grafema trace`)

| Criterion | Option 1: Extend trace | Option 2: New --to-sink | Option 3: Edge metadata |
|-----------|------------------------|-------------------------|-------------------------|
| Reuses existing | Yes (traceValues) | Yes (traceValues) | No (new enricher) |
| Query time | Yes | Yes | No (enrichment time) |
| Flexible | Yes | Yes | Limited to pre-computed |
| Implementation | Simple | Medium | Complex |
| Graph-first vision | Yes | Yes | Yes |

Option 1 is simplest because:
- `traceValues` already does most of the work
- We just need a way to start from http:route and get to RESPONDS_WITH target
- Then standard backward tracing follows ASSIGNED_FROM/DERIVES_FROM

### Prior Art (Web Search)

From [taint analysis research](https://can-ozkan.medium.com/what-is-taint-analysis-a-guide-for-developers-and-security-researchers-11f2ad876ea3), the standard approach involves:
- **Sources**: Origins of data (db queries, user input)
- **Sinks**: Where data ends up (API responses, file writes)
- **Backward tracing**: Start from sink, trace to sources

[Semgrep](https://semgrep.dev/docs/writing-rules/data-flow/taint-mode/overview) and [Pysa](https://pyre-check.org/docs/pysa-basics/) both use this model.

Our implementation aligns with this: http:route + RESPONDS_WITH is the sink, we trace backward to find sources.

## Implementation Plan

### Phase 1: CLI Command Extension (Primary)

Add new trace mode: `grafema trace --from-route <route-id>`

```bash
# Example usage
grafema trace --from-route "http:route#GET /api/invitations"
```

**Steps:**
1. Find http:route node by ID or pattern
2. Follow RESPONDS_WITH edge to get response data node
3. Call existing traceValues() on that node
4. Display results with source info (file, line, db:query if found)

### Phase 2: MCP Tool (Secondary)

Add `trace_route_response` MCP tool for agents:

```json
{
  "route": "GET /api/invitations",
  "depth": 10
}
```

Returns:
```json
{
  "route": "http:route#...",
  "responseNode": "OBJECT_LITERAL#...",
  "sources": [
    {
      "value": "...",
      "source": {"file": "...", "line": 42},
      "type": "db:query",
      "query": "SELECT * FROM invitations WHERE ..."
    }
  ]
}
```

### Phase 3: Gap Filling (If Needed)

If initial implementation reveals gaps:

1. **Object property tracing**: Ensure HAS_PROPERTY edges from response OBJECT_LITERAL to property values are created or followed

2. **db.all() -> db:query link**: Add DERIVES_FROM or RETURNS edge from db method CALL to db:query node. This would allow traceValues to reach the actual SQL.

## Complexity Analysis

| Phase | Effort | Risk | Value |
|-------|--------|------|-------|
| Phase 1 (CLI) | 2-3 days | Low | High |
| Phase 2 (MCP) | 1-2 days | Low | Medium |
| Phase 3 (Gaps) | TBD | Medium | High |

Total estimate: 3-5 days for core functionality.

## Open Questions

1. **Should we trace ALL routes or specific ones?**
   - Recommendation: Start with single route, add `--all-routes` later

2. **How to handle multiple RESPONDS_WITH edges per route?**
   - Example: Different branches with different res.json() calls
   - Recommendation: Trace all, aggregate results

3. **db:query connection**: Currently EXECUTES_QUERY goes FUNCTION -> db:query. How do we connect the CALL result to the query?
   - Option A: Add RETURNS edge from db:query to CALL result
   - Option B: Trace through CONTAINS to find db:query in same function
   - Recommendation: Option B is simpler for MVP

4. **Response object structure**: When response is `{ invitations: formatted }`, do we have edges from OBJECT_LITERAL to property values?
   - Need to verify ExpressResponseAnalyzer behavior
   - May need enhancement in Phase 3

## Dependencies

- **REG-324** (responseDataNode fix): Required for reliable frontend<->backend linking, but not strictly needed for backend-only tracing
- This task is backend-focused, REG-324 is for cross-service

## Risks

1. **Missing edges**: If ASSIGNED_FROM chains are incomplete, trace won't reach db:query
   - Mitigation: Phase 3 gap filling

2. **Object property tracing**: May need to enhance how we handle `res.json({ key: value })`
   - Mitigation: Test with real examples, iterate

3. **Performance**: Unbounded backward traversal
   - Mitigation: Use existing maxDepth in traceValues

## Success Criteria

1. Given http:route, can trace to LITERAL values
2. Given http:route, can trace to PARAMETER (user input)
3. Given http:route, can trace to db:query (SQL query)
4. CLI command works: `grafema trace --from-route <id>`
5. Works for common patterns: direct object, variable reference, function call

## Recommendation

Proceed with Phase 1 (CLI extension) as MVP. This validates the approach with minimal investment. If successful, add MCP tool in Phase 2 and address any edge gaps in Phase 3.

The key insight is that **traceValues already does 80% of the work**. We just need to:
1. Start from the right node (RESPONDS_WITH target)
2. Ensure ASSIGNED_FROM chains connect to db:query results

---

*Analysis by Don Melton, Tech Lead*
*Sources consulted: [Taint Analysis Guide](https://can-ozkan.medium.com/what-is-taint-analysis-a-guide-for-developers-and-security-researchers-11f2ad876ea3), [Semgrep Taint Mode](https://semgrep.dev/docs/writing-rules/data-flow/taint-mode/overview), [Pysa Basics](https://pyre-check.org/docs/pysa-basics/)*
