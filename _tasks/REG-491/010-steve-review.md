## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

---

### Vision Alignment

The fix is directly on-mission. The entire point of Grafema is that "AI should query the graph, not read code." A CONSTRUCTOR_CALL node with no CONTAINS edge is a graph island — invisible to graph traversal. 65% of constructor calls were unreachable by any graph query. That is not a minor gap, that is a fundamental connectivity failure. This fix closes it.

### Complexity Check

**O(constructor_calls)** — exactly right.

- In-function calls: `parentScopeId` is captured during the existing `NewExpression` traversal in `NewExpressionHandler` via `ctx.getCurrentScopeId()`. No extra iteration.
- Module-level calls: one `traverse(ast, { NewExpression })` pass in `JSASTAnalyzer.ts`, guarded by `getFunctionParent()` check to skip already-handled in-function calls. O(n) over NewExpression nodes only, not over all nodes.
- Edge creation in `GraphBuilder.ts` step 4.5: O(constructor_calls), one `if (constructorCall.parentScopeId)` guard per call.

No scanning of all graph nodes. No backward pattern scanning. The iteration space is exactly the set of constructor calls, which is a small, well-bounded subset.

### Plugin Architecture

The pattern is **consistent** with every other node type in the codebase:

| Node type | Where CONTAINS edge is created |
|-----------|-------------------------------|
| FUNCTION | CoreBuilder.ts — `if (parentScopeId)` guard |
| SCOPE | CoreBuilder.ts — `if (parentScopeId)` guard |
| CALL_SITE | CoreBuilder.ts — always (no guard, assumes parentScopeId set) |
| METHOD_CALL | CoreBuilder.ts — always (no guard) |
| LOOP | ControlFlowBuilder.ts — `if (loop.parentScopeId)` guard |
| BRANCH | ControlFlowBuilder.ts — `if (branch.parentScopeId)` guard |
| TRY_BLOCK | ControlFlowBuilder.ts — `if (tryBlock.parentScopeId)` guard |
| UPDATE_EXPRESSION | UpdateExpressionBuilder.ts — `if (parentScopeId)` guard |
| CONSTRUCTOR_CALL | GraphBuilder.ts step 4.5 — `if (constructorCall.parentScopeId)` guard ✓ |

The new code follows the exact same guard pattern. No architectural deviation.

### The Two Sources Are Correctly Handled

**In-function calls** (`NewExpressionHandler.ts`): `parentScopeId: ctx.getCurrentScopeId()` — scope tracker returns the innermost scope at the call site. Correct.

**Module-level calls** (`JSASTAnalyzer.ts` traverse_new block): `parentScopeId: module.id` — module node is the correct parent for top-level expressions. This is consistent with how module-level callbacks, if-scopes, and other top-level constructs are handled (lines 1669, 1767, 1834 in JSASTAnalyzer.ts all use `module.id`).

**The `getFunctionParent()` guard** prevents double-counting. In-function calls are already handled by `NewExpressionHandler` during `analyzeFunctionBody`. The module-level traversal correctly skips them. No duplication risk.

### No Concerns

The implementation does not introduce workarounds, does not scan the full node set, does not add a new abstraction where none is needed, and does not change any public API. It is the minimal, correct fix for a genuine graph connectivity gap.
