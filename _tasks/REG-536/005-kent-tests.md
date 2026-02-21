# Kent Beck Test Report: REG-536

## Test File

`/Users/vadimr/grafema-worker-4/test/unit/plugins/analysis/ast/switch-case-connectivity.test.ts`

## Discovery

The REG-536 implementation **already exists** on this branch. The `BranchHandler.ts` already has:
1. `ctx.getCurrentScopeId()` instead of `ctx.parentScopeId` (line 34)
2. A `SwitchCase` enter/exit visitor that creates case-body SCOPE nodes (lines 349-410)
3. `switchCaseScopeMap` integration in `FunctionBodyContext.ts` and `JSASTAnalyzer.ts`

This means the tests I wrote verify the correctness of the existing implementation rather than failing before it. The tests serve as a regression guard.

## Tests Written (10 total, 3 groups)

### Group 1: Case body SCOPE creation (3 tests)

| Test | Description | Status |
|------|-------------|--------|
| `should have SCOPE nodes for each non-empty case body` | Verifies that SCOPE nodes with `scopeType` containing "case" are created for each non-empty case clause (A, B, default) | PASS |
| `should NOT have SCOPE nodes for empty fall-through cases` | Verifies that empty fall-through cases (e.g., `case 'A':` with no body) do NOT get SCOPE nodes | PASS |
| `should handle default case` | Verifies that the `default:` case also gets a case-body SCOPE | PASS |

### Group 2: Connectivity -- zero disconnected nodes (5 tests)

Uses a BFS reachability algorithm identical to `GraphConnectivityValidator`, with infrastructure node exclusion (grafema:plugin, GRAPH_META, net:* singletons).

| Test | Description | Status |
|------|-------------|--------|
| `should have zero disconnected nodes in function with switch statement` | Simple switch with 3 cases, all nodes reachable | PASS |
| `should have zero disconnected nodes when switch is nested inside for loop` | Switch inside for-of loop -- tests `getCurrentScopeId()` fix | PASS |
| `should have zero disconnected nodes with nested switch statements` | Inner switch inside outer case body -- tests recursive correctness | PASS |
| `should have zero disconnected nodes with variable declarations inside case bodies` | Block-scoped `const` declarations inside case bodies with `{}` blocks | PASS |
| `should have zero disconnected nodes with call sites inside case bodies` | Call expressions, method calls, and arrow function callbacks inside case bodies | PASS |

### Group 3: Correct CONTAINS chain (2 tests)

| Test | Description | Status |
|------|-------------|--------|
| `should link nodes inside case body to case-body SCOPE via CONTAINS` | Verifies that case-body SCOPE nodes have CONTAINS edges to their child nodes | PASS |
| `should use correct parent scope when switch is nested inside a loop` | Verifies the BRANCH node for a switch inside a for-of loop has `parentScopeId` pointing to the loop body SCOPE (not the function body SCOPE) -- this is the core `getCurrentScopeId()` fix | PASS |

## Test Infrastructure Notes

- Tests use `createTestDatabase()` + `createTestOrchestrator()` pattern (matching existing sibling tests)
- Infrastructure nodes (`grafema:plugin`, `GRAPH_META`, `net:*`) are excluded from connectivity checks since they are always present and disconnected from the content graph
- BFS traversal is bidirectional (incoming + outgoing edges), matching `GraphConnectivityValidator`'s algorithm

## Run Command

```bash
node --import tsx --test test/unit/plugins/analysis/ast/switch-case-connectivity.test.ts
```

## Result

```
# tests 10
# suites 4
# pass 10
# fail 0
# duration_ms ~10s
```

All 10 tests pass because the REG-536 implementation already exists on this branch.
