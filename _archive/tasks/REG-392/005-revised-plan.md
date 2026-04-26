# Revised Plan: REG-392 (Expanded Scope)

## Scope: ALL array mutations (push/unshift/splice/indexed)

Per Вадим's direction, fix non-variable FLOWS_INTO edges for ALL array mutation types.

## Key Insight

**Push/unshift/splice:** `extractArguments` already creates LITERAL/OBJECT_LITERAL/ARRAY_LITERAL nodes.
But `detectArrayMutation` doesn't set `valueNodeId` on `ArrayMutationArgument`.
Solution: Set `valueNodeId` in `detectArrayMutation` by looking up the created nodes.

**Indexed assignments:** No nodes exist yet. `detectIndexedArrayAssignment` must create them.
Solution: Create nodes inline + set `valueNodeId`.

**Both:** `bufferArrayMutationEdges` must handle non-VARIABLE types using `valueNodeId`.

## Changes

### 1. detectArrayMutation (CallExpressionVisitor.ts ~881)
For LITERAL/OBJECT_LITERAL/ARRAY_LITERAL args: after extractArguments creates nodes,
the node IDs need to be stored on ArrayMutationArgument.

Problem: `detectArrayMutation` runs BEFORE `extractArguments` (line 1272 vs 1287).
So we can't look up nodes that don't exist yet.

**Better approach:** Set `valueNodeId` in `detectArrayMutation` by generating the same IDs
that `extractArguments` will later create. But that's fragile — ID format coupling.

**Simplest approach:** Move node creation INTO `detectArrayMutation` for literal args,
and skip re-creation in `extractArguments`. But that changes too much.

**Correct approach:** After both `detectArrayMutation` and `extractArguments` run,
link them by matching on line/column/argIndex. Do this in GraphBuilder where both
ArrayMutationInfo and ArgumentInfo are available.

Wait — even simpler. In `bufferArrayMutationEdges`, for non-VARIABLE args:
- LITERAL: find in `literals` collection by file + line/column
- OBJECT_LITERAL: find in `objectLiterals` by file + line/column
- ARRAY_LITERAL: find in `arrayLiterals` by file + line/column
- CALL: find in `callSites` by callLine/callColumn

This avoids touching the visitor at all! GraphBuilder already has all collections.

### Revised Approach: GraphBuilder-only fix

**File:** GraphBuilder.ts, `bufferArrayMutationEdges`

1. Add parameters: `literals`, `objectLiterals`, `arrayLiterals`, `callSites`
2. For each non-VARIABLE arg in `insertedValues`:
   - LITERAL: find literal node by line+column match in `literals` (for push/unshift)
     OR use `valueNodeId` if set (for indexed, where we create nodes)
   - OBJECT_LITERAL: find in `objectLiterals` by line+column
   - ARRAY_LITERAL: find in `arrayLiterals` by line+column
   - CALL: find in `callSites` by callLine+callColumn

**Wait** — push/unshift literal nodes are created with the CALL's line/column, not the
literal's own line. Let me check... No, `extractArguments` uses `arg.loc?.start.line`
which IS the literal's own location.

**But** the `ArrayMutationArgument` doesn't store the literal's line/column — it only has:
- `literalValue` (for LITERAL)
- `callLine`/`callColumn` (for CALL)
- Nothing for OBJECT_LITERAL/ARRAY_LITERAL location

**So for push/unshift:** We need the value's line/column to find the node.
The `ArrayMutationInfo` has the mutation line/column (of the `.push()` call), not of each arg.

### Final Approach: Hybrid

**For push/unshift/splice (CallExpressionVisitor):**
Add `valueNodeId` population in `detectArrayMutation` — the method already has access
to `this.collections`. After type detection, look up or create the node ID.

Actually, the simplest: add `valueLine`/`valueColumn` fields to `ArrayMutationArgument`
for ALL non-variable types. Then GraphBuilder can look up by coordinates.

**For indexed (JSASTAnalyzer):**
Create nodes inline, set `valueNodeId`.

**For GraphBuilder:**
Handle non-VARIABLE types: use `valueNodeId` if set, otherwise find by coordinates.

## Final Implementation Plan

### Change 1: Add valueLine/valueColumn to ArrayMutationArgument type
File: types.ts

### Change 2: detectArrayMutation — store value coordinates
File: CallExpressionVisitor.ts ~881
For ALL non-variable types: store `actualArg.loc?.start.line/column` on argInfo.

### Change 3: detectIndexedArrayAssignment — create nodes + set valueNodeId
File: JSASTAnalyzer.ts ~5277
For LITERAL: create LITERAL node, set valueNodeId
For OBJECT_LITERAL/ARRAY_LITERAL: create nodes, set valueNodeId
For CALL: already has callLine/callColumn

### Change 4: bufferArrayMutationEdges — handle non-VARIABLE types
File: GraphBuilder.ts ~2054
Add parameters: literals, objectLiterals, arrayLiterals, callSites
For LITERAL with valueNodeId: use directly
For LITERAL without valueNodeId: find in literals by valueLine/valueColumn
For OBJECT_LITERAL: find by coordinates or use valueNodeId
For ARRAY_LITERAL: find by coordinates or use valueNodeId
For CALL: find in callSites by callLine/callColumn

### Change 5: Update call site in build()
Pass additional collections to bufferArrayMutationEdges

### Change 6: Unskip tests
IndexedArrayAssignmentRefactoring.test.js — remove describe.skip

### Change 7: Add tests for push/unshift with non-variable values
New tests verifying FLOWS_INTO edges for arr.push('literal'), arr.push({obj}), etc.
