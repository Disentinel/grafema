# REG-532: Dijkstra Plan Verification - DERIVES_FROM Edges for CALL Nodes

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-20
**Status:** REJECT with Required Fixes

## Executive Summary

Don's plan is **architecturally sound** but has **5 critical gaps** that must be addressed before implementation:

1. **CONSTRUCTOR_CALL arguments not extracted** — constructor arguments never go through `ArgumentExtractor`, so they won't get PASSES_ARGUMENT or DERIVES_FROM edges
2. **Zero-argument calls create data flow dead-ends** — pure functions like `Math.random()` will still fail validation
3. **Unresolved calls remain dead-ends** — dynamic calls with no FUNCTION target still have no leaf node
4. **Missing argument types** — template literals, await/yield expressions, assignment expressions not enumerated
5. **Semantic correctness gap** — DERIVES_FROM from CALL to arguments is questionable for side-effect-only calls

## Verification Method

I verified Don's claims by:
1. Reading all 4 referenced source files (CallFlowBuilder, DataFlowValidator, CallExpressionVisitor, AssignmentBuilder)
2. Checking ArgumentExtractor to enumerate argument types
3. Tracing NewExpression handling to verify constructor call argument extraction
4. Building completeness tables for each classification rule

---

## 1. Completeness Tables

### 1.1 CALL Node Input Categories

Don mentioned: direct calls, method calls, callbacks, dynamic calls.

**Complete enumeration:**

| Call Type | Example | Created By | Goes Through CallFlowBuilder? |
|-----------|---------|------------|-------------------------------|
| Direct call | `foo()` | CallExpressionVisitor.handleDirectCall | ✅ YES |
| Method call | `obj.foo()` | CallExpressionVisitor.handleSimpleMethodCall | ✅ YES |
| Chained method | `obj.foo.bar()` | CallExpressionVisitor.handleNestedMethodCall | ✅ YES |
| Constructor | `new Foo()` | CallExpressionVisitor.handleNewExpression | ✅ YES |
| Member constructor | `new Foo.Bar()` | CallExpressionVisitor.handleNewExpression | ✅ YES |
| Super call | `super()` | ❓ Not found in code | ❓ UNKNOWN |
| Optional call | `foo?.()` | ❓ Not found in code | ❓ UNKNOWN |
| Tagged template | `foo\`hello\`` | ❓ Not found in code | ❓ UNKNOWN |
| Dynamic import | `import('module')` | ❓ Not found in code | ❓ UNKNOWN |
| IIFE-like | `foo()(...)` | ❓ Not verified | ❓ UNKNOWN |

**Gap Found:** Don's plan doesn't mention super calls, optional calls, tagged templates, or dynamic imports. These may or may not be handled by current AST visitors.

**Impact:** LOW — these are rare patterns, but should be documented.

---

### 1.2 Argument Node Types

Don mentioned: variables, literals, nested calls, spread.

**Complete enumeration from ArgumentExtractor.ts:**

| Argument Type | Example | `targetType` in ArgumentExtractor | Handled? |
|---------------|---------|-----------------------------------|----------|
| Identifier | `foo(x)` | `VARIABLE` | ✅ YES |
| String literal | `foo("hello")` | `LITERAL` | ✅ YES |
| Number literal | `foo(42)` | `LITERAL` | ✅ YES |
| Boolean literal | `foo(true)` | `LITERAL` | ✅ YES |
| Null | `foo(null)` | `LITERAL` | ✅ YES |
| Undefined | `foo(undefined)` | `LITERAL` | ✅ YES |
| Object literal | `foo({a: 1})` | `OBJECT_LITERAL` | ✅ YES |
| Array literal | `foo([1, 2])` | `ARRAY_LITERAL` | ✅ YES |
| Function expression | `foo(() => {})` | `FUNCTION` | ✅ YES |
| Arrow function | `foo(x => x)` | `FUNCTION` | ✅ YES |
| Call expression | `foo(bar())` | `CALL` | ✅ YES |
| Member expression | `foo(obj.prop)` | `EXPRESSION` (MemberExpression) | ✅ YES |
| Binary expression | `foo(a + b)` | `EXPRESSION` (BinaryExpression) | ✅ YES |
| Logical expression | `foo(a && b)` | `EXPRESSION` (LogicalExpression) | ✅ YES |
| Spread element | `foo(...arr)` | (wraps actual arg type) | ✅ YES |
| Template literal | `foo(\`hello ${x}\`)` | ❌ NOT HANDLED | ❌ NO |
| Await expression | `foo(await bar())` | ❌ NOT HANDLED | ❌ NO |
| Yield expression | `foo(yield x)` | ❌ NOT HANDLED | ❌ NO |
| Conditional expression | `foo(x ? a : b)` | ❌ NOT HANDLED | ❌ NO |
| Assignment expression | `foo(a = 1)` | ❌ NOT HANDLED | ❌ NO |
| Unary expression | `foo(!x)` | ❌ NOT HANDLED | ❌ NO |

**Gap Found:** ArgumentExtractor has a fallback case for unhandled expression types:
```typescript
// Other expression types (fallback for unhandled expression types)
else {
  argInfo.targetType = 'EXPRESSION';
  argInfo.expressionType = actualArg.type;
}
```

This means unhandled types (template literals, await, yield, etc.) get:
- `targetType = 'EXPRESSION'`
- `expressionType = 'TemplateLiteral'` (or whatever)
- **BUT NO `targetId`** — so `bufferArgumentEdges()` will skip them (line 183: `if (targetNodeId) ...`)

**Impact:** MEDIUM — these argument types won't get PASSES_ARGUMENT edges today, and won't get DERIVES_FROM edges either. Affects real code (template literals are common).

---

### 1.3 CONSTRUCTOR_CALL Argument Handling

Don's plan says (line 254-260):
> **Check:** Do CONSTRUCTOR_CALL nodes go through CallFlowBuilder.bufferArgumentEdges()?
> - If YES: arguments already handled
> - If NO: need to replicate argument DERIVES_FROM logic in AssignmentBuilder

**Verification:**

NewExpressionHandler.ts (line 56-57):
```typescript
if (className === 'Promise' && newNode.arguments.length > 0) {
  const executorArg = newNode.arguments[0];
```

This is the **ONLY** place constructor arguments are examined. They are NOT passed to ArgumentExtractor.

CallExpressionVisitor.ts creates CALL nodes for `new Foo()` but does NOT extract arguments for them.

**Finding:** CONSTRUCTOR_CALL nodes **DO NOT** go through `bufferArgumentEdges()`.

**Impact:** **CRITICAL** — ~296 CONSTRUCTOR_CALL nodes will get DERIVES_FROM to CLASS (per Don's plan line 254) but NOT to their arguments. This violates Don's own thesis: "A call's result logically derives from both its arguments AND the function's implementation."

Example:
```javascript
const arr = new Set([1, 2, 3])  // arr derives from Set class, but NOT from [1,2,3]
```

---

### 1.4 DERIVES_FROM Semantic Correctness

Don's claim (line 161-165):
> DERIVES_FROM means "this value's data originates from these sources"
> A call's result logically derives from both its arguments AND the function's implementation

**Challenge:** Does this hold for ALL calls?

#### Case 1: Pure zero-argument functions
```javascript
const x = Math.random()  // x DERIVES_FROM what?
const y = Date.now()     // y DERIVES_FROM what?
```

Don's plan would create:
- `CALL:Math.random → DERIVES_FROM → FUNCTION:Math.random` (if resolvable)
- But Math.random is a builtin → no FUNCTION node exists

Result: **Still a dead-end** for DataFlowValidator.

#### Case 2: Side-effect-only calls
```javascript
const result = console.log(x)  // result is undefined, doesn't "derive" from x
const status = process.exit(1) // never returns
```

Does `CALL:console.log → DERIVES_FROM → VARIABLE:x` make semantic sense? The return value (undefined) doesn't contain data from `x`.

**Counter-argument:** This is a CALL-level edge, not a return-value edge. The call's **behavior** derives from its arguments, even if the return value doesn't.

**Verdict:** Semantically **acceptable** but philosophically questionable. Document the "behavioral derivation" interpretation.

#### Case 3: Callback arguments
```javascript
arr.map(x => x * 2)
```

Don's plan creates:
- `CALL:arr.map → DERIVES_FROM → FUNCTION:(x => x*2)` (callback)

But does the map call's result derive from the callback FUNCTION node, or from the callback's **behavior**? If the callback is stored in a variable:
```javascript
const double = x => x * 2
arr.map(double)
```

Now we get:
- `CALL:arr.map → PASSES_ARGUMENT → VARIABLE:double`
- `CALL:arr.map → DERIVES_FROM → VARIABLE:double` (per Don's plan)
- `VARIABLE:double → ASSIGNED_FROM → FUNCTION:(x => x*2)`

This creates **correct data flow**: map result ← CALL ← double variable ← callback function.

**Verdict:** Semantics are **sound** for callbacks.

---

### 1.5 Zero-Argument Calls and Unresolved Calls

Don acknowledged these (line 266-276 "Edge Cases to Watch") but didn't provide a solution.

**Problem:**
```javascript
const x = Math.random()
```

Creates:
- `VARIABLE:x → ASSIGNED_FROM → CALL:Math.random`
- `CALL:Math.random → CALLS → ???` (no FUNCTION node for builtins)
- `CALL:Math.random → DERIVES_FROM → ???` (no arguments, no function)

**DataFlowValidator traversal:**
1. Start at `VARIABLE:x`
2. Follow `ASSIGNED_FROM` to `CALL:Math.random`
3. Check if `CALL_SITE` is a leaf type → **YES** (line 77 in DataFlowValidator)
4. But line 216-218 overrides this: **intermediate node** special case
5. Look for outgoing `DERIVES_FROM` → **NONE**
6. → **ERR_NO_LEAF_NODE**

**Root cause:** DataFlowValidator line 216-218 treats CALL nodes as intermediate (not leaf) when they have no outgoing data flow edges. But zero-arg builtins will NEVER have outgoing DERIVES_FROM edges.

**Solution required:** Either:
- Remove the line 216-218 special case (treat CALLs as true leaf nodes)
- OR: Create DERIVES_FROM to LITERAL:undefined for zero-arg calls (hack)
- OR: Document that builtins should be in `leafTypes` but fix the validator logic

**Impact:** **CRITICAL** — Don's plan will NOT fix zero-argument builtin calls.

---

## 2. Precondition Verification

### 2.1 Does `bufferArgumentEdges()` handle ALL argument types?

**NO.** See Section 1.2 — template literals, await/yield, conditional expressions, assignments, unary expressions fall through to the fallback case without creating `targetId`.

**Impact:** These arguments won't get PASSES_ARGUMENT edges today, and won't get DERIVES_FROM edges under Don's plan.

---

### 2.2 Are CONSTRUCTOR_CALL nodes processed by CallFlowBuilder at all?

**NO.** See Section 1.3 — constructor arguments never go through ArgumentExtractor or CallFlowBuilder.

**Impact:** Don's plan misses ~296 nodes.

---

### 2.3 Does DataFlowValidator follow DERIVES_FROM edges?

**YES.** DataFlowValidator.ts line 93, 212:
```typescript
const outgoing = await graph.getOutgoingEdges(variable.id, ['ASSIGNED_FROM', 'DERIVES_FROM']);
```

Confirmed.

---

### 2.4 Is CALL_SITE in `leafTypes`?

**YES.** DataFlowValidator.ts line 67-78:
```typescript
const leafTypes = new Set([
  'LITERAL', 'net:stdio', 'db:query', 'net:request',
  'fs:operation', 'event:listener', 'CLASS', 'FUNCTION',
  'METHOD_CALL', 'CALL_SITE'
]);
```

**BUT** — line 216-218 overrides this:
```typescript
if (startNode.type === 'METHOD_CALL' || startNode.type === 'CALL_SITE') {
  return { found: true, chain: [...chain, '(intermediate node)'] };
}
```

This special case is the **real bug**. It only triggers when a CALL node has no outgoing ASSIGNED_FROM/DERIVES_FROM edges (checked at line 215).

**The validator's intent:** CALLs are leaf nodes ONLY if they have no outgoing data flow. If they DO have outgoing edges, follow them.

**Don's fix:** Add DERIVES_FROM edges → validator will follow them → no more special case triggered.

**What about zero-arg calls?** They won't have DERIVES_FROM edges → special case STILL triggers → still marked as intermediate → **validation passes**.

Wait, re-reading line 216-218... it returns `found: true`. So it's saying "yes, we found a leaf node (the call itself)". This is NOT an error.

Let me re-check the error condition...

Line 133-147:
```typescript
const path = await this.findPathToLeaf(variable, graph, leafTypes);
if (!path.found) {
  errors.push(new ValidationError(..., 'ERR_NO_LEAF_NODE', ...));
}
```

So `found: false` is the error. Line 216-218 returns `found: true` → **NO ERROR**.

**Correction:** The line 216-218 special case is a **success path**, not a failure path. It's saying "CALLs with no outgoing edges ARE leaf nodes."

**Re-analysis:**

Current validator logic:
1. CALL is in `leafTypes` (line 77)
2. When reaching a CALL during traversal:
   - If CALL has no outgoing ASSIGNED_FROM/DERIVES_FROM → line 216 special case → `found: true` ✅
   - If CALL is checked at line 200 → it's in leafTypes → `found: true` ✅

So... why are we getting ERR_NO_LEAF_NODE for CALLs?

**Hypothesis:** The error occurs when traversing BACKWARDS from a VARIABLE that is assigned from a CALL. The path is:
```
VARIABLE:x → (outgoing ASSIGNED_FROM) → CALL:foo → (outgoing ???) → ???
```

If CALL has NO outgoing ASSIGNED_FROM/DERIVES_FROM, we check line 215:
```typescript
if (!assignment) {
  if (startNode.type === 'METHOD_CALL' || startNode.type === 'CALL_SITE') {
    return { found: true, chain: [...chain, '(intermediate node)'] };
  }
  return { found: false, chain: [...chain, '(no assignment)'] };
}
```

So it's:
- No outgoing edge from CALL
- Type is CALL_SITE or METHOD_CALL
- → Return `found: true` with label "(intermediate node)"

This means **the validation PASSES** for CALLs with no outgoing edges.

**But Don's report says ~2800 ERR_NO_LEAF_NODE warnings for CALLs.** How?

Let me re-read Don's exploration report...

Don's report line 112-123:
> **The Bug:** Line 216-218 has special handling that treats CALL/METHOD_CALL as intermediate nodes:
> ```typescript
> if (startNode.type === 'METHOD_CALL' || startNode.type === 'CALL_SITE') {
>   return { found: true, chain: [...chain, '(intermediate node)'] };
> }
> ```
> This is AFTER checking for assignment edges (line 212-215), so it only triggers when a CALL has no outgoing ASSIGNED_FROM/DERIVES_FROM edges.

Don says this code "treats CALL/METHOD_CALL as intermediate nodes" but it returns `found: true`. That's not an error.

**Wait.** Let me check what Don's actual evidence is. Line 7-8:
> ~2800 ERR_NO_LEAF_NODE warnings caused by CALL and CONSTRUCTOR_CALL nodes lacking outgoing DERIVES_FROM edges.

Did Don **measure** this, or **infer** it? Let me check if there's actual data...

Line 15-17:
> **Breakdown:**
> - CALL → dead end: 2498 cases
> - CONSTRUCTOR_CALL → dead end: 296 cases

This looks like measured data. But CONSTRUCTOR_CALL is not in the validator's `leafTypes` set! Let me check...

Line 67-78 of DataFlowValidator: No CONSTRUCTOR_CALL in leafTypes.

**Aha!** CONSTRUCTOR_CALL nodes are NOT leaf nodes, so when the validator reaches them without outgoing edges, it fails at line 220:
```typescript
return { found: false, chain: [...chain, '(no assignment)'] };
```

**For CALL_SITE/METHOD_CALL:** Line 216 special case returns `found: true` → no error.

**For CONSTRUCTOR_CALL:** No special case → line 220 → `found: false` → **ERR_NO_LEAF_NODE**.

So the ~2800 errors are:
- 296 CONSTRUCTOR_CALL nodes (not leaf types, no outgoing edges)
- 2498 CALL_SITE/METHOD_CALL nodes... but wait, these SHOULD pass via line 216.

**Mystery:** Why are 2498 CALL nodes failing validation if line 216 marks them as `found: true`?

**Possible explanations:**
1. Line 216 was added AFTER Don's exploration (unlikely - it's in the code I read)
2. Don's numbers are from a different metric (not DataFlowValidator)
3. The traversal reaches CALLs via a different path where line 216 doesn't trigger

Let me check if there are other paths... Line 204-210:
```typescript
const incomingUses = await graph.getIncomingEdges(startNode.id, ['USES']);
const usedByCall = incomingUses[0];
if (usedByCall) {
  const callNode = await graph.getNode(usedByCall.src);
  const callName = callNode?.name ?? usedByCall.src;
  return { found: true, chain: [...chain, `(used by ${callName})`] };
}
```

So if a node is USED by a CALL, it's also considered a leaf. This is BEFORE checking for CALL type.

**New hypothesis:** The 2498 CALL errors are from CALLs that:
- Are NOT CALL_SITE or METHOD_CALL type (maybe different type string?)
- Have no outgoing edges
- Fall through to line 220

Let me check what types CALLs actually have in the graph... From CallExpressionVisitor.ts:
- Line 217: `type: 'CALL'` (for direct calls)
- Line 326: `type: 'CALL'` (for method calls)

So both CALL_SITE and METHOD_CALL have `type: 'CALL'`.

But line 216 checks for:
```typescript
if (startNode.type === 'METHOD_CALL' || startNode.type === 'CALL_SITE')
```

**BUG FOUND!** The validator checks for `'METHOD_CALL'` and `'CALL_SITE'` but the actual node type is `'CALL'`.

This means line 216 **NEVER FIRES** for CALL nodes, so they ALL fall through to line 220 → `found: false`.

**This explains the 2498 CALL errors.**

**Conclusion:** Don's diagnosis is correct, but the root cause is a type string mismatch in DataFlowValidator line 216, not missing DERIVES_FROM edges.

**However:** Adding DERIVES_FROM edges WILL fix the issue, because line 213-221 will find an outgoing edge and follow it instead of checking line 216.

So Don's fix is **correct** even if the diagnosis missed the type mismatch bug.

---

## 3. Gaps Found

### Gap 1: CONSTRUCTOR_CALL Arguments Not Extracted

**Location:** NewExpressionHandler.ts, CallExpressionVisitor.ts
**Impact:** CRITICAL — 296 constructor calls won't get DERIVES_FROM to arguments
**Fix Required:** Extract constructor arguments in CallExpressionVisitor or add to CallFlowBuilder

---

### Gap 2: Zero-Argument Builtin Calls Remain Dead-Ends

**Location:** CallFlowBuilder.ts
**Impact:** HIGH — `Math.random()`, `Date.now()`, etc. will still fail if line 216 type mismatch is fixed
**Fix Required:** Treat zero-arg builtin calls as leaf nodes OR create DERIVES_FROM to a synthetic source

---

### Gap 3: Unresolved Dynamic Calls Remain Dead-Ends

**Location:** CallFlowBuilder.ts
**Impact:** MEDIUM — dynamic calls like `fn()` where `fn` is runtime-determined
**Fix Required:** Document as known limitation OR create DERIVES_FROM to arguments only (partial fix)

---

### Gap 4: Missing Argument Type Handlers

**Location:** ArgumentExtractor.ts line 250-254
**Impact:** MEDIUM — template literals, await/yield, conditional, assignment, unary expressions
**Fix Required:** Extend ArgumentExtractor to create EXPRESSION nodes for these types

---

### Gap 5: DataFlowValidator Type String Mismatch

**Location:** DataFlowValidator.ts line 216
**Impact:** CRITICAL — explains the 2498 CALL errors
**Code:**
```typescript
if (startNode.type === 'METHOD_CALL' || startNode.type === 'CALL_SITE') {
```
Should be:
```typescript
if (startNode.type === 'CALL') {
```

**This is a SEPARATE bug** that should be fixed alongside Don's plan.

---

## 4. Verdict: REJECT with Required Fixes

Don's plan is **architecturally sound** and will significantly reduce ERR_NO_LEAF_NODE warnings. However, it has **critical gaps** that must be addressed:

### Required Before Implementation:

1. **Add constructor argument extraction**
   - Extend CallExpressionVisitor.handleNewExpression to call ArgumentExtractor
   - OR: Add separate handler in CallFlowBuilder for CONSTRUCTOR_CALL nodes

2. **Fix DataFlowValidator type mismatch** (separate bug)
   - Change line 216 from `'METHOD_CALL' || 'CALL_SITE'` to `'CALL'`
   - This will allow zero-arg calls to pass validation without DERIVES_FROM edges

3. **Decide on zero-arg builtin calls policy**
   - Option A: Leave them as passing validation (line 216 fix handles this)
   - Option B: Create DERIVES_FROM to synthetic BUILTIN_FUNCTION nodes
   - **Recommendation:** Option A (simpler, semantically honest)

4. **Extend ArgumentExtractor** (nice-to-have)
   - Add handlers for: TemplateLiteral, AwaitExpression, YieldExpression, ConditionalExpression, UnaryExpression
   - These are edge cases but affect real code

### Approved Unchanged:

✅ DERIVES_FROM from CALL → arguments (semantically sound)
✅ DERIVES_FROM from CALL → callee FUNCTION (when resolvable)
✅ Implementation location (CallFlowBuilder analysis phase)
✅ Edge metadata (`sourceType: 'argument' | 'callee'`)

### Open Questions Requiring Decision:

1. Should CONSTRUCTOR_CALL → DERIVES_FROM → CLASS for builtin constructors (new Set, new Map)?
   - **Recommendation:** YES, with `isBuiltin` metadata. Enables queries like "find all uses of Set"

2. Should unresolved dynamic calls get DERIVES_FROM to arguments only?
   - **Recommendation:** YES. Partial data flow is better than none.

---

## Next Steps

1. **Don** updates plan to address Gaps 1-4
2. **Kent** writes tests covering:
   - Constructor call arguments: `new Set([1,2,3])`
   - Zero-arg builtins: `Math.random()`
   - Unresolved calls: `dynamicFn(arg)`
   - Missing argument types: `foo(\`template ${x}\`)`
   - DataFlowValidator fix validation
3. **Rob** implements with all gaps fixed
4. **4-Review** validates completeness

---

**Dijkstra's Note:** Don's instinct is correct — DERIVES_FROM edges will fix the core issue. But the devil is in the edge cases. A plan is only as strong as its handling of the overlooked 5%.
