# Linus Torvalds - Plan Review

## Verdict: NEEDS REVISION

## What's Good

1. **Problem is real and important.** Array mutation tracking is a genuine gap in Grafema's data flow model. Without it, the graph can't answer basic questions about real codebases. Don correctly identifies this as critical for the project's core value proposition.

2. **Edge type decision is correct.** Using `FLOWS_INTO` instead of reusing `HAS_ELEMENT` is the right call. These are semantically different:
   - `HAS_ELEMENT` = static structural containment at array literal creation
   - `FLOWS_INTO` = runtime data flow from mutations

   Conflating them would be a semantic mess.

3. **Architecture follows existing patterns.** The plan correctly identifies where changes go (CallExpressionVisitor for method calls, JSASTAnalyzer for indexed assignment, GraphBuilder for edge creation). The collection-based visitor pattern is well established.

4. **Edge direction is correct.** `source FLOWS_INTO array` matches how other data flow edges work (`var ASSIGNED_FROM source`, etc.).

5. **Scope is appropriately limited.** Not tracking `splice` return values or deep property chains is the right decision for MVP. Do the simple thing first.

## Concerns

1. **The plan duplicates type definitions.** Joel's plan defines `ArrayMutationInfo` and `ArrayMutationArgument` in BOTH `types.ts` AND locally in `CallExpressionVisitor.ts`. Pick one. Either use the shared types from `types.ts` everywhere, or define locally. Duplication is a bug waiting to happen.

2. **Variable resolution is glossed over.** Both Don and Joel note that resolving `arr` in `arr.push(x)` to its VARIABLE node is tricky, but the plan just says "defer to GraphBuilder where variable declarations are available." The actual implementation in Step 6.4 does `variableDeclarations.find(v => v.name === arrayName && v.file === file)`.

   **This is wrong for nested scopes.** If you have:
   ```javascript
   function foo() {
     const arr = [];
     arr.push(obj);
   }
   ```
   The variable lookup needs to consider scope, not just file-level matching. The plan acknowledges this risk but doesn't solve it. For MVP this is probably acceptable, but it should be explicitly documented as a known limitation.

3. **NodeCreationValidator update is incomplete.** The plan says to add `FLOWS_INTO` to `isFromNodeFactory` and `traceVariableSource`, but looking at the actual code:

   - `isFromNodeFactory` traces INCOMING edges (`edgesByDst.get(nodeId)`) filtering for `ASSIGNED_FROM`
   - `traceVariableSource` traces OUTGOING edges (`edgesBySrc.get(nodeId)`) filtering for `ASSIGNED_FROM`

   `FLOWS_INTO` edges go `source -> array`, so to trace what's in an array, you need to find INCOMING `FLOWS_INTO` edges to the array. The plan's code snippets in Step 7 show filtering `edgesBySrc` and `edgesByDst` but the changes shown are not quite right. This needs to be thought through more carefully.

4. **Test structure is vague.** Joel's test cases are pseudocode with `// ...` placeholders. The tests need to be fully specified before implementation. What assertions exactly? What graph structure do we expect? Kent Beck should not have to guess.

## Blocking Issues

1. **Fix the type duplication.** Define `ArrayMutationInfo` in ONE place. The plan currently has it in both `types.ts` (Step 3) and `CallExpressionVisitor.ts` (Step 4.1). Remove one.

2. **Clarify NodeCreationValidator traversal.** The current code traces data flow to find object origins. With `FLOWS_INTO`, we need to be able to trace:

   ```
   addNodes(arr) <- where does arr's content come from?
   arr <- FLOWS_INTO <- obj  (obj was pushed into arr)
   ```

   So `traceVariableSource` needs to also follow INCOMING `FLOWS_INTO` edges to the variable (not outgoing). The plan's Step 7 code snippets are muddled. Write the actual logic:

   ```typescript
   // In addition to ASSIGNED_FROM, check if anything flows INTO this node (arrays)
   const incomingFlows = edgesByDst.get(nodeId)?.filter(e =>
     e.type === 'FLOWS_INTO'
   ) || [];
   ```

   And then trace those sources.

3. **Write real tests first.** The test file in Step 1 is a skeleton. Before any code is written, we need actual test implementations that will compile and fail. No `// ... setup and assert` placeholders.

## Recommendations

1. **Consider indexed assignment inside CallExpressionVisitor.** The plan splits array mutation detection between CallExpressionVisitor (for push/unshift/splice) and JSASTAnalyzer (for indexed assignment). This is additional complexity. Consider whether indexed assignment handling should also go in a dedicated visitor to keep things cohesive.

2. **Add debug logging.** When array mutation detection runs, log what mutations were found. This will help debugging during development and dogfooding.

3. **Document the scope limitation.** Add a comment in GraphBuilder explaining that variable resolution is file-scoped, not scope-aware, and that this may cause incorrect edges for shadowed variables.

4. **Consider future extensibility.** The `FLOWS_INTO` edge type could eventually be used for more than arrays (Sets, Maps, custom collections). The current design supports this, but might be worth noting.

---

The plan is 80% there. Fix the three blocking issues - type duplication, NodeCreationValidator traversal logic, and test completeness - and it's ready for implementation.
