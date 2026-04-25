# Don Melton - Technical Analysis & Plan

## Executive Summary

REG-113 addresses a critical gap in Grafema's data flow analysis: array mutations are not tracked. This means `arr.push(obj)` creates no edge between `obj` and `arr`, breaking transitive analysis and validators like NodeCreationValidator.

After thorough analysis of the codebase, I conclude that the proposed solution is architecturally sound and aligns well with existing patterns. However, there are some implementation nuances that need careful attention.

## Codebase Analysis

### Current Architecture

1. **Edge Types** (`packages/types/src/edges.ts`)
   - No `FLOWS_INTO` edge type exists currently
   - Existing data flow edges: `ASSIGNED_FROM`, `READS_FROM`, `WRITES_TO`, `DERIVES_FROM`, `HAS_ELEMENT`
   - `HAS_ELEMENT` is used for array literal initialization: `[a, b, c]` creates edges from ARRAY_LITERAL to elements

2. **CallExpressionVisitor** (`packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`)
   - Already handles method calls on objects: `obj.method()`
   - Already detects `.on()` event handlers specially
   - Already collects `methodCalls` with `object` and `method` properties
   - Has patterns we can follow for detecting `.push()`, `.unshift()`, `.splice()`

3. **GraphBuilder** (`packages/core/src/plugins/analysis/ast/GraphBuilder.ts`)
   - Already creates `HAS_ELEMENT` edges for array literals
   - Already has `bufferMethodCalls()` method
   - We need to add edge creation logic for array mutations

4. **JSASTAnalyzer** (`packages/core/src/plugins/analysis/JSASTAnalyzer.ts`)
   - Handles `AssignmentExpression` for variable assignments
   - Does NOT currently handle `arr[i] = x` indexed assignment pattern
   - We need to add detection for indexed array assignment

5. **Types** (`packages/core/src/plugins/analysis/ast/types.ts`)
   - `MethodCallInfo` has `object` and `method` fields - sufficient for detecting push/unshift
   - May need new type for array mutation info, or extend existing

### Key Insight: Two Different Mutation Patterns

1. **Method calls**: `arr.push(obj)`, `arr.unshift(obj)`, `arr.splice(i, 0, obj)`
   - Detected by CallExpressionVisitor as method calls
   - Arguments flow INTO the array

2. **Indexed assignment**: `arr[i] = obj`
   - This is an `AssignmentExpression` with `MemberExpression` on left side
   - NOT currently detected at all
   - Needs new AST visitor logic

### Existing Patterns to Follow

The codebase has good patterns for data flow:
- `variableAssignments` array collects assignment info during AST traversal
- GraphBuilder creates edges from that info
- `HAS_ELEMENT` edge with `metadata.elementIndex` for array elements

## Architecture Assessment

### Does the Proposed Solution Fit?

**YES** - the solution aligns with existing architecture:

1. **New edge type `FLOWS_INTO`** - Makes semantic sense, different from `HAS_ELEMENT` because:
   - `HAS_ELEMENT` = structural containment at initialization time
   - `FLOWS_INTO` = runtime data flow from mutation

2. **Detection in CallExpressionVisitor** - Correct place for method-based mutations

3. **New handling for indexed assignment** - Needs to be added to JSASTAnalyzer's AssignmentExpression handling

### Architectural Concerns

1. **Edge type semantics**: The issue suggests `FLOWS_INTO` OR reusing `HAS_ELEMENT`. I recommend `FLOWS_INTO` because:
   - `HAS_ELEMENT` implies structural containment (what the array literally contains)
   - `FLOWS_INTO` implies data flow (what values enter the array over time)
   - These are semantically different and mixing them would cause confusion

2. **Array variable resolution**: When we see `arr.push(obj)`, we need to resolve `arr` to its VARIABLE node. This requires variable lookup in scope, which CallExpressionVisitor doesn't currently do. May need to defer edge creation to GraphBuilder where variable declarations are available.

3. **Spread elements**: `arr.push(...items)` - the spread creates multiple flows. Need to handle.

4. **Method chains**: `arr.push(obj).push(obj2)` - push returns length, so this is not valid JS, but `arr.push(obj); arr.push(obj2)` is common.

## High-Level Plan

### Phase 1: Add FLOWS_INTO Edge Type
1. Add `FLOWS_INTO` to `EDGE_TYPE` in `packages/types/src/edges.ts`
2. Document its semantics (data flow from mutations)

### Phase 2: Detect Array Mutation Method Calls
1. In `CallExpressionVisitor`, detect `.push()`, `.unshift()`, `.splice()` calls
2. Collect mutation info: `{ arrayObjectName, argumentNodes, file, line }`
3. Add new collection: `arrayMutations` to collections

### Phase 3: Detect Indexed Assignment
1. In `JSASTAnalyzer`, add `AssignmentExpression` handler for `arr[i] = x` pattern
2. Detect when left side is `MemberExpression` with computed property
3. Collect to same `arrayMutations` collection

### Phase 4: Create Edges in GraphBuilder
1. Add `bufferArrayMutationEdges()` method
2. Resolve array variable name to VARIABLE node ID
3. Resolve argument to appropriate node (VARIABLE, LITERAL, OBJECT_LITERAL, etc.)
4. Create `FLOWS_INTO` edge: argument -> array

### Phase 5: Update NodeCreationValidator
1. Add `FLOWS_INTO` to the edge types it traverses
2. When tracing object origins, follow FLOWS_INTO edges into arrays

### Phase 6: Tests
1. Test `arr.push(obj)` creates edge
2. Test `arr[i] = obj` creates edge
3. Test transitive query: what reaches `func(arr)`
4. Test NodeCreationValidator can trace through arrays

## Key Decisions Required

1. **Edge direction**: Should `FLOWS_INTO` be `argument -> array` or `array -> argument`?
   - Recommend: `argument FLOWS_INTO array` (source to destination)
   - Matches data flow direction: the argument's value flows into the array

2. **Spread handling**: `arr.push(...items)` - should this create edge from `items` to `arr`?
   - Recommend: Yes, with `metadata.isSpread: true`

3. **Multi-argument push**: `arr.push(a, b, c)` - how many edges?
   - Recommend: Three edges, one per argument, with `metadata.argIndex`

4. **Return value of splice**: `const removed = arr.splice(1, 1, newItem)` - track removed elements?
   - Recommend: Out of scope for this issue. Focus on inflow, not outflow.

5. **Nested mutations**: `obj.arr.push(item)` - how deep to track?
   - Recommend: Track immediate receiver object name. Deep property chains are complex and can be phase 2.

## Risks

1. **Variable resolution complexity**: Finding the VARIABLE node for `arr` in `arr.push(x)` requires scope awareness. Current method call handling doesn't resolve to node IDs.
   - Mitigation: In GraphBuilder, do variable lookup by name+file like existing `bufferArgumentEdges()` does.

2. **Performance**: Every method call will now be checked for array mutations.
   - Mitigation: Simple string comparison is fast. Only `.push`, `.unshift`, `.splice` on object receivers.

3. **False positives**: Custom objects might have `.push()` methods that aren't array mutations.
   - Mitigation: Accept this limitation. Type information would be needed to be precise. For now, assume any `.push()` on an identifier is an array mutation.

4. **Breaking existing tests**: New edges might affect existing test assertions.
   - Mitigation: Run tests early and often during implementation.

5. **Complexity creep**: Temptation to handle every edge case.
   - Mitigation: Stick to the acceptance criteria. `arr.push(obj)` and `arr[i] = obj` only.

## Alignment with Project Vision

This feature is CRITICAL for Grafema's core value proposition:
- "AI should query the graph, not read code"
- Without array mutation tracking, the graph gives incomplete answers
- Real codebases heavily use `arr.push()` patterns
- NodeCreationValidator (dogfooding!) needs this to work

This is not a nice-to-have. This is fixing a fundamental gap in Grafema's data flow model.

## Recommended Implementation Order

1. Tests first (Kent Beck style) - write failing tests for:
   - `arr.push(obj)` creates FLOWS_INTO edge
   - `arr[i] = obj` creates FLOWS_INTO edge

2. Add edge type to types package

3. Add detection in CallExpressionVisitor (push/unshift/splice)

4. Add detection in JSASTAnalyzer (indexed assignment)

5. Add edge creation in GraphBuilder

6. Update NodeCreationValidator to traverse FLOWS_INTO

7. Run full test suite, fix any regressions
