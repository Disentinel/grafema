# REG-505: Datalog "did you mean" suggestions on empty results

## Source
Linear issue REG-505

## Request
When a Datalog query like `node(X, "FUNCTON")` returns 0 results because the type doesn't exist in the graph, the response should include suggestions for similar types using Levenshtein distance.

## Acceptance Criteria
1. When `node(X, "TYPE")` returns 0 results and the type doesn't exist — response includes `suggestions: ["FUNCTION"]` (Levenshtein distance ≤ 2)
2. When `edge(X, Y, "CALS")` — same for edge types
3. Suggestions only when 0 results (not on every query)
4. Works through both MCP and CLI

## Implementation Notes
- Logic can be at JS level (MCP handler / CLI), not necessarily Rust
- Use `countNodesByType()` / `countEdgesByType()` for available types
- `levenshtein()` already exists in `@grafema/core`
