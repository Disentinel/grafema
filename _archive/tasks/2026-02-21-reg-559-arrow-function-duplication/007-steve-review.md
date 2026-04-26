## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

### Vision Alignment

Duplicate FUNCTION nodes directly corrupt the graph. When AI queries for functions passed as callbacks, it gets phantom nodes — either missing edges (edges pointing to the duplicate that got dropped) or doubled results. Fixing this is not optional: a graph with duplicated nodes is not a queryable source of truth. It is noise. This fix is necessary for the graph to be a reliable foundation for AI queries.

### Is the guard `getFunctionParent()` the right fix or a workaround?

It is the right fix. The architectural intent was always clear: FunctionVisitor handles module-level constructs; NestedFunctionHandler handles function-body constructs. The bug was a missing boundary check — ArrowFunctionExpression lacked the guard that FunctionDeclaration already had. This is not plugging a symptom; it is closing the gap between intent and implementation.

The pattern is consistent across the codebase:
- `ASTWorker.ts` line 338: `if (path.getFunctionParent()) return;` for VariableDeclaration
- `ASTWorker.ts` line 384: same guard for FunctionDeclaration
- `ASTWorker.ts` line 429: same guard for ClassDeclaration
- `ASTWorker.ts` line 486: same guard for CallExpression

ArrowFunctionExpression should have had this from day one. Rob corrected the omission.

### Is there an architectural gap — should there be a central "create-or-get" node factory?

There is a valid architectural concern here, and I want to name it clearly: the current design relies on each visitor correctly deciding whether to emit a node. There is no deduplication at the storage layer. If another visitor forgets a guard, we get another REG-559.

However, a "create-or-get" factory is NOT the right answer for this codebase at this stage. Here is why:

1. The graph database is append-oriented. Idempotent node creation would require a lookup before every insert — that is a performance regression on every analysis run.
2. The real fix is to make the architectural boundary explicit and tested. REG-559 does this: the test suite now locks the invariant "one FUNCTION node per arrow function." Future regressions will be caught.
3. REG-562 (class field arrows still duplicate) is correctly filed as a separate tracked issue. It was not silently papered over.

The pattern `getFunctionParent()` as a boundary guard is the correct architectural primitive for this two-layer traversal design. What is missing is not a factory — it is documentation of the invariant. That is a documentation gap, not a code gap, and it does not block this ship.

### Complexity Checklist

1. Does the fix iterate over all nodes? No. 3 lines, early return on a path property check. O(1).
2. Does it use existing abstractions? Yes. Identical to guards already used in FunctionDeclaration, ClassDeclaration, VariableDeclaration, CallExpression handlers.

### Would shipping this embarrass us?

No. The fix is clean, minimal, consistent with existing patterns, tested with 5 targeted cases, and ships with a correctly documented known limitation (REG-562). The snapshot update is expected and legitimate — the anonymous function counter no longer double-counts.

The one thing I want noted for the record: REG-562 must not be forgotten. Class field arrows still produce two FUNCTION nodes. That is a real graph integrity issue. It should be on the roadmap, not left indefinitely as "documented pre-existing behavior."
