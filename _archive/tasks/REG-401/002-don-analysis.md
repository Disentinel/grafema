# Don Melton -- Technical Analysis: REG-401

## Callback CALLS for User-Defined HOFs via Parameter Invocation Check

---

## 1. Current Architecture

### 1.1 How Callback CALLS Edges Are Created Today

There are **two places** where callback CALLS edges are created, both gated by the same whitelist (`KNOWN_CALLBACK_INVOKERS`):

**Analysis phase** (`GraphBuilder.ts`, line ~1875):
- During graph building, when processing PASSES_ARGUMENT edges for same-file callbacks
- If the argument is a function reference (resolved via `findFunctionByName`)
- AND the call site name is in `KNOWN_CALLBACK_INVOKERS`
- Then: create `CALLS` edge with `{ callType: 'callback' }`

**Enrichment phase** (`CallbackCallResolver.ts`):
- Handles **cross-file** imported callbacks
- Iterates all CALL/METHOD_CALL nodes
- Skips if call name NOT in `KNOWN_CALLBACK_INVOKERS` (line 139)
- For whitelisted calls: follows PASSES_ARGUMENT -> IMPORT -> IMPORTS_FROM -> EXPORT -> FUNCTION chain
- Creates CALLS edge with `{ callType: 'callback' }`

### 1.2 The Whitelist

```typescript
const KNOWN_CALLBACK_INVOKERS = new Set([
  'forEach', 'map', 'filter', 'find', 'findIndex',
  'some', 'every', 'reduce', 'reduceRight', 'flatMap', 'sort',
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
  'then', 'catch', 'finally',
  'requestAnimationFrame', 'addEventListener',
]);
```

### 1.3 What the Test Suite Currently Asserts

Test 5 (line 262) explicitly asserts that custom HOFs do NOT get callback CALLS edges:
```javascript
// NO callback CALLS edge: myHOF is not a known HOF (whitelist-based verification)
assert.ok(!callbackCallEdge, 'Should NOT have callback CALLS edge for unknown HOF');
```

Test 12 (line 669) asserts store/register patterns also don't get callback CALLS edges.

**Key insight:** REG-401 needs to change test 5's assertion (flip the expectation) while keeping test 12 passing. This is the core discrimination: `fn()` inside the function body = invoke, `registry.push(fn)` = store.

### 1.4 Existing Graph Infrastructure We Can Leverage

| Infrastructure | Status | Notes |
|---|---|---|
| PARAMETER nodes | Created in analysis | Have `name`, `index`, `parentFunctionId` |
| HAS_PARAMETER edges | Created in analysis | FUNCTION -> PARAMETER |
| PASSES_ARGUMENT edges | Created in analysis | CALL -> target (FUNCTION/IMPORT/VARIABLE) |
| CALLS edges (direct) | Created in analysis + enrichment | CALL -> FUNCTION (direct call resolution) |
| parentScopeId on CALL nodes | Stored on graph node | Tells which function a CALL is inside |
| ArgumentParameterLinker | Enrichment plugin | Creates RECEIVES_ARGUMENT: PARAMETER -> argument_source |

---

## 2. Graph Structure for Target Scenarios

### Scenario A: `function apply(fn) { fn(); } apply(handler)`

```
Nodes:
  FUNCTION#apply      { name: 'apply', file: 'index.js' }
  FUNCTION#handler    { name: 'handler', file: 'index.js' }
  PARAMETER#fn        { name: 'fn', index: 0, parentFunctionId: FUNCTION#apply }
  CALL#apply          { name: 'apply', parentScopeId: MODULE }
  CALL#fn             { name: 'fn', parentScopeId: FUNCTION#apply }

Edges:
  FUNCTION#apply  --HAS_PARAMETER-->  PARAMETER#fn
  CALL#apply      --CALLS-->          FUNCTION#apply     (direct call)
  CALL#apply      --PASSES_ARGUMENT--> FUNCTION#handler   (argIndex: 0)
  CALL#fn         (NO outgoing CALLS edge -- unresolved)

Goal: Create  CALL#apply --CALLS--> FUNCTION#handler  { callType: 'callback' }
```

**Why `fn()` is unresolved:** `fn` is a parameter name, not a function defined in scope. FunctionCallResolver can't resolve it because there's no function named `fn` in the file.

### Scenario B: `function store(fn) { registry.push(fn); } store(handler)`

```
Nodes:
  FUNCTION#store      { name: 'store' }
  FUNCTION#handler    { name: 'handler' }
  PARAMETER#fn        { name: 'fn', index: 0, parentFunctionId: FUNCTION#store }
  CALL#store          { name: 'store', parentScopeId: MODULE }
  CALL#registry.push  { name: 'registry.push', method: 'push', parentScopeId: FUNCTION#store }

Edges:
  FUNCTION#store  --HAS_PARAMETER-->  PARAMETER#fn
  CALL#store      --CALLS-->          FUNCTION#store     (direct call)
  CALL#store      --PASSES_ARGUMENT--> FUNCTION#handler   (argIndex: 0)

Goal: NO callback CALLS edge (fn is stored, not invoked)
```

**Key difference:** In scenario A, there's a CALL node with `name: 'fn'` inside `apply`'s scope. In scenario B, there's no such CALL node -- `fn` appears only as an argument to `registry.push()`, not as a direct callee.

---

## 3. Proposed Approach

### 3.1 Algorithm: Parameter Invocation Check

**Where:** New enrichment plugin `ParameterInvocationResolver` (runs AFTER `CallbackCallResolver` and `ArgumentParameterLinker`).

**Why a new plugin, not extending CallbackCallResolver:**
- CallbackCallResolver handles cross-file imported callbacks via IMPORT chain traversal
- The parameter invocation check is a fundamentally different strategy: introspecting the callee's body via graph queries
- Mixing these would make CallbackCallResolver harder to understand and maintain
- Separation of concerns: whitelist-based vs. body-analysis-based

**Algorithm:**

```
For each CALL node C where:
  1. C has a PASSES_ARGUMENT edge to a FUNCTION node F (or VARIABLE resolving to FUNCTION)
  2. C has a direct CALLS edge to a FUNCTION node T (the target/receiving function)
  3. C does NOT already have a callback CALLS edge to F

Then check if T invokes the parameter at the matching index:
  a. Get T's PARAMETER at argIndex via HAS_PARAMETER edges
  b. If parameter name is P_name
  c. Find all CALL nodes inside T's scope (parentScopeId == T.id)
  d. If any CALL node has name == P_name → T invokes the parameter
  e. Create CALLS edge: C -> F with { callType: 'callback' }
```

### 3.2 Detailed Steps

**Step 1: Collect candidate call sites**

Iterate all CALL nodes. For each, get outgoing PASSES_ARGUMENT edges. Filter to those where:
- The PASSES_ARGUMENT target is a FUNCTION node (same-file callback)
- The call site also has a direct CALLS edge to another FUNCTION (the receiving HOF)
- No existing callback CALLS edge to the passed function

**Step 2: For each candidate, check parameter invocation**

Given: call site `C`, passed function `F`, receiving function `T`, argIndex `idx`

1. Get `T`'s parameters via `HAS_PARAMETER` edges
2. Find parameter with `index == idx` -> get `paramName`
3. Query all CALL nodes where `parentScopeId == T.id`
4. Check if any has `name == paramName` (direct invocation: `fn()`)
5. Also check for `method == paramName` on METHOD_CALL nodes? No -- `fn.call()` or `fn.apply()` is a different pattern. For MVP, only direct `fn()` invocation.

**Step 3: Create edge**

If parameter is invoked: create `CALLS` edge from `C` to `F` with `{ callType: 'callback' }`.

### 3.3 Complexity Analysis

| Operation | Complexity | Notes |
|---|---|---|
| Collect all CALL nodes | O(C) where C = total CALL nodes | One-time iteration |
| For each CALL, get PASSES_ARGUMENT edges | O(1) per call (graph lookup) | |
| For each candidate, get HAS_PARAMETER | O(P) where P = params of target | Typically 1-5 |
| Find CALL nodes inside target scope | See below | |

**Critical question: How to find CALL nodes inside a function's scope?**

Option A: Pre-build index `Map<parentScopeId, CALL[]>` by iterating all CALL nodes once. Then lookup is O(1).
- Cost: O(C) one-time to build index
- This is the right approach -- we already iterate all CALL nodes in step 1

Option B: Query `graph.queryNodes({ nodeType: 'CALL' })` filtered by parentScopeId -- this would require iterating all CALL nodes per candidate, which is O(C * K) where K = candidates. Not acceptable.

**Total complexity: O(C + K*P)** where:
- C = total CALL nodes (one-time index build)
- K = candidate call sites with PASSES_ARGUMENT -> FUNCTION (small subset)
- P = average parameter count per receiving function (typically 1-5)

This is efficient. We do NOT scan all nodes or all edges -- we iterate CALL nodes once (which CallbackCallResolver already does), then do targeted lookups for the small set of candidates.

### 3.4 Edge Cases

1. **`fn.call(thisArg)` / `fn.apply(thisArg, args)`** -- The parameter is invoked via `.call()` or `.apply()`. The CALL node would be a METHOD_CALL with `object: 'fn'`, not `name: 'fn'`. For MVP, skip this -- it's a separate enhancement. Document as known limitation.

2. **Destructured parameters** -- `function apply({ fn }) { fn(); }`. PARAMETER nodes for destructured params are not created yet (documented in `createParameterNodes.ts` line 29). Skip for now.

3. **Rest parameters** -- `function apply(...fns) { fns[0](); }`. The invocation is through array access, not direct call. Skip for now.

4. **Aliased parameters** -- `function apply(fn) { const f = fn; f(); }`. The parameter is assigned to a variable, then the variable is invoked. Would require intra-procedural data flow. Skip for MVP.

5. **Nested invocation** -- `function apply(fn) { setTimeout(fn, 0); }`. The parameter is passed to another HOF inside the body. This would be caught by a recursive analysis, but is out of scope for MVP. The whitelist will catch `setTimeout(fn)` at the inner level.

6. **Cross-file receiving function** -- `import { apply } from './utils'; apply(handler);`. The receiving function is in another file. We need to follow the CALLS edge from the call site to the imported function, then check that function's body. This should work naturally since CALLS edges to imported functions are already resolved by FunctionCallResolver.

7. **Method call as receiving function** -- `obj.apply(handler)`. If `obj.apply` is resolved via MethodCallResolver to a FUNCTION, the same algorithm works. But most method calls are unresolved. Skip unresolved method calls.

---

## 4. What Needs to Change

### 4.1 New File

**`packages/core/src/plugins/enrichment/ParameterInvocationResolver.ts`**
- New enrichment plugin
- Dependencies: `CallbackCallResolver`, `FunctionCallResolver`, `ArgumentParameterLinker`
- Consumes: PASSES_ARGUMENT, CALLS, HAS_PARAMETER
- Produces: CALLS

### 4.2 Modified Files

**`packages/core/src/config/ConfigLoader.ts`**
- Add `ParameterInvocationResolver` to enrichment plugin list (after CallbackCallResolver)

**`packages/core/src/index.ts`**
- Export new plugin class

**`test/unit/CallbackFunctionReference.test.js`**
- Modify test 5 ("Custom higher-order function"): flip assertion to EXPECT callback CALLS edge
- Modify test 12 ("Store/register pattern"): keep as-is (no callback CALLS edge)
- Add new test cases:
  - Parameter invoked as `fn()` -> CALLS edge created
  - Parameter passed to another function `registry.push(fn)` -> no CALLS edge
  - Parameter not used at all `function noop(fn) {}` -> no CALLS edge
  - Multiple parameters, only one invoked -> only that one gets CALLS edge
  - Cross-file: imported function used as HOF that invokes parameter

### 4.3 Files NOT Modified

- `CallbackCallResolver.ts` -- unchanged, keeps handling cross-file whitelist-based resolution
- `GraphBuilder.ts` -- unchanged, keeps handling same-file whitelist-based resolution
- No analysis-phase changes needed -- all graph data already exists

---

## 5. Alternative Approaches Considered

### 5.1 Extend the Whitelist Dynamically

Auto-detect HOFs during analysis and add them to the whitelist. Rejected because:
- The whitelist is a static Set used during analysis phase
- Would require two-pass analysis or deferred edge creation
- Mixes concerns: analysis phase shouldn't do enrichment-level reasoning

### 5.2 Extend CallbackCallResolver

Add the parameter invocation check inside CallbackCallResolver. Rejected because:
- CallbackCallResolver's current logic is focused on cross-file import chain traversal
- Adding a completely different strategy (body introspection) would make it a "god plugin"
- Separate plugin is cleaner and easier to test independently

### 5.3 Do It in Analysis Phase

Check parameter invocation during `analyzeFunctionBody`. Rejected because:
- Would require forward reference: when analyzing `apply(handler)`, we'd need to know `apply`'s body first
- Analysis processes one function at a time, can't look into other functions' bodies
- Enrichment phase is designed exactly for this: cross-function reasoning using the complete graph

---

## 6. Prior Art

Static analysis for higher-order function call resolution is a well-studied problem:

- **Call graph construction frameworks** (Grove et al., ACM TOPLAS 2001) describe parameterized algorithms for call graph construction with first-class functions, distinguishing between direct and indirect call targets.
- **"Call Me Maybe" (2025)** proposes using GNNs for JavaScript call graph augmentation, specifically targeting higher-order functions and dynamic property accesses.
- **Indirection-bounded call graph analysis** (Chakraborty, ECOOP 2024) formalizes the concept of tracking function values through bounded indirection levels, which is analogous to our single-level parameter check.

Our approach is a **zero-indirection** check: we only verify that the parameter itself is directly invoked (`fn()`), not that it flows through intermediate variables or calls. This is the simplest correct approximation and handles the most common HOF pattern.

---

## 7. Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| False positives from name collision (different `fn` in nested scope) | Medium | Low | Check `parentScopeId` strictly matches receiving function ID |
| Performance: too many candidates to check | Low | Low | Pre-build parentScopeId index in single pass |
| Breaks existing tests | Medium | Certain | Test 5 assertion needs intentional flip; all others should pass |
| Cross-file HOFs not resolved | Low | Medium | Follow CALLS edges from call site to imported function; works if CALLS edge exists |
| Complex invocation patterns missed (fn.call, alias, nested) | Low | Certain | Documented as known limitations; can be enhanced incrementally |

---

## 8. Recommended Implementation Order

1. **Kent: Write tests first** -- new test cases for parameter invocation check + flip test 5
2. **Rob: Implement ParameterInvocationResolver** -- new enrichment plugin
3. **Rob: Register plugin** -- ConfigLoader + index.ts
4. **Verify: All tests pass** -- both new and existing

**Estimated scope:** Small-medium. ~150-200 lines of new plugin code, ~50 lines of test changes. The algorithm is straightforward graph traversal with pre-built indexes.

---

## Sources

- [A framework for call graph construction algorithms (ACM TOPLAS)](https://dl.acm.org/doi/10.1145/506315.506316)
- [Call Me Maybe: Enhancing JavaScript Call Graph Construction using GNNs](https://arxiv.org/html/2506.18191)
- [Indirection-Bounded Call Graph Analysis (ECOOP 2024)](https://drops.dagstuhl.de/storage/00lipics/lipics-vol313-ecoop2024/LIPIcs.ECOOP.2024.10/LIPIcs.ECOOP.2024.10.pdf)
- [Interprocedural Analysis overview (ScienceDirect)](https://www.sciencedirect.com/topics/computer-science/interprocedural-analysis)
