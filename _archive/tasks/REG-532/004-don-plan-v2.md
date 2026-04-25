# REG-532 Implementation Plan v2

**Date:** 2026-02-20
**Author:** Don Melton (Tech Lead)
**Status:** Updated after Dijkstra review

## Dijkstra's Gaps - Resolution Summary

### Gap 1: CONSTRUCTOR_CALL arguments not extracted ✅ WILL FIX
**Issue:** Constructor arguments are only checked for Promise detection in `NewExpressionHandler.ts`, but never passed through `ArgumentExtractor` or `CallFlowBuilder`. The ~296 CONSTRUCTOR_CALL nodes won't get DERIVES_FROM edges to their arguments.

**Resolution:** Extract constructor arguments through `ArgumentExtractor` and create DERIVES_FROM edges in `CallFlowBuilder`, mirroring the pattern used for regular CALL nodes.

### Gap 2: DataFlowValidator type string mismatch ✅ WILL FIX (SEPARATE COMMIT)
**Issue:** Validator checks `startNode.type === 'METHOD_CALL' || startNode.type === 'CALL_SITE'` but all call nodes have `type: 'CALL'`. This check NEVER fires, causing 2498 valid CALL nodes to fail validation when they should be treated as leaf nodes.

**Resolution:** Fix the type check to `startNode.type === 'CALL' || startNode.type === 'CONSTRUCTOR_CALL'`. This is a SEPARATE bug from REG-532's core work, will be its own commit.

### Gap 3: Zero-argument builtin calls ✅ NO ACTION NEEDED
**Issue:** Calls like `Math.random()`, `Date.now()` have no arguments and no resolvable FUNCTION nodes.

**Resolution:** After fixing Gap 2, these will correctly pass validation as leaf nodes (data source endpoints). No additional work needed.

### Gap 4: Missing argument types in ArgumentExtractor ⏭️ OUT OF SCOPE
**Issue:** Template literals, await/yield, conditional expressions, unary expressions fall through to fallback case without `targetId`, missing PASSES_ARGUMENT edges.

**Resolution:** Out of scope for REG-532. Will create follow-up issue REG-XXX to handle these edge cases. Current scope is sufficient to cover the dominant case (CALL and CONSTRUCTOR_CALL with standard arguments).

### Gap 5: DERIVES_FROM semantics for side-effect calls ✅ DOCUMENTED
**Issue:** `console.log(x)` return value is `undefined`, doesn't semantically "derive" from `x`.

**Resolution:** Acceptable as "behavioral derivation" — the call's execution depends on its arguments even if the return value doesn't. Documented in inline comments. This is consistent with how we track data flow for tracing and impact analysis.

## Implementation Plan

### Change 1: Fix DataFlowValidator Type Mismatch (SEPARATE BUG FIX)

**File:** `packages/core/src/enrichers/data-flow/DataFlowValidator.ts`

**Modification:**
```typescript
// Line ~216, change from:
if (startNode.type === 'METHOD_CALL' || startNode.type === 'CALL_SITE')

// To:
if (startNode.type === 'CALL' || startNode.type === 'CONSTRUCTOR_CALL')
```

**Rationale:** All call nodes have `type: 'CALL'` (verified in `CallExpressionVisitor.ts`). This fixes the existing validator bug that causes 2498 CALL nodes to incorrectly fail validation.

**Test Impact:** Should reduce CALL-related errors from 2498 to near-zero.

**Commit Message:** `fix(dataflow): correct CALL node type check in validator (REG-532 prerequisite)`

### Change 2: Add DERIVES_FROM Edges for Regular CALL Nodes

**File:** `packages/core/src/enrichers/data-flow/CallFlowBuilder.ts`

**Current State:**
- `buildCallFlow()` processes CALL nodes
- Creates RETURNS edge from CALL → FUNCTION
- Does NOT create DERIVES_FROM edges to arguments

**Modification:**
Add after the RETURNS edge creation (around line where we finish processing the call):

```typescript
// Create DERIVES_FROM edges from CALL to its arguments
// This represents behavioral derivation: the call's execution and side effects
// depend on its arguments, even if the return value doesn't semantically derive
// from them (e.g., console.log). Useful for data flow tracing and impact analysis.
const argEdges = this.graph.queryEdges({
  filter: {
    source: callNodeId,
    type: 'PASSES_ARGUMENT'
  }
});

for (const argEdge of argEdges) {
  // PASSES_ARGUMENT points to the argument node (variable, literal, expression)
  this.graph.addEdge({
    source: callNodeId,
    target: argEdge.target,
    type: 'DERIVES_FROM',
    metadata: {
      kind: 'argument',
      position: argEdge.metadata?.position
    }
  });
}
```

**Rationale:**
- Mirrors return value tracking pattern
- Provides symmetry: return derivation + argument derivation
- Enables queries like "what data flows into this call?"

**Test Update:**
- `test/unit/data-flow-call-arguments.test.js`: Update expectations to include DERIVES_FROM edges
- Verify ~2498 CALL nodes get argument derivation edges
- Verify zero-argument calls (Math.random) don't crash

**Commit Message:** `feat(dataflow): add DERIVES_FROM edges from CALL to arguments (REG-532)`

### Change 3: Handle CONSTRUCTOR_CALL Arguments

**Files:**
1. `packages/core/src/enrichers/control-flow/visitors/NewExpressionVisitor.ts` (or wherever CONSTRUCTOR_CALL is created)
2. `packages/core/src/enrichers/data-flow/CallFlowBuilder.ts`

**Part A: Extract constructor arguments**

In the visitor that handles `new` expressions (likely `NewExpressionVisitor.ts`):

```typescript
// After creating the CONSTRUCTOR_CALL node:
const constructorCallId = /* ... */;

// Extract arguments using ArgumentExtractor
const argExtractor = new ArgumentExtractor(this.graph);
if (node.arguments) {
  node.arguments.forEach((arg, index) => {
    argExtractor.extractArgument(arg, constructorCallId, index);
  });
}
```

**Part B: Add DERIVES_FROM in CallFlowBuilder**

Extend `buildCallFlow()` or add separate `buildConstructorFlow()`:

```typescript
// Similar to Change 2, but for CONSTRUCTOR_CALL nodes
if (node.type === 'CONSTRUCTOR_CALL') {
  // Create DERIVES_FROM edges to constructor arguments
  const argEdges = this.graph.queryEdges({
    filter: {
      source: node.id,
      type: 'PASSES_ARGUMENT'
    }
  });

  for (const argEdge of argEdges) {
    this.graph.addEdge({
      source: node.id,
      target: argEdge.target,
      type: 'DERIVES_FROM',
      metadata: {
        kind: 'constructor_argument',
        position: argEdge.metadata?.position
      }
    });
  }
}
```

**Rationale:**
- Constructor calls create objects, and those objects derive from constructor arguments
- Example: `new Date(timestamp)` — the Date object derives from `timestamp`
- Example: `new Promise((resolve, reject) => {...})` — Promise instance derives from executor function

**Test Update:**
- `test/unit/data-flow-constructor-arguments.test.js` (new file):
  - Test `new Date(timestamp)` has DERIVES_FROM to timestamp
  - Test `new Promise(executor)` has DERIVES_FROM to executor
  - Test `new MyClass(a, b, c)` has DERIVES_FROM to all three arguments
- Verify ~296 CONSTRUCTOR_CALL nodes get argument derivation edges

**Commit Message:** `feat(dataflow): add DERIVES_FROM edges from CONSTRUCTOR_CALL to arguments (REG-532)`

## File Modification Summary

| File | Change | Type |
|------|--------|------|
| `packages/core/src/enrichers/data-flow/DataFlowValidator.ts` | Fix type check for CALL nodes | Bug fix |
| `packages/core/src/enrichers/data-flow/CallFlowBuilder.ts` | Add DERIVES_FROM for CALL arguments | Feature |
| `packages/core/src/enrichers/data-flow/CallFlowBuilder.ts` | Add DERIVES_FROM for CONSTRUCTOR_CALL arguments | Feature |
| `packages/core/src/enrichers/control-flow/visitors/NewExpressionVisitor.ts` | Extract constructor arguments through ArgumentExtractor | Feature |
| `test/unit/data-flow-call-arguments.test.js` | Update expectations for DERIVES_FROM edges | Test update |
| `test/unit/data-flow-constructor-arguments.test.js` | New test file for constructor flow | New test |

## Test Strategy

### Phase 1: Validator Fix (Change 1)
1. Run existing data flow tests
2. Verify CALL node validation errors drop from 2498 to near-zero
3. Verify zero-argument calls (Math.random, Date.now) pass validation

### Phase 2: CALL Arguments (Change 2)
1. Update `test/unit/data-flow-call-arguments.test.js`
2. Verify DERIVES_FROM edges exist for all argument positions
3. Verify metadata includes `kind: 'argument'` and `position`
4. Test zero-argument calls don't crash

### Phase 3: CONSTRUCTOR_CALL Arguments (Change 3)
1. Create new test file with constructor scenarios
2. Verify PASSES_ARGUMENT edges are created during control flow
3. Verify DERIVES_FROM edges are created during data flow
4. Test built-in constructors (Date, Promise, Error)
5. Test user-defined classes

### Final Validation
Run full test suite:
```bash
pnpm build
node --test --test-concurrency=1 'test/unit/*.test.js'
```

## Out of Scope (Follow-up Issues)

### REG-XXX: Handle Advanced Argument Types
- Template literals as arguments
- Await/yield expressions as arguments
- Conditional expressions as arguments
- Unary expressions as arguments

Currently these fall through to `ArgumentExtractor` fallback case without `targetId`, so they get no PASSES_ARGUMENT edges and won't get DERIVES_FROM.

**Impact:** Low — these are uncommon patterns. Standard arguments (variables, literals, calls, member expressions) are covered.

## Success Metrics

Before REG-532:
- 0 DERIVES_FROM edges from CALL/CONSTRUCTOR_CALL to arguments
- 2498 CALL nodes failing validation (due to type mismatch bug)
- ~296 CONSTRUCTOR_CALL nodes with untracked arguments

After REG-532:
- ~2498 CALL nodes with DERIVES_FROM edges to arguments (where arguments exist)
- ~296 CONSTRUCTOR_CALL nodes with DERIVES_FROM edges to arguments
- CALL validation errors < 100 (only truly malformed cases)
- Zero-argument calls (Math.random, etc.) pass validation

## Commit Sequence

1. `fix(dataflow): correct CALL node type check in validator (REG-532 prerequisite)`
2. `feat(dataflow): add DERIVES_FROM edges from CALL to arguments (REG-532)`
3. `feat(dataflow): add DERIVES_FROM edges from CONSTRUCTOR_CALL to arguments (REG-532)`

Each commit should be buildable and pass tests independently.
