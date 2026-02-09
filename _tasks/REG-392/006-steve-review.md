# Steve Jobs Review #2: REG-392

## Decision: APPROVE (with one noted inconsistency)

## What Changed

Four files modified, two test files updated:

1. **CallExpressionVisitor.ts** (`detectArrayMutation`) -- Fixed type classification order to check `ObjectExpression`/`ArrayExpression` BEFORE `extractLiteralValue`. Added `valueLine`/`valueColumn` storage for coordinate-based node lookup.

2. **JSASTAnalyzer.ts** (`detectIndexedArrayAssignment`) -- Added `collections` parameter. Creates LITERAL, OBJECT_LITERAL, and ARRAY_LITERAL nodes inline and sets `valueNodeId` on the mutation argument.

3. **GraphBuilder.ts** (`bufferArrayMutationEdges`) -- Expanded to handle all non-VARIABLE types. Uses `valueNodeId` (direct) when available, falls back to coordinate-based lookup in collections for push/unshift. Refactored edge creation into a single `if (sourceNodeId)` block, eliminating duplication.

4. **types.ts** -- Added `valueLine`/`valueColumn` fields to `ArrayMutationArgument`.

5. **Tests** -- Unskipped `IndexedArrayAssignmentRefactoring.test.js` (10/12 pass, 2 pre-existing failures for computed indices). Added 5 new tests in `ArrayMutationTracking.test.js` for push/unshift with non-variable values.

## Vision Alignment: YES

"AI should query the graph, not read code."

Before this change, `arr.push('hello')` and `arr[0] = 'hello'` left no trace in the graph -- an agent querying "what flows into this array?" would get nothing for non-variable values. Now the graph captures these data flows. This is a direct improvement: the graph becomes a more complete representation of the code's data flow.

## Architecture Assessment

### Correct: Expanded scope to ALL mutation types

My previous review (004) correctly identified that fixing only indexed assignments while leaving push/unshift broken would create architectural divergence. The team responded correctly -- this implementation fixes ALL array mutation types uniformly.

### Correct: Bug fix in detectArrayMutation

The reordering of type classification in `detectArrayMutation` (line 920) is a genuine bug fix, not a preference. On main, the order was:
```
1. extractLiteralValue  (catches objects/arrays with all-literal values)
2. Identifier
3. ObjectExpression
4. ArrayExpression
5. CallExpression
```

But `extractArguments` (which creates the actual nodes) checks:
```
1. ObjectExpression  (creates OBJECT_LITERAL node)
2. ArrayExpression   (creates ARRAY_LITERAL node)
3. extractLiteralValue (creates LITERAL node)
```

For `arr.push({name: 'test'})`, the old order would classify it as LITERAL (extractLiteralValue returns `{name: 'test'}`), but `extractArguments` creates an OBJECT_LITERAL node. The GraphBuilder would then search `literals` for a LITERAL node that doesn't exist, because the actual node is in `objectLiterals`. The reordering fixes this mismatch.

### Correct: Dual-path resolution strategy

For indexed assignments: nodes are created inline in `detectIndexedArrayAssignment`, `valueNodeId` is set directly. No lookup needed.

For push/unshift: nodes are created by `extractArguments` (which runs separately), so `valueNodeId` can't be set during detection. Instead, `valueLine`/`valueColumn` are stored for coordinate-based lookup in `bufferArrayMutationEdges`.

This is pragmatic and correct -- each path creates edges using the information available to it.

### Correct: No new graph iterations

All node creation happens during existing AST traversal passes. The `.find()` calls in `bufferArrayMutationEdges` search per-file collections (not the entire graph), and this pattern is already established throughout GraphBuilder (lines 638, 719, 1467, 1600).

## Complexity Check: PASS

- Node creation: O(1) per mutation value
- Edge creation: O(1) per mutation when `valueNodeId` is set (indexed), O(c) per mutation for coordinate lookup where c = collection size (push/unshift)
- No new passes over the AST or graph
- Extends existing visitor pass, doesn't add new ones

## Test Quality Assessment

**IndexedArrayAssignmentRefactoring.test.js (unskipped):**
- Tests cover module-level, function-level, mixed contexts, multiple assignments, and metadata verification
- Tests for literal, object literal, array literal, and function call values
- 2 failing tests (computed indices `arr[index] = value` and `arr[i+1] = value`) are correctly identified as pre-existing and out of scope -- these fail because `detectIndexedArrayAssignment` only handles `NumericLiteral` keys
- Tests verify both edge existence AND metadata (mutationMethod, argIndex)

**ArrayMutationTracking.test.js (5 new tests):**
- Tests cover `arr.push(literal)`, `arr.push({obj})`, `arr.push([array])`, `arr.push(func())`, `arr.unshift(literal)`
- Each test verifies FLOWS_INTO edge exists with correct mutationMethod
- Tests are integration-level (full pipeline), which is appropriate for this feature

Tests communicate intent clearly and match the acceptance criteria.

## Noted Inconsistency (NOT blocking)

There is an ordering inconsistency between `detectArrayMutation` (push/unshift) and `detectIndexedArrayAssignment` (indexed):

- **Push/unshift (after fix):** Checks `ObjectExpression` BEFORE `extractLiteralValue` -- so `arr.push({name: 'test'})` creates an OBJECT_LITERAL node.
- **Indexed (unchanged):** Checks `extractLiteralValue` BEFORE `ObjectExpression` -- so `arr[0] = {name: 'test'}` creates a LITERAL node with an object as its value.

This means the same value `{name: 'test'}` gets a different node type depending on mutation method. The edges are created correctly either way, but graph queries might need to handle both representations.

**Why this is NOT blocking:**
1. The indexed assignment order was pre-existing and NOT introduced by this PR
2. The push/unshift order HAD to be fixed (it was a bug causing node lookup failures)
3. Changing the indexed assignment order now would require careful analysis of whether `extractLiteralValue` results are expected downstream for LITERAL nodes
4. This should be a follow-up issue (tech debt), not a blocker

**Recommendation:** Create a Linear issue to unify type classification order across `detectArrayMutation` and `detectIndexedArrayAssignment`. Target: check `ObjectExpression`/`ArrayExpression` first in both paths.

## Verdict

**APPROVE.** The implementation:

1. Aligns with project vision -- the graph now tracks non-variable data flows into arrays
2. Fixes ALL array mutation types uniformly (not just indexed)
3. Fixes a real bug in `detectArrayMutation` type classification order
4. Uses correct architecture (forward registration, no backward scanning)
5. Adds no new graph iterations
6. Has comprehensive, well-structured tests
7. Code is clean, well-commented, and follows existing patterns

The noted inconsistency in type classification order between the two detection methods is pre-existing tech debt, not introduced by this PR, and should be tracked separately.

Escalate to Vadim for final confirmation.
