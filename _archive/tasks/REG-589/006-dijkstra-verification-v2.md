# REG-589: Dijkstra Verification — Revised Plan (v2)

Verifier: Edsger Dijkstra
Date: 2026-03-01
Input: `005-don-revised-plan.md`

Principle: "I don't THINK it handles all cases — I PROVE it, by enumeration."

---

## Verification Scope

The original algorithm (CALLS edges, same-file) was verified in the previous round. This document focuses exclusively on the NEW scope items:

1. CALLS_ON discriminator
2. Rest parameter linking
3. Spread argument handling
4. Destructured parameter synthetic node approach
5. ISSUE nodes via ResolveResult.nodes
6. paramIndex on RECEIVES_ARGUMENT edges (instead of on PARAMETER nodes)

All findings are based on reading actual source code:
- `packages/core-v2/src/visitors/misc.ts`
- `packages/core-v2/src/visitors/expressions.ts`
- `packages/core-v2/src/visitors/declarations.ts`
- `packages/core-v2/src/visitors/classes.ts`
- `packages/core-v2/src/walk.ts`
- `packages/core-v2/src/resolve.ts`
- `packages/core-v2/src/edge-map.ts`
- `packages/core-v2/src/types.ts`

---

## Section 1: CALLS_ON Discriminator

### Claim Under Test

Plan Section 1.1 states: "For `obj.method(arg)`, two deferred refs are created — one `scope_lookup` for the object (→ VARIABLE) and one `call_resolve` for the method (→ METHOD node). The discriminator skips CALLS_ON edges where dst is VARIABLE."

### Code Evidence

Reading `expressions.ts` `visitCallExpression` lines 195-225:

```
} else if (call.callee.type === 'MemberExpression' ...) {
  const methodName = call.callee.property.name;

  // obj.method() — Use scope_lookup for same-file resolution of the object
  if (call.callee.object.type === 'Identifier') {
    result.deferred.push({
      kind: 'scope_lookup',
      name: call.callee.object.name,   // ← pushes the OBJECT name, not the method
      edgeType: 'CALLS_ON',
      ...
    });
  } else {
    // call_resolve for this.method(), super.method(), expr.method()
    result.deferred.push({
      kind: 'call_resolve',
      name: methodName,                 // ← pushes the METHOD name
      edgeType: 'CALLS_ON',
      ...
    });
  }
```

The two branches are MUTUALLY EXCLUSIVE. When the object is an Identifier (`obj.method()`), ONLY the scope_lookup for the object fires. There is NO call_resolve for the method name. When the object is NOT an Identifier (`this.method()`, `super.method()`, `expr().method()`), ONLY the call_resolve for the method name fires.

### Completeness Table: CALLS_ON Edge for Each Pattern

| Call pattern | Object type | Branch taken | CALLS_ON dst | dst node type |
|-------------|-------------|--------------|-------------|---------------|
| `obj.method(arg)` | Identifier | scope_lookup for `obj` | VARIABLE(obj) | VARIABLE |
| `this.method(arg)` | ThisExpression | call_resolve for `method` | METHOD(method) | METHOD |
| `super.method(arg)` | Super | call_resolve for `method` | METHOD(method) | METHOD |
| `getObj().method(arg)` | CallExpression | call_resolve for `method` | METHOD(method) | METHOD |
| `a.b.method(arg)` | MemberExpression | call_resolve for `method` | METHOD(method) | METHOD |
| `obj?.method(arg)` | Identifier (OptionalMemberExpression) | scope_lookup for `obj` | VARIABLE(obj) | VARIABLE |

### Finding 1 (CRITICAL ERROR in plan model)

The plan's Section 1.1 description is factually wrong. There are NOT two CALLS_ON edges for `obj.method(arg)`. There is exactly ONE CALLS_ON edge, and for Identifier-object calls it points to the VARIABLE, not the METHOD.

**Consequence:** For `obj.method(arg)` where `obj` is a local variable identifier, the CALLS_ON discriminator correctly skips the VARIABLE — but this means **no arg linking occurs for the most common method call pattern in JavaScript**. This is not a bug introduced by the plan, but it is an undocumented limitation.

**Consequence for test Tier 4:** The plan's test case `obj.method(arg)` → `class Foo { method(x) {} }` will produce ZERO ARG_BINDING edges. The test will fail unless rewritten to use `this.method(arg)` from within the class body.

### Finding 2: Discriminator logic is correct for edges that DO exist

For `this.method(arg)`, `super.method(arg)`, and chained-expression method calls, the CALLS_ON edge correctly points to a METHOD node. The discriminator (check dst type is METHOD/FUNCTION/GETTER/SETTER) correctly passes these. CONFIRMED.

### Finding 3: GETTER and SETTER in discriminator

Plan Section 3.2 includes GETTER and SETTER in the allowed set. Confirmed: `visitClassMethod` in classes.ts creates GETTER/SETTER nodes for `method.kind === 'get'/'set'`. These are callable. Including them is correct.

---

## Section 2: Rest Parameter Linking

### Claim Under Test

Plan Section 1.2: `visitRestElement` creates PARAMETER with `metadata: { rest: true }`. Walk engine creates `FUNCTION → RECEIVES_ARGUMENT → rest_PARAMETER` via EDGE_MAP.

### Verification of Facts

**Fact 2.1: `metadata.rest === true`**

Reading `misc.ts` lines 169-180: `visitRestElement` returns `{ nodes: [{ ..., metadata: { rest: true } }], ... }`. CONFIRMED.

**Fact 2.2: RECEIVES_ARGUMENT edge for RestElement params via EDGE_MAP**

EDGE_MAP entries (edge-map.ts lines 193-197):
```
'FunctionDeclaration.params': { edgeType: 'RECEIVES_ARGUMENT' },
'FunctionExpression.params': { edgeType: 'RECEIVES_ARGUMENT' },
'ArrowFunctionExpression.params': { edgeType: 'RECEIVES_ARGUMENT' },
'ClassMethod.params': { edgeType: 'RECEIVES_ARGUMENT' },
'ObjectMethod.params': { edgeType: 'RECEIVES_ARGUMENT' },
```

When the walk engine iterates `FunctionDeclaration.params` and encounters a RestElement, `visitRestElement` returns a non-empty `result.nodes`. Therefore the structural edge from walk.ts line 296-302 fires: `FUNCTION → RECEIVES_ARGUMENT → rest_PARAMETER`. CONFIRMED.

**Fact 2.3: paramIndex for RestElement — which path?**

For `FunctionDeclaration`, `visitFunctionDeclaration` in `declarations.ts` manually processes only `Identifier` params (lines 163-183): `for (const param of fn.params) { if (param.type === 'Identifier') { ... } }`. Non-Identifier params (RestElement, AssignmentPattern, ObjectPattern, ArrayPattern) are skipped by the manual loop. They rely on the EDGE_MAP structural path to produce RECEIVES_ARGUMENT edges.

After the plan's change to the walk engine array loop (change `for...of` to `for (let i...)`), the structural RECEIVES_ARGUMENT edge for a RestElement at index `k` will carry `metadata: { paramIndex: k }`. CONFIRMED — this is the correct path.

**Fact 2.4: ClassPrivateMethod.params missing from EDGE_MAP**

EDGE_MAP does NOT contain `ClassPrivateMethod.params`. Searching edge-map.ts confirms no entry. This means:
- For a private method `#foo(...rest)`, the RestElement is visited but the structural edge uses CONTAINS (the default), NOT RECEIVES_ARGUMENT.
- `visitClassPrivateMethod` (classes.ts lines 140-154) manually loops only Identifier params.

**Finding: Rest params (and all non-Identifier params) in ClassPrivateMethod do NOT get RECEIVES_ARGUMENT edges. They will not be discoverable by `targetToParams`. The plan does not address this gap.**

### Algorithm Correctness for Rest Params

Completeness table for `f(1, 2, 3)` calling `function f(...args)`:

| Step | args array | params array | restParamIndex | Action |
|------|-----------|--------------|----------------|--------|
| init | [{argIndex:0,dst:'1'},{argIndex:1,dst:'2'},{argIndex:2,dst:'3'}] | [{paramIndex:0,isRest:true,paramId:'args'}] | 0 | — |
| argIndex=0 | not spread | 0 >= 0 → rest | 0 | ARG_BINDING(args→1, argIndex=0) |
| argIndex=1 | not spread | 1 >= 0 → rest | 0 | ARG_BINDING(args→2, argIndex=1) |
| argIndex=2 | not spread | 2 >= 0 → rest | 0 | ARG_BINDING(args→3, argIndex=2) |

Result: 3 ARG_BINDING edges. CORRECT.

Completeness table for `f(a, b, c)` calling `function f(x, ...rest)`:

| argIndex | isSpread | argIndex < restParamIndex(1)? | Action |
|----------|---------|------------------------------|--------|
| 0 | no | yes (0<1) | ARG_BINDING(x→a) |
| 1 | no | no (1>=1) | restParam exists → ARG_BINDING(rest→b) |
| 2 | no | no (2>=1) | ARG_BINDING(rest→c) |

Result: x→a, rest→b, rest→c. CORRECT.

---

## Section 3: Spread Argument Handling

### Claim Under Test

Plan Section 1.3: spread arg appears as `PASSES_ARGUMENT → EXPRESSION(spread, name='spread')`. Detection: `argNode?.type === 'EXPRESSION' && argNode?.name === 'spread'`.

### Verification of Facts

**Fact 3.1: `visitSpreadElement` returns EXPRESSION(spread)**

Reading expressions.ts lines 1001-1017: `visitSpreadElement` returns exactly `{ nodes: [{ type: 'EXPRESSION', name: 'spread', ... }], ... }`. CONFIRMED.

**Fact 3.2: PASSES_ARGUMENT structural edge fires for SpreadElement**

EDGE_MAP: `'CallExpression.arguments': { edgeType: 'PASSES_ARGUMENT' }`. When the walk engine visits a SpreadElement in `call.arguments`, `visitSpreadElement` returns a non-empty `result.nodes`. Structural edge: `CALL → PASSES_ARGUMENT → EXPRESSION(spread)`. CONFIRMED.

**Fact 3.3: The EXPRESSION(spread) node has NO metadata fields set**

`visitSpreadElement` sets no metadata on the returned node. The `name === 'spread'` check is therefore the only discriminator. This is stable since `'spread'` is a reserved name in this context.

**Fact 3.4: Identifier args and SpreadElement interact correctly**

For `foo(a, ...arr, b)`:
- `a` is Identifier → explicit scope_lookup deferred (argIndex=0)
- `...arr` is SpreadElement → structural PASSES_ARGUMENT (argIndex=1, after plan change)
- `b` is Identifier → explicit scope_lookup deferred (argIndex=2)

With the plan's algorithm:
- argIndex=0: `a` — normal match
- argIndex=1: EXPRESSION(spread) — `hitSpread = true; break`
- argIndex=2: never reached (already broke)

CORRECT — args after spread are not linked.

### Algorithm Correctness: Spread Cases

| Case | Spread position | restParamIndex | Action | Correct? |
|------|----------------|----------------|--------|---------|
| `foo(...arr)` no rest param | 0 | Infinity | hitSpread=true, break | YES — no spurious binding |
| `foo(...arr)` with rest at 0 | 0 | 0 | argIndex===restParamIndex → ARG_BINDING(rest→spread_node); break | YES |
| `foo(a, ...arr)` rest at 1 | 1 | 1 | ARG_BINDING(x→a) then spread hits rest → ARG_BINDING(rest→spread_node) | YES |
| `foo(a, ...arr)` no rest | 1 | Infinity | ARG_BINDING(x→a), then hitSpread=true; break | YES |
| `foo(a, ...arr, b)` | 1 | Infinity | ARG_BINDING(x→a), hitSpread at 1, b never reached | YES |

**Finding 3.1: The condition `argIndex === restParamIndex` for linking spread to rest is overly restrictive.** If there are normal params before the rest param, and spread starts at exactly the rest's position, linking is correct. But consider `foo(a, ...arr)` calling `function foo(x, y, ...rest)` where rest is at paramIndex=2 and spread is at argIndex=1. The plan emits ARG_BINDING(x→a), then hits spread at argIndex=1. `argIndex(1) !== restParamIndex(2)` → no ARG_BINDING for the spread → hitSpread=true; break. This is correct — we cannot statically know which params the spread fills.

Algorithm is CORRECT for all enumerated cases.

**Finding 3.2: EXPRESSION(spread) node from `visitCallExpression` explicit deferreds**

The explicit deferred loop in `visitCallExpression` (lines 167-179) only fires for `arg.type === 'Identifier'`. SpreadElement is not an Identifier, so NO explicit deferred is created for spread args. They only go through the EDGE_MAP structural path. After the plan's walk engine change to add argIndex to PASSES_ARGUMENT, the EXPRESSION(spread) node will be associated with the correct argIndex. CONFIRMED.

---

## Section 4: Destructured Parameter Synthetic Node

### Claim Under Test

Plan Section 1.4 and Phase B, change 8: Add a synthetic PARAMETER node for ObjectPattern/ArrayPattern in param position. The existing `visitObjectPattern` and `visitArrayPattern` create individual binding PARAMETERs but no container.

### Verification of Existing Code

Reading `misc.ts` `visitObjectPattern` (lines 57-90): In param position (`isParam === true`), it creates individual PARAMETER nodes for each Identifier property binding. Returns them all in `result.nodes`. The walk engine creates a structural RECEIVES_ARGUMENT edge to `result.nodes[0]` only.

Reading `misc.ts` `visitArrayPattern` (lines 96-149): Similar — creates individual PARAMETER nodes. Walk engine structural RECEIVES_ARGUMENT to `result.nodes[0]` only.

### Finding 4.1: Existing RECEIVES_ARGUMENT for first binding only

For `function f({a, b})`:
- `visitObjectPattern` returns `result.nodes = [PARAMETER(a), PARAMETER(b)]`
- Walk engine structural edge: `FUNCTION → RECEIVES_ARGUMENT → PARAMETER(a)` (only first node)
- PARAMETER(b) has NO RECEIVES_ARGUMENT edge from FUNCTION

This confirms the plan's claim. The plan's fix — synthetic node for the whole pattern — is the correct approach.

### Finding 4.2: The synthetic node approach in pseudocode has a typo

Plan Section 4.8, line: `for (const prop of pattern.properties)` uses `pattern` but the function parameter is `node`. Should be `const pattern = node as ObjectPattern;` first (which is already there, so this is a pseudocode artifact, not a real bug).

### Finding 4.3: What happens to the individual binding PARAMETERs?

With the synthetic node approach, `result.nodes[0]` = synthetic PARAMETER(`{...}`). Individual bindings become `result.nodes[1], result.nodes[2], ...`. Walk engine structural RECEIVES_ARGUMENT fires to `result.nodes[0]` = synthetic node.

Individual binding PARAMETERs are emitted as nodes in `result.nodes[1...]`. They will be connected to the synthetic node via CONTAINS edges (explicitly emitted by the new visitObjectPattern code). They will also be declared in scope via `ctx.declare(name, 'param', bindId)`.

But will the walk engine create spurious structural edges for individual bindings? No — the structural edge fires only once, to `result.nodes[0]`. CONFIRMED.

### Finding 4.4: RECEIVES_ARGUMENT edge with paramIndex for synthetic node

The synthetic node is `result.nodes[0]`. The walk engine creates `FUNCTION → RECEIVES_ARGUMENT(paramIndex=i) → synthetic_node`. The linking algorithm finds this edge in `targetToParams` with `paramIndex=i` and `isDestructured=true`. The algorithm then emits `ARG_BINDING(synthetic_param → arg_at_i)`. CORRECT.

### Finding 4.5: Nested destructuring (not addressed in plan)

For `function f({a: {b, c}})`: the inner `{b, c}` is nested inside an ObjectProperty whose value is an ObjectPattern. The plan states: "Nested patterns (value is ObjectPattern/ArrayPattern) → walk engine visits as children."

In the new `visitObjectPattern` in param position, the loop only handles `prop.value.type === 'Identifier'`. For nested ObjectPattern (`prop.value.type === 'ObjectPattern'`), the plan says the walk engine visits them as children. However, the walk engine will visit `prop.value` (the inner ObjectPattern) with parent being the `ObjectProperty` node. `isParameterContext` checks if parent is a function node or AssignmentPattern or RestElement or ObjectPattern/ArrayPattern. Line 37-38 of misc.ts: `if (pt === 'ObjectPattern' || pt === 'ArrayPattern') return true;`. So the inner ObjectPattern IS visited in param context. It will create its own bindings.

But the walk engine visits `ObjectProperty.value` — what edge type? The EDGE_MAP has no entry for `ObjectProperty.value`, so it uses CONTAINS. The inner PARAMETER nodes will get `CONTAINS` edges, not `RECEIVES_ARGUMENT` edges. They will not be in `targetToParams`. This is acceptable — the plan documents that individual bindings are "out of scope for REG-589."

### Finding 4.6: TypeScript typed destructured params — `function f({a}: {a: string})`

The `: {a: string}` part is a TSTypeAnnotation on the ObjectPattern. `visitObjectPattern` does not process type annotations — it looks only at `pattern.properties`. The type annotation is a separate AST child (`ObjectPattern.typeAnnotation`), which the walk engine visits separately. This produces TYPE_REFERENCE nodes via the type annotation visitor. No conflict with the synthetic PARAMETER approach. ACCEPTABLE.

### Finding 4.7: AssignmentPattern wrapping an ObjectPattern — `function f({a} = {})`

AST: `params[0]` is an `AssignmentPattern` with `left: ObjectPattern`. `isParameterContext` for the ObjectPattern returns true (parent is AssignmentPattern → line 35). `visitObjectPattern` is invoked in param context. The synthetic node is created. The walk engine creates `FUNCTION → RECEIVES_ARGUMENT(paramIndex=i) → synthetic_node` via structural edge (since the AssignmentPattern wraps the ObjectPattern, the RECEIVES_ARGUMENT fires via `AssignmentPattern` being in `.params`).

Wait — actually `params[0]` is the `AssignmentPattern`. The EDGE_MAP fires for `FunctionDeclaration.params` → `visitAssignmentPattern`. `visitAssignmentPattern` for a non-Identifier left (`ap.left.type !== 'Identifier'`) returns EMPTY_RESULT (misc.ts line 193). So the structural RECEIVES_ARGUMENT edge does NOT fire for `{a} = {}` params because `visitAssignmentPattern` returns empty when left is not an Identifier.

**Finding 4.7 CONFIRMED BUG:** For `function f({a} = {})`, `visitAssignmentPattern` returns EMPTY_RESULT (line 193: `if (ap.left.type !== 'Identifier') return EMPTY_RESULT`). This means no PARAMETER node is created for the whole destructured+defaulted parameter, and no RECEIVES_ARGUMENT edge exists. This is a pre-existing limitation that the plan does not address. Acceptable as out-of-scope but must be documented.

### Summary: Destructured Param Approach

| Case | Synthetic node created? | RECEIVES_ARGUMENT edge? | Linkable? |
|------|------------------------|------------------------|---------|
| `f({a, b})` | YES (new code) | YES (walk engine) | YES |
| `f([a, b])` | YES (new code) | YES (walk engine) | YES |
| `f({a: {b}})` nested | Outer YES, inner handled by CONTAINS | YES for outer | PARTIAL |
| `f({a} = {})` destructured+default | NO (AssignmentPattern returns EMPTY) | NO | NO (pre-existing gap) |
| `f({a}: T)` TypeScript typed | YES, type annotation is separate child | YES | YES |

---

## Section 5: ISSUE Nodes via ResolveResult.nodes

### Claim Under Test

Plan Sections 1.5 and Phase C: Extend `ResolveResult` with `nodes: GraphNode[]`. Update `CoreV2Analyzer` to call `graph.addNodes(resolved.nodes)`.

### Verification

**Fact 5.1: Current ResolveResult interface**

Reading `resolve.ts` lines 317-333:
```ts
export interface ResolveResult {
  edges: GraphEdge[];
  unresolved: DeferredRef[];
  stats: { importResolved: number; callResolved: number; ... };
}
```

No `nodes` field exists. CONFIRMED — the extension is needed.

**Fact 5.2: `resolveProject` return at line 480**

```ts
return { edges, unresolved, stats };
```

No `nodes` in the return. Must be changed.

**Fact 5.3: Will CoreV2Analyzer accept and store the nodes?**

The plan proposes `graph.addNodes(resolved.nodes as InputNode[])`. The correctness depends on `InputNode` type compatibility with the ISSUE node format. In v1, ISSUE nodes have `type: 'issue:*'`. In core-v2, `GraphNode.type: string` (no enum restriction). The cast to `InputNode[]` may or may not be safe depending on what `InputNode` requires.

**Finding 5.1:** The plan does not verify that `InputNode` (the RFDB graph database input type) accepts `type: 'issue:unresolved-call'`. In core-v2, `GraphNode.type` is `string`, so TypeScript allows it. But the RFDB database may validate node types. This is an integration risk that needs verification at implementation time.

**Fact 5.4: Deterministic ISSUE node IDs**

Plan proposes: `id: 'issue:unresolved-call#' + callNode.id.replace(/[^a-z0-9]/gi, '')`.

The `callNode.id` format is `${file}->CALL->${name}#${line}`. After `.replace(/[^a-z0-9]/gi, '')` this strips all path separators, arrow characters, hash signs, and line numbers — potentially creating collisions if two call nodes have the same alphanumeric characters. Example: `src/a.ts->CALL->foo#10` and `src/ats->CALL->foo#10` would both strip to `srcatsCalls/foo10` (approximately).

**Finding 5.2 (BUG):** The ID sanitization regex `replace(/[^a-z0-9]/gi, '')` strips too much and may cause ID collisions. A safer approach is to use `callNode.id` directly as a suffix, possibly URL-encoded, or use a hash of the callNode.id. The plan's current regex is fragile.

**Fact 5.5: AFFECTS edge direction**

Plan: `{ src: issueId, dst: callNodeId, type: 'AFFECTS' }`. This reads "ISSUE AFFECTS CALL." This is consistent with v1 semantics where ISSUE nodes report on graph nodes. CONFIRMED correct direction.

**Fact 5.6: Where `resolveProject` can collect all CALL nodes**

`linkArgumentsToParameters` receives `results: FileResult[]`. Each `FileResult` has `nodes: GraphNode[]`. Finding CALL nodes with PASSES_ARGUMENT but no resolved CALLS: the function can iterate `results` to find CALL nodes, then check against the `resolvedCallIds` set. CONFIRMED as feasible.

**Fact 5.7: "Unresolved call" definition precision**

The plan: "CALL nodes that have at least one PASSES_ARGUMENT edge but do NOT appear in the resolved-call set."

A CALL node appears in the resolved-call set when it is the `src` of a CALLS or callable-CALLS_ON edge. A call like `obj.method(arg)` (Identifier object) produces ONLY a `CALLS_ON → VARIABLE` edge. The CALL node is NOT in the resolved-call set. So it would generate an `issue:unresolved-call` ISSUE node even though the method might be callable — just not linked in the current graph model.

**Finding 5.3 (SEMANTIC CONCERN):** `obj.method(arg)` calls will be flagged as "unresolved calls" even though they are legitimate JavaScript. This creates false-positive ISSUE nodes for the most common method call pattern. The plan should explicitly acknowledge this and filter out CALLS_ON calls from the "unresolved" check — a CALL with ANY CALLS_ON edge (even to a VARIABLE) should not be considered "unresolved" since the method dispatch was attempted but not fully resolved by the graph.

**Revised unresolved call criterion:** A call is "unresolved" if it has PASSES_ARGUMENT edges but has NEITHER a CALLS edge NOR any CALLS_ON edge. This avoids false positives for `obj.method(arg)` patterns.

---

## Section 6: paramIndex on RECEIVES_ARGUMENT Edges

### Claim Under Test

Plan Sections 3.7 and Phase B change 7: Move paramIndex from PARAMETER node metadata to RECEIVES_ARGUMENT edge metadata. This requires: (1) manual RECEIVES_ARGUMENT edges in function visitors get `metadata: { paramIndex: i }`, and (2) the walk engine's structural RECEIVES_ARGUMENT edge gets `metadata: { paramIndex: i }` via the array loop index.

### Verification

**Fact 6.1: Manual RECEIVES_ARGUMENT edges in function visitors**

`visitFunctionDeclaration` (declarations.ts lines 176): `result.edges.push({ src: nodeId, dst: paramId, type: 'RECEIVES_ARGUMENT' })`. No metadata currently. Needs `metadata: { paramIndex: i }`.

The loop at line 164: `for (const param of fn.params)` — uses `for...of`, no index. Must change to `for (let i = 0; i < fn.params.length; i++)`. CONFIRMED.

Same pattern in:
- `visitClassMethod` (classes.ts line 80): `for (const param of method.params)` → change needed
- `visitClassPrivateMethod` (classes.ts line 140): same
- `visitArrowFunctionExpression`, `visitFunctionExpression`, `visitObjectMethod` in expressions.ts — all need same change

**Fact 6.2: Walk engine structural path for non-Identifier params**

Walk.ts array loop (lines 376-384):
```ts
for (const item of val) {
  if (item && typeof item === 'object' && 'type' in item) {
    visit(item as Node, node, edgeSrc, childEdgeType);
  }
}
```

After the plan's change, this becomes:
```ts
for (let i = 0; i < val.length; i++) {
  const item = val[i];
  if (item && typeof item === 'object' && 'type' in item) {
    const childMetadata = childEdgeType === 'PASSES_ARGUMENT' ? { argIndex: i }
      : childEdgeType === 'RECEIVES_ARGUMENT' ? { paramIndex: i }
      : undefined;
    visit(item as Node, node, edgeSrc, childEdgeType, childMetadata);
  }
}
```

And the structural edge creation:
```ts
if (result.nodes.length > 0) {
  allEdges.push({ src: parentNodeId, dst: result.nodes[0].id, type: edgeType, metadata: edgeMetadata });
}
```

CONFIRMED — this correctly adds paramIndex to structural RECEIVES_ARGUMENT edges for RestElement, AssignmentPattern, ObjectPattern (synthetic node), ArrayPattern (synthetic node).

**Fact 6.3: The linking algorithm reads paramIndex from edge.metadata**

Plan Section 3.1: `targetToParams` is built from RECEIVES_ARGUMENT edges: `{ paramIndex: edge.metadata?.paramIndex, paramId: edge.dst }`.

For Identifier params (manually emitted RECEIVES_ARGUMENT with `metadata: { paramIndex: i }` after the change): `edge.metadata.paramIndex` = correct index.

For non-Identifier params (structural path): `edge.metadata.paramIndex` = correct index from the array loop.

This is consistent across ALL param types. CONFIRMED.

**Fact 6.4: HAS_BODY conflict in visitFunctionDeclaration**

Reading declarations.ts line 175: `result.edges.push({ src: nodeId, dst: paramId, type: 'HAS_BODY' })` is present for EACH parameter. This appears to be a copy-paste error in the existing code — each Identifier param gets BOTH a HAS_BODY edge AND a RECEIVES_ARGUMENT edge from the function. This is a pre-existing issue unrelated to the plan. The linking algorithm uses RECEIVES_ARGUMENT, so it is not affected. But it is worth noting.

**Fact 6.5: RECEIVES_ARGUMENT edge for `call_resolve` deferreds (CALLS_ON for this.method)**

For `this.method(arg)`, the CALLS_ON edge is emitted via `call_resolve`. `resolveCall` in resolve.ts finds a METHOD node. The `call_resolve` deferred produces `CALL → CALLS_ON → METHOD` edge (not CALLS_ON → PARAMETER). The linking algorithm uses CALLS and CALLS_ON edges to find the target function, then uses `targetToParams` (from RECEIVES_ARGUMENT edges) to find parameters. These are two separate index lookups. CONFIRMED correct separation.

**Fact 6.6: ClassPrivateMethod.params not in EDGE_MAP**

Edge-map.ts was searched: no `ClassPrivateMethod.params` entry. This means for private methods with non-Identifier params (rest, destructured), the walk engine uses CONTAINS as the default edge type. The `childMetadata` change would compute `childEdgeType === 'RECEIVES_ARGUMENT' ? { paramIndex: i } : undefined` — but since `childEdgeType` for ClassPrivateMethod's params array is CONTAINS (no EDGE_MAP override), `childMetadata` would be undefined. The structural edge is CONTAINS, not RECEIVES_ARGUMENT.

Fix: Add `'ClassPrivateMethod.params': { edgeType: 'RECEIVES_ARGUMENT' }` to EDGE_MAP. The plan omits this. **This is a bug in the plan.**

### Completeness Table: RECEIVES_ARGUMENT Coverage After Plan Changes

| Function type | Identifier params | Rest params | AssignmentPattern | ObjectPattern | ArrayPattern |
|--------------|------------------|-------------|-------------------|---------------|--------------|
| FunctionDeclaration | Manual + paramIndex | Structural + paramIndex | Structural + paramIndex | Structural (synthetic) + paramIndex | Structural (synthetic) + paramIndex |
| FunctionExpression | Manual + paramIndex | Structural + paramIndex | Structural + paramIndex | Structural (synthetic) + paramIndex | Structural (synthetic) + paramIndex |
| ArrowFunctionExpression | Manual + paramIndex | Structural + paramIndex | Structural + paramIndex | Structural (synthetic) + paramIndex | Structural (synthetic) + paramIndex |
| ClassMethod | Manual + paramIndex | Structural + paramIndex | Structural + paramIndex | Structural (synthetic) + paramIndex | Structural (synthetic) + paramIndex |
| ObjectMethod | Manual + paramIndex | Structural + paramIndex | Structural + paramIndex | Structural (synthetic) + paramIndex | Structural (synthetic) + paramIndex |
| ClassPrivateMethod | Manual + paramIndex | CONTAINS (BUG) | CONTAINS (BUG) | CONTAINS (BUG) | CONTAINS (BUG) |

---

## Section 7: Unaddressed Interactions

### 7.1: Stage 2.5 (resolveFileRefs) strips metadata from edges

Reading `resolve.ts` `resolveFileRefs` (lines 67-70):
```ts
newEdges.push({
  src: ref.fromNodeId,
  dst: target.id,
  type: ref.edgeType,
});
```

No `metadata` forwarding. If a PASSES_ARGUMENT deferred ref (for Identifier args) is resolved via Stage 2.5 (file-level name resolution for forward refs), the resulting edge has NO argIndex metadata.

**Finding 7.1 (BUG):** The plan specifies forwarding `ref.metadata` in Stage 2 (walk.ts scope_lookup resolver). But Stage 2.5 (`resolveFileRefs` in resolve.ts) also resolves scope_lookup refs and does NOT forward metadata. PASSES_ARGUMENT deferreds for Identifier args that are forward references (declared after the call in the same file) would be resolved by Stage 2.5 and lose their argIndex.

Must fix: `resolveFileRefs` must also forward `ref.metadata` when creating the new edge.

### 7.2: Stage 3 Project-level scope_lookup resolution

`resolveProject` Phase 1 handles `call_resolve`, `import_resolve`, `type_resolve`, and `alias_resolve` kinds. `scope_lookup` deferreds that reach Phase 1 are treated as unknown (line 440-444: `default: unresolved.push(ref)`). PASSES_ARGUMENT deferreds for Identifier args that survive Stage 2 and Stage 2.5 (truly not-found) end up in `unresolved`. They produce no PASSES_ARGUMENT edge. This is acceptable — truly unknown identifiers cannot be linked.

### 7.3: Optional spread `foo?.(...arr)`

`OptionalCallExpression.arguments` is in EDGE_MAP (edge-map.ts line 100). `visitSpreadElement` would fire. The PASSES_ARGUMENT with argIndex would be created. The discriminator for CALLS_ON/CALLS on optional calls: `OptionalCallExpression` creates a deferred `call_resolve` or `scope_lookup` with `edgeType: 'CALLS'` (same as regular calls). The linking algorithm iterates edges by type — it needs to include `CALLS` edges from `OptionalCallExpression` nodes, which resolve the same way. CONFIRMED — no issue since the CALLS edge is created the same way.

### 7.4: Duplicate RECEIVES_ARGUMENT edges for Identifier params in FunctionDeclaration

For `function f(x)`:
- `visitFunctionDeclaration` manually emits `FUNCTION → RECEIVES_ARGUMENT → PARAMETER(x)`
- Walk engine visits `fn.params` via EDGE_MAP: `visitIdentifier` returns EMPTY_RESULT → NO structural RECEIVES_ARGUMENT fires

So there is exactly one RECEIVES_ARGUMENT per Identifier param. CONFIRMED — no duplicates.

BUT for non-Identifier params, the function visitor does NOT manually emit RECEIVES_ARGUMENT. Only the structural path fires. If the walk engine is also made to emit for Identifier params via the structural path... wait, `visitIdentifier` returns EMPTY_RESULT (no nodes), so the structural edge at walk.ts line 296 (`if (result.nodes.length > 0)`) does NOT fire for Identifier params. The only RECEIVES_ARGUMENT for Identifier params comes from the manual emission. CONFIRMED.

---

## Section 8: Open Issues Requiring Answers Before Implementation

**CRITICAL (must fix before implementation):**

1. **Plan Finding 1.1 (CALLS_ON model error):** The plan's description of "two CALLS_ON edges" for `obj.method(arg)` is wrong. Only one CALLS_ON edge exists, pointing to the VARIABLE. The test Tier 4 (`obj.method(arg) → class Foo { method(x) }`) will produce zero ARG_BINDING edges. Test must be rewritten to use `this.method(arg)` from within the class, or the description corrected to document this gap.

2. **Finding 5.3 (false-positive ISSUE nodes):** `obj.method(arg)` calls will be flagged as "unresolved" because the CALL has CALLS_ON → VARIABLE (not METHOD). The unresolved-call criterion must be: "has PASSES_ARGUMENT AND has neither CALLS nor any CALLS_ON edge." Not "has PASSES_ARGUMENT AND not in resolvedCallIds."

3. **Finding 5.2 (ISSUE ID collision):** The regex `replace(/[^a-z0-9]/gi, '')` on callNode.id produces collisions. Use direct callNode.id as the suffix (it is already globally unique as a graph node ID).

4. **Finding 6.6 (ClassPrivateMethod.params missing from EDGE_MAP):** Must add `'ClassPrivateMethod.params': { edgeType: 'RECEIVES_ARGUMENT' }` to edge-map.ts. Without this, non-Identifier params in private methods do not get RECEIVES_ARGUMENT edges.

5. **Finding 7.1 (Stage 2.5 metadata loss):** `resolveFileRefs` in `resolve.ts` must forward `ref.metadata` when creating edges, same as the walk.ts Stage 2 fix. Otherwise, Identifier arguments that are forward references lose their argIndex.

**IMPORTANT (plan gaps, should be documented):**

6. The `obj.method(arg)` (Identifier object) call pattern is the most common method call in JavaScript and produces NO ARG_BINDING because the graph only has `CALL → CALLS_ON → VARIABLE`. The limitation is in the graph model, not the linking algorithm. Document this gap explicitly.

7. `ClassPrivateMethod` with non-Identifier params is unaddressed even after adding the EDGE_MAP entry, because `visitClassPrivateMethod` manually handles only Identifier params. Non-Identifier rest/destructured params in private methods will get structural RECEIVES_ARGUMENT (after adding EDGE_MAP entry) but paramIndex must be carried through the structural path correctly.

8. `function f({a} = {})` (destructured param with default) is not handled because `visitAssignmentPattern` returns EMPTY_RESULT when `ap.left.type !== 'Identifier'`. This is a pre-existing gap.

**ADVISORY (acceptable, document as known):**

9. Nested destructuring (`function f({a: {b}})`) is not linked to the call argument at the inner binding level. Only the outer synthetic node is linked. Acceptable per plan scope decision.

10. `new Foo(arg)` constructor args are not linked (target is CLASS which has no RECEIVES_ARGUMENT). Pre-existing gap, documented in plan.

---

## Verdict

**The revised plan is fundamentally sound in structure but contains five correctness defects that must be fixed before implementation.**

All five critical findings (1.1, 5.2, 5.3, 6.6, 7.1) are individually small fixes, but failure to address any of them would result in either incorrect behavior or missing data. The correctness of the rest param algorithm, spread arg stopping condition, and synthetic destructured node approach are all VERIFIED CORRECT for all enumerated cases.

The plan is APPROVED CONDITIONALLY pending resolution of the five critical findings above.
