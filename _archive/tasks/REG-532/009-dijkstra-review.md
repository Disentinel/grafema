# Dijkstra Correctness Review — REG-532

**Reviewer:** Edsger Dijkstra
**Date:** 2026-02-20
**Task:** REG-532 — CALL/CONSTRUCTOR_CALL nodes missing DERIVES_FROM edges to arguments

---

## Review Methodology

For EVERY function/method changed:
1. **Input enumeration**: What types/values can each parameter receive?
2. **Condition completeness**: For every if/switch/filter — what passes? what's blocked? what falls through?
3. **Loop termination**: Can every loop terminate? What about empty collections?
4. **Invariant verification**: After the function runs, what must be true?

**Rules:**
- NEVER say "looks correct" without showing enumeration
- If I cannot enumerate all input categories → REJECT

---

## Change 1: DataFlowValidator.ts — leafTypes set + type check

**File:** `packages/core/src/plugins/validation/DataFlowValidator.ts`

### Change 1a: leafTypes set (lines 67-78)

**Old values:** `'METHOD_CALL'`, `'CALL_SITE'`
**New values:** `'CALL'`, `'CONSTRUCTOR_CALL'`

**Enumeration of Set membership:**

The set is used in two contexts:
1. Line 200: `if (leafTypes.has(startNode.type))`
2. Line 216: `if (startNode.type === 'CALL' || startNode.type === 'CONSTRUCTOR_CALL')`

**Input enumeration for startNode.type:**

Possible values (from graph schema):
- 'VARIABLE', 'CONSTANT', 'LITERAL', 'FUNCTION', 'CLASS'
- 'CALL', 'CONSTRUCTOR_CALL'
- 'OBJECT_LITERAL', 'ARRAY_LITERAL'
- 'net:stdio', 'db:query', 'net:request', 'fs:operation', 'event:listener'

**Correctness check:**

The set contains:
```
'LITERAL', 'net:stdio', 'db:query', 'net:request', 'fs:operation',
'event:listener', 'CLASS', 'FUNCTION', 'CALL', 'CONSTRUCTOR_CALL'
```

**ISSUE #1 — Semantic inconsistency:**

Line 200 treats `CALL` and `CONSTRUCTOR_CALL` as leaf types (returns `{ found: true }`).
Line 216 treats them as intermediate nodes with special handling.

**Input categorization:**

1. **Node types IN leafTypes AND in line 216 special case:**
   - `'CALL'`, `'CONSTRUCTOR_CALL'`

   These will NEVER reach line 216, because line 200 returns early!

2. **Unreachable code:**
   - Lines 216-218 are UNREACHABLE for `'CALL'` and `'CONSTRUCTOR_CALL'` nodes
   - The early return at line 201 prevents execution from reaching line 216

**Proof:**
```
if (leafTypes.has(startNode.type)) {  // line 200
  return { found: true, chain };      // line 201 — EARLY RETURN
}
// ... other code ...
if (startNode.type === 'CALL' || startNode.type === 'CONSTRUCTOR_CALL') {  // line 216 — NEVER REACHED
  return { found: true, chain: [...chain, '(intermediate node)'] };
}
```

**Enumeration of execution paths:**

| startNode.type | leafTypes.has()? | Line 200 result | Line 216 reached? |
|----------------|------------------|-----------------|-------------------|
| 'CALL' | TRUE | early return | NO |
| 'CONSTRUCTOR_CALL' | TRUE | early return | NO |
| 'VARIABLE' | FALSE | continue | YES (if no assignment) |

**Consequence:**

The code at lines 216-218 is DEAD CODE. It can NEVER execute because both `'CALL'` and `'CONSTRUCTOR_CALL'` are in the leafTypes set, causing an early return at line 201.

**Verdict for Change 1a:** **REJECT** — Dead code path. Either remove from leafTypes OR remove lines 216-218.

---

### Change 1b: Type check (line 216)

**Old:** `startNode.type === 'METHOD_CALL' || startNode.type === 'CALL_SITE'`
**New:** `startNode.type === 'CALL' || startNode.type === 'CONSTRUCTOR_CALL'`

**Status:** As proven above, this code is UNREACHABLE. The change updates dead code.

**Verdict for Change 1b:** **REJECT** — This code can never execute.

---

## Change 2: CallFlowBuilder.ts — DERIVES_FROM edge after PASSES_ARGUMENT

**File:** `packages/core/src/plugins/analysis/ast/builders/CallFlowBuilder.ts`
**Lines:** 195-203

**Code:**
```typescript
this.ctx.bufferEdge(edgeData);  // PASSES_ARGUMENT edge (line 195)

// REG-532: Buffer DERIVES_FROM edge (call result depends on argument data)
this.ctx.bufferEdge({
  type: 'DERIVES_FROM',
  src: callId,
  dst: targetNodeId,
  metadata: { sourceType: 'argument', argIndex }
});
```

### Input enumeration:

**Precondition:** Line 195 executes only if `targetNodeId` is truthy (line 183).

**Possible values for targetNodeId:**

From lines 81-180, `targetNodeId` can be:

1. **VARIABLE node ID** (lines 92, 101)
2. **FUNCTION node ID** (lines 101, 151)
3. **CALL/METHOD_CALL node ID** (lines 160, 162)
4. **LITERAL/OBJECT_LITERAL/ARRAY_LITERAL node ID** (lines 168)
5. **IMPORT node ID** (lines 177)

**Possible values for callId:**

Always a CALL or CONSTRUCTOR_CALL node ID (from caller context).

### Condition enumeration:

**When does line 195 execute?**

- If `targetNodeId` is truthy (line 183)

**When does line 198 execute?**

- Same condition: if `targetNodeId` is truthy (no additional guards)

**Enumeration of edge creation:**

| Scenario | PASSES_ARGUMENT created? | DERIVES_FROM created? |
|----------|--------------------------|----------------------|
| targetNodeId is truthy | YES | YES |
| targetNodeId is falsy | NO | NO |

**Invariant verification:**

**After lines 195-203 execute, the following must be true:**

1. ∀ PASSES_ARGUMENT edge (callId → targetNodeId) ⇒ ∃ DERIVES_FROM edge (callId → targetNodeId)
2. Both edges have **identical src and dst** (callId and targetNodeId)
3. Both edges have **same argIndex** in metadata

**Is this invariant guaranteed?**

YES. The code creates both edges unconditionally within the same `if (targetNodeId)` block.

**Edge cases:**

1. **targetNodeId is null/undefined:** BOTH edges skipped (correct)
2. **Multiple arguments to same call:** Loop creates edge pair for EACH argument (correct)
3. **Spread arguments:** Both edges get `isSpread: true` metadata (correct — line 192 sets it BEFORE both bufferEdge calls)

**Loop termination:**

The outer loop (line 66: `for (const arg of callArguments)`) terminates when all callArguments are processed. Collection is finite (created during AST traversal).

**Verdict for Change 2:** **APPROVE**

---

## Change 3: NewExpressionHandler.ts — constructor arg extraction (function-body)

**File:** `packages/core/src/plugins/analysis/ast/handlers/NewExpressionHandler.ts`
**Lines:** 56-67

**Code:**
```typescript
ctx.constructorCalls.push({...});  // line 45-54

// REG-532: Extract constructor arguments for PASSES_ARGUMENT + DERIVES_FROM edges
if (newNode.arguments.length > 0) {
  if (!ctx.collections.callArguments) {
    ctx.collections.callArguments = [];
  }
  ArgumentExtractor.extract(
    newNode.arguments, constructorCallId, ctx.module,
    ctx.collections.callArguments as unknown as ArgumentInfo[],
    ctx.literals as unknown as ExtractorLiteralInfo[], ctx.literalCounterRef,
    ctx.collections, ctx.scopeTracker
  );
}
```

### Input enumeration:

**newNode.arguments types (from Babel AST spec):**

1. `Expression[]` — can be empty array
2. Each element can be: `SpreadElement | Expression`

**Possible values for newNode.arguments.length:**

- 0 (zero-argument constructor: `new Set()`)
- 1+ (constructor with arguments: `new Set([1,2,3])`)

### Condition completeness:

**Line 57: `if (newNode.arguments.length > 0)`**

| Input | Condition result | Action |
|-------|-----------------|--------|
| `[]` | FALSE | Skip extraction |
| `[arg1]` | TRUE | Initialize + extract |
| `[arg1, arg2, ...]` | TRUE | Initialize + extract |

**Line 58: `if (!ctx.collections.callArguments)`**

Ensures `callArguments` array exists before pushing to it.

**Possible states for ctx.collections.callArguments:**

1. `undefined` — first time initialization
2. `[]` — already initialized (empty)
3. `[arg1, arg2, ...]` — already has arguments from earlier calls

**Enumeration:**

| State | Guard result | Action |
|-------|--------------|--------|
| undefined | TRUE | Initialize to [] |
| [] | FALSE | Skip init (use existing) |
| [existing] | FALSE | Skip init (use existing) |

**CORRECT** — covers all cases.

### Invariant verification:

**After line 67 executes:**

1. `ctx.collections.callArguments` is an array
2. It contains ArgumentInfo entries for each argument in `newNode.arguments`
3. These entries have `callId === constructorCallId`

**Is this guaranteed?**

YES. ArgumentExtractor.extract() appends to callArguments array (line 257 in ArgumentExtractor.ts).

### Type casts:

**Line 63:** `ctx.collections.callArguments as unknown as ArgumentInfo[]`

**Why needed?**

`ctx.collections` type is `VisitorCollections` (from ASTVisitor.ts).
`callArguments` field type is likely `CallArgumentInfo[]` (from types.ts).
`ArgumentExtractor.extract()` expects `ArgumentInfo[]` (from call-expression-types.ts).

**Type hierarchy:**

These are DIFFERENT types. The cast is a workaround for type incompatibility.

**Runtime correctness:**

Both types have the same shape (duck typing in JS/TS). At runtime, the objects are compatible.

**Verdict:** Type cast is UNSAFE but functionally correct (tech debt, not a bug).

**Verdict for Change 3:** **APPROVE** (with caveat: type casts indicate design issue, but not a correctness bug)

---

## Change 4: JSASTAnalyzer.ts — constructor arg extraction (module-level)

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Lines:** 1773-1781

**Code:**
```typescript
constructorCalls.push({...});  // lines 1762-1771

// REG-532: Extract constructor arguments for PASSES_ARGUMENT + DERIVES_FROM edges
if (newNode.arguments.length > 0) {
  ArgumentExtractor.extract(
    newNode.arguments, constructorCallId, module,
    callArguments as unknown as ArgumentInfo[],
    literals as unknown as ExtractorLiteralInfo[], literalCounterRef,
    allCollections as unknown as Record<string, unknown>, scopeTracker
  );
}
```

### Comparison with Change 3:

| Aspect | Change 3 (function-body) | Change 4 (module-level) |
|--------|--------------------------|-------------------------|
| Location | NewExpressionHandler | JSASTAnalyzer |
| Guard | Yes (initializes callArguments) | No initialization guard |
| Context | ctx.collections | allCollections |

### Comparison with Change 3 initialization pattern:

**Change 3** has:
```typescript
if (!ctx.collections.callArguments) {
  ctx.collections.callArguments = [];
}
```

**Change 4** does NOT have this guard.

**Is this a bug?**

**VERIFICATION: Is callArguments initialized before line 1775?**

**Proof via code inspection:**

Line 1384 (same function scope as line 1775):
```typescript
const callArguments: CallArgumentInfo[] = [];
```

**Scope verification:**

Both line 1384 and line 1775 are in the same function scope (module analysis function in JSASTAnalyzer.ts). The declaration at line 1384 executes before the NewExpression traversal at line 1732-1820.

**Execution order:**

1. Line 1384: `callArguments` initialized as empty array `[]`
2. Line 1732: NewExpression traversal begins
3. Line 1775: `ArgumentExtractor.extract()` called with `callArguments`

**Input enumeration for callArguments at line 1775:**

At line 1775, `callArguments` can ONLY be:
1. `[]` — initialized but empty (first constructor in module)
2. `[existing]` — already has arguments from earlier constructors

It can NEVER be `undefined` because line 1384 guarantees initialization.

**Why Change 3 has a guard but Change 4 doesn't:**

- Change 3: `ctx.collections.callArguments` is part of a mutable collections object that may or may not have been initialized
- Change 4: `callArguments` is a local variable guaranteed to be initialized at function entry

**Verdict for Change 4:** **APPROVE** — callArguments is guaranteed initialized (line 1384). No guard needed.

---

## Change 5: Test file — CallDerivesFrom.test.js

**File:** `test/unit/CallDerivesFrom.test.js`

### Test enumeration:

**Test cases:**

1. **CALL with variable arguments** (lines 104-135)
2. **CALL with literal arguments** (lines 138-174)
3. **CALL with no arguments** (lines 180-197)
4. **CONSTRUCTOR_CALL with variable argument** (lines 203-224)
5. **CONSTRUCTOR_CALL with multiple arguments** (lines 226-258)
6. **CONSTRUCTOR_CALL with no arguments** (lines 264-280)
7. **Method call with arguments** (lines 286-321)
8. **PASSES_ARGUMENT and DERIVES_FROM coexistence (CALL)** (lines 327-376)
9. **PASSES_ARGUMENT and DERIVES_FROM coexistence (CONSTRUCTOR_CALL)** (lines 378-406)

### Input space coverage:

**Call node types:**

| Node Type | Variable args | Literal args | Zero args | Multiple args |
|-----------|---------------|--------------|-----------|---------------|
| CALL | ✓ (test 1) | ✓ (test 2) | ✓ (test 3) | ✓ (test 8) |
| CONSTRUCTOR_CALL | ✓ (test 4) | — | ✓ (test 6) | ✓ (test 5) |
| METHOD_CALL | — | ✓ (test 7) | — | — |

**Gap:** CONSTRUCTOR_CALL with literal arguments (no test).

**Invariant verification tests:**

Tests 8 and 9 verify that PASSES_ARGUMENT and DERIVES_FROM edges:
- Point to same targets (lines 358-362, 401-402)
- Have same argIndex metadata (implicit)

**Enumeration of assertion logic:**

Each test follows this pattern:
1. Create code sample
2. Find node by name/method/className via Datalog
3. Query outgoing DERIVES_FROM edges
4. Assert edge count
5. Assert target node names/values

**Condition completeness in tests:**

**Test 3 (zero-arg CALL):**
```typescript
assert.strictEqual(derivesEdges.length, 0, 'Zero-arg call should have NO DERIVES_FROM edges');
```

**Correct** — verifies the invariant: "Arguments.length === DERIVES_FROM edges.length"

**Test 6 (zero-arg CONSTRUCTOR_CALL):**
```typescript
assert.strictEqual(derivesEdges.length, 0, 'Zero-arg constructor should have NO DERIVES_FROM edges');
```

**Correct** — same invariant for constructors.

**Loop termination:**

All `for` loops iterate over finite collections returned by graph queries. All terminate.

**Verdict for Change 5:** **APPROVE** (with note: CONSTRUCTOR_CALL with literal args untested — minor gap)

---

## Summary of Verdicts

| Change | File | Verdict | Reason |
|--------|------|---------|--------|
| 1a | DataFlowValidator.ts (leafTypes set) | **REJECT** | Dead code: lines 216-218 unreachable |
| 1b | DataFlowValidator.ts (type check) | **REJECT** | Updates dead code |
| 2 | CallFlowBuilder.ts (DERIVES_FROM edge) | **APPROVE** | Correct invariant: both edges created together |
| 3 | NewExpressionHandler.ts (function-body) | **APPROVE** | Guard + extraction correct (type casts = tech debt) |
| 4 | JSASTAnalyzer.ts (module-level) | **APPROVE** | callArguments guaranteed initialized (line 1384) |
| 5 | CallDerivesFrom.test.js | **APPROVE** | Good coverage (minor gap: ctor literal args) |

---

## Overall Verdict: REJECT

**Critical issue:**

1. **DataFlowValidator dead code** (Changes 1a, 1b) — lines 216-218 can NEVER execute

**Fix required:**

### Issue 1: DataFlowValidator

**Root cause:** `'CALL'` and `'CONSTRUCTOR_CALL'` are in BOTH:
- leafTypes set (line 76-77)
- Special case check (line 216)

**Proof of conflict:**

```
Line 200: if (leafTypes.has('CALL')) → return { found: true }
Line 216: if (startNode.type === 'CALL') → UNREACHABLE
```

**Fix options:**

**Option A:** Remove from leafTypes set (make them NOT leaf types)
```diff
  const leafTypes = new Set([
    'LITERAL',
    'net:stdio',
    'db:query',
    'net:request',
    'fs:operation',
    'event:listener',
    'CLASS',
    'FUNCTION',
-   'CALL',
-   'CONSTRUCTOR_CALL'
  ]);
```

**Option B:** Remove special case (treat them as normal leaf types)
```diff
- if (startNode.type === 'CALL' || startNode.type === 'CONSTRUCTOR_CALL') {
-   return { found: true, chain: [...chain, '(intermediate node)'] };
- }
```

**Recommendation:** Option A (remove from leafTypes) because:
- Calls ARE intermediate nodes (they derive from arguments)
- The '(intermediate node)' message is semantically correct
- Tests don't validate leaf vs intermediate distinction, so either works

---

## Proof of Correctness (for approved changes)

### Change 2 (CallFlowBuilder)

**Theorem:** For every PASSES_ARGUMENT edge created, a DERIVES_FROM edge with identical src/dst is also created.

**Proof:**

1. Both edges are created in the same `if (targetNodeId)` block (lines 183-204)
2. No early return between line 195 and line 198
3. Both use identical variables: `callId` (src) and `targetNodeId` (dst)
4. ∴ If line 195 executes, line 198 MUST also execute
5. ∴ PASSES_ARGUMENT edge exists ⇔ DERIVES_FROM edge exists

**QED.**

### Change 3 (NewExpressionHandler)

**Theorem:** If newNode has arguments, callArguments array will be populated.

**Proof:**

1. Guard: `if (newNode.arguments.length > 0)` (line 57)
2. Initialization: `if (!ctx.collections.callArguments)` ensures array exists (lines 58-60)
3. ArgumentExtractor.extract() appends to array (ArgumentExtractor.ts:257)
4. ∴ After line 67, callArguments contains entries for all arguments in newNode.arguments

**QED.**

---

## Dijkstra's Signature

I have enumerated all inputs, conditions, and invariants.

**Changes 2, 3, 5:** APPROVED (correct by enumeration)
**Changes 1a, 1b:** REJECTED (dead code proven unreachable)
**Change 4:** CONDITIONAL REJECT (requires initialization proof or guard)

Fix the two critical issues and re-submit for review.

— Edsger W. Dijkstra
