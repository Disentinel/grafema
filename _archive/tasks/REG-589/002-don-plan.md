# REG-589: ArgumentParameterLinker for core-v2 — Don's Plan

## Summary of Findings

### How v1's ArgumentParameterLinker Works (core/src/plugins/enrichment/ArgumentParameterLinker.ts)

v1 is a post-analysis enrichment plugin that runs over a live RFDB graph:

1. Iterates all CALL nodes.
2. For each CALL: gets outgoing PASSES_ARGUMENT edges (with `argIndex` stored in edge metadata) and outgoing CALLS edge (to find the target function).
3. Gets the target function's PARAMETER nodes via HAS_PARAMETER edges. PARAMETERs have an `index` field.
4. Matches PASSES_ARGUMENT edges by `argIndex` → PARAMETER by `index`.
5. Creates two edges per match:
   - `PARAMETER → RECEIVES_ARGUMENT → argument_source` (with `callId`, `argIndex` metadata)
   - `PARAMETER → DERIVES_FROM → argument_source` (deduplicated across calls)

v1 uses RECEIVES_ARGUMENT as a **call-site binding** edge: PARAMETER → argument_source. It already has CALLS edges resolved before it runs.

### How core-v2 Currently Works

**Critical semantic difference:** In core-v2, RECEIVES_ARGUMENT is a **structural** edge used during walk (Stage 1):
- `FUNCTION → RECEIVES_ARGUMENT → PARAMETER`

This is the *inverse* of v1's use. In v1, `PARAMETER → RECEIVES_ARGUMENT → argument_source`. In core-v2, `FUNCTION → RECEIVES_ARGUMENT → PARAMETER` (function owns its params).

**PASSES_ARGUMENT in core-v2:**
- Created by the EDGE_MAP (`CallExpression.arguments → PASSES_ARGUMENT`), meaning for non-Identifier arguments (literals, nested calls), a `CALL → PASSES_ARGUMENT → <arg_node>` edge is created structurally during the walk.
- For Identifier arguments, a `scope_lookup` deferred ref is created that resolves to `PASSES_ARGUMENT` edges targeting the actual VARIABLE/PARAMETER node.
- **CRITICAL GAP: argIndex is NOT stored in PASSES_ARGUMENT edges.** The edge-map creates structural edges without positional metadata. The deferred refs also don't carry argIndex.

**PARAMETER nodes in core-v2:** Created in visitors (declarations.ts, expressions.ts, classes.ts, typescript.ts) without an `index` field in metadata.

**CALLS edges:** Resolved in Stage 2 (file-scope) via scope_lookup or Stage 3 (project-level) via resolveProject(). By the time resolveProject() completes, all resolvable CALLS edges exist.

### The New Edge Type Needed

The task requires a new edge type: `CALL → ARG_BINDING → PARAMETER` (or similar). This connects a call-site argument position to the parameter it maps to. The v1 approach of `PARAMETER → RECEIVES_ARGUMENT` conflicts with core-v2's use of RECEIVES_ARGUMENT as a structural function→parameter edge.

**Proposed new edge: `ARGUMENT_BOUND_TO`** (or check lang-spec for canonical name).

Actually, re-reading the ticket carefully: the ticket says "match PASSES_ARGUMENT edges from the CALL node with RECEIVES_ARGUMENT edges on the target FUNCTION". In core-v2, `RECEIVES_ARGUMENT` already is the `FUNCTION → PARAMETER` edge. So the positional linking connects:

```
CALL → PASSES_ARGUMENT → arg_node (at position i)
```
to:
```
FUNCTION → RECEIVES_ARGUMENT → PARAMETER (at position i)
```

The output should be a **new edge** linking `arg_node → LINKED_TO → PARAMETER` (positional binding). Looking at v1's design, the canonical edge for this is `PARAMETER → RECEIVES_ARGUMENT → arg_source` but that conflicts.

A clean new edge type for core-v2: **`ARG_BINDING`** with metadata `{ argIndex, callId }`. Direction: `CALL_NODE → ARG_BINDING → PARAMETER` or `PARAMETER → ARG_BINDING → arg_node`. Following v1 semantics: `PARAMETER → ARG_BINDING → arg_node`.

Wait — let me re-examine the lang-spec. The lang-spec already has both PASSES_ARGUMENT and RECEIVES_ARGUMENT. In core-v2, RECEIVES_ARGUMENT is repurposed. The cleanest approach that respects the existing semantics: create a **new derived phase** in resolveProject that creates `PASSES_ARGUMENT` edges with `{ argIndex, paramId }` metadata — this enriches the existing PASSES_ARGUMENT edges. But edges can't be enriched post-creation.

**Simplest correct design:** Add a new derived function `linkArgumentsToParameters` in resolve.ts that creates edges of type **`PASSES_ARGUMENT`** with `metadata: { argIndex, paramId, paramName }` — these are NEW edges alongside the existing structural PASSES_ARGUMENT edges (a second PASSES_ARGUMENT from CALL → PARAMETER directly).

Actually the cleanest, most consistent design matching v1 intent is: create `PARAMETER → ARG_BINDING → arg_node` edges with `{ argIndex, callId }` metadata. This matches v1's RECEIVES_ARGUMENT semantics without clobbering core-v2's structural use of RECEIVES_ARGUMENT.

**Final decision: new edge type `ARG_BINDING`**, directed `PARAMETER → ARG_BINDING → argument_source`, with metadata `{ argIndex: number, callId: string }`.

## Specific Changes Needed

### Problem 1: argIndex Not Stored on PASSES_ARGUMENT Edges

The walk engine's EDGE_MAP creates `CALL → PASSES_ARGUMENT → arg` edges without positional metadata. The `scope_lookup` deferred refs also don't carry argIndex. The algorithm must infer position from the order of PASSES_ARGUMENT edges on a CALL node.

**Solution:** Since `FileResult.nodes` and `FileResult.edges` are arrays that preserve insertion order, the PASSES_ARGUMENT edges from a CALL node are created in argument order (the walk engine visits array children in order). We can rely on the order of PASSES_ARGUMENT edges (sorted by their `dst` node's `line` + `column`, or more precisely, by insertion order) to infer argIndex.

However, insertion order is fragile. A safer design: **Add `argIndex` metadata to PASSES_ARGUMENT edges at creation time.**

This requires changes in:
1. `packages/core-v2/src/visitors/expressions.ts` — in visitCallExpression (and visitNewExpression, visitOptionalCallExpression if separate), add argIndex to the deferred `scope_lookup` ref metadata (need to extend DeferredRef) and to the EDGE_MAP structural edges.
2. `packages/core-v2/src/types.ts` — add optional `argIndex?: number` to DeferredRef.
3. `packages/core-v2/src/walk.ts` — when creating EDGE_MAP edges for array children, pass the array index as metadata.

OR: **Rely on positional order** — since PASSES_ARGUMENT edges are emitted in argument order and the walk engine processes array items in order, we can use the sorted-by-line/column approach. But this is fragile.

**Recommended: add argIndex to the walk engine for array-type children when EDGE_MAP specifies PASSES_ARGUMENT.** Specifically in walk.ts, when iterating an array child with a PASSES_ARGUMENT mapping, pass `metadata: { argIndex: i }` to the structural edge.

### Problem 2: PARAMETER Nodes Don't Have `index` Metadata

In core-v2, PARAMETER nodes lack an `index` field. They are created in visitor order (param[0] first, param[1] second, etc.) so we can use the order of `RECEIVES_ARGUMENT` edges from the function node to infer parameter positions.

**Solution:** Similar to argIndex for arguments — add `paramIndex` metadata to PARAMETER nodes at creation time in all visitors that create them.

OR: rely on insertion order of RECEIVES_ARGUMENT edges (function→parameter), which are emitted in parameter declaration order.

**Recommended: add `paramIndex` metadata to PARAMETER nodes** in all visitor functions that create them. This is explicit and robust.

### Files to Modify

**Phase A: Data enrichment (add positional metadata)**

1. **`packages/core-v2/src/types.ts`**
   - Add `argIndex?: number` to `DeferredRef` interface (for scope_lookup PASSES_ARGUMENT refs)
   - (Optional) Add `metadata?: Record<string, unknown>` to DeferredRef — already exists as optional fields

2. **`packages/core-v2/src/walk.ts`**
   - In the array-child iteration loop: when `mapping.edgeType === 'PASSES_ARGUMENT'`, add `metadata: { argIndex: i }` to the structural edge created
   - For scope_lookup deferred refs with edgeType PASSES_ARGUMENT, set `metadata.argIndex = i` via DeferredRef extension
   - When building resolved edges from scope_lookup, forward metadata from the DeferredRef to the resolved edge

3. **`packages/core-v2/src/visitors/expressions.ts`**
   - In visitCallExpression: the deferred `scope_lookup` refs for Identifier arguments need `argIndex`. The for loop over `call.arguments` already has the index.
   - Add `argIndex` to the deferred ref's metadata or as a new field on DeferredRef.

4. **Visitor files creating PARAMETER nodes:** `declarations.ts`, `expressions.ts`, `classes.ts`, `typescript.ts`
   - In each for loop over `fn.params` / `arrow.params` / `method.params`, use the loop index `i` to set `metadata: { paramIndex: i }` on PARAMETER nodes.
   - Affects approximately 8-10 locations.

**Phase B: Linking in resolve.ts**

5. **`packages/core-v2/src/resolve.ts`**
   - Add `argsLinked: number` to `ResolveResult.stats`
   - Add a new `linkArgumentsToParameters(results, allEdges, index)` function
   - Call it at the end of `resolveProject()` in Phase 3
   - Algorithm:
     ```
     for each CALLS edge in allEdges where src is a CALL node:
       callNode = index.getNode(callsEdge.src)
       targetNode = index.getNode(callsEdge.dst)

       // Get PASSES_ARGUMENT edges from this CALL node
       passesArgs = allEdges.filter(e => e.src === callId && e.type === 'PASSES_ARGUMENT')

       // Get RECEIVES_ARGUMENT edges from the target FUNCTION (these go FUNCTION → PARAMETER)
       receivesArgs = allEdges.filter(e => e.src === targetId && e.type === 'RECEIVES_ARGUMENT')

       // Build paramIndex → paramId map using PARAMETER nodes' paramIndex metadata
       paramsMap = Map<number, string>()
       for each receivesArgEdge:
         paramNode = index.getNode(receivesArgEdge.dst)
         if paramNode && paramNode.metadata?.paramIndex !== undefined:
           paramsMap.set(paramNode.metadata.paramIndex, paramNode.id)

       // For each PASSES_ARGUMENT edge, find matching parameter
       for each passesArgEdge:
         argIndex = passesArgEdge.metadata?.argIndex
         paramId = paramsMap.get(argIndex)
         if paramId exists:
           emit: { src: paramId, dst: passesArgEdge.dst, type: 'ARG_BINDING', metadata: { argIndex, callId: callsEdge.src } }
     ```

### New Edge Type: ARG_BINDING

- **Direction:** `PARAMETER → ARG_BINDING → argument_node`
- **Metadata:** `{ argIndex: number, callId: string }`
- **Semantics:** "This parameter, at position argIndex, receives this argument value when called from callId"
- Must be added to the lang-spec edge catalog (or kept as a v2-internal edge initially)

**Alternative consideration:** If the team prefers not adding a new edge type, the linking information could be stored as metadata on existing PASSES_ARGUMENT edges: enrich them with `{ argIndex, paramId }`. However this conflates two concerns and makes querying harder.

## Edge Cases to Handle

1. **Unresolved calls:** CALL nodes without a CALLS edge — skip silently.
2. **Variadic functions / rest parameters:** `function f(...args)` — rest params have no discrete `paramIndex` match. Skip or handle `isRest` with special paramIndex (e.g., -1 or the rest param's position for all remaining args).
3. **Default parameter values:** `function f(x = 5)` — the PARAMETER node exists regardless; argIndex still matches by position.
4. **Destructured parameters:** `function f({a, b})` — the param is a pattern, not an Identifier. Currently visitors skip non-Identifier params. Skip these in linking too.
5. **More arguments than parameters:** `foo(a, b, c)` called on `function foo(x)` — link only what matches; extras have no paramId.
6. **Method calls:** `obj.method(arg)` → CALLS edge points to a METHOD node. METHOD nodes also have RECEIVES_ARGUMENT → PARAMETER edges. Same algorithm works.
7. **Cross-file calls:** All CALLS edges (same-file Stage 2 + cross-file Stage 3) are present in `allEdges` at the time linking runs. The target PARAMETER nodes are in `index` (all file results are indexed). This works.
8. **Self-recursive calls:** Same function calling itself — CALLS edge points to the same FUNCTION; its PARAMETERs are in the index. Works normally.
9. **Spread arguments:** `foo(...args)` — SpreadElement creates a `SPREADS_FROM` edge from the CALL, not PASSES_ARGUMENT. Skip spread arguments in linking (no argIndex match possible).

## Test Strategy

### Unit Tests (new file: `packages/core-v2/test/arg-binding.test.mjs`)

Following the pattern of `element-of.test.mjs`:

**Tier 1: Direct function calls**
- `foo(a, b)` where `function foo(x, y)` is in same file → verify ARG_BINDING from x→a and y→b
- `foo(42)` where `function foo(x)` → verify ARG_BINDING from x→literal 42
- `foo(a, b, c)` where `function foo(x)` → only x→a linked, b and c have no binding

**Tier 2: Method calls**
- `obj.method(arg)` where `class Foo { method(x) {} }` → ARG_BINDING from x→arg
- `this.method(arg)` in class context → ARG_BINDING from x→arg (requires CALLS resolution)

**Tier 3: Cross-file (project-level)**
```js
// a.js: export function greet(name) {}
// b.js: import { greet } from './a.js'; greet(userName);
```
Verify ARG_BINDING from `name` PARAMETER → `userName` VARIABLE.

**Edge case tests**
- Rest parameters: `function f(...args)` called with `f(1, 2, 3)` — no ARG_BINDING for rest (or safe skip)
- More args than params: `foo(a, b)` called on `function foo(x)` — only x→a, no binding for b
- Arrow functions: `const fn = (x, y) => x + y; fn(a, b)` → ARG_BINDING x→a, y→b

### Golden Test Update

Add ARG_BINDING assertions to the existing golden test constructs. Specifically, add a test construct that exercises argument-parameter linking and verify it appears in the pipeline output via `verify-golden.mjs`.

Actually: the golden test (`verify-golden.mjs`) only checks that edge *types* appear in the corpus, not specific edges. The unit tests in `arg-binding.test.mjs` are the primary coverage. The smoke test (`smoke.mjs`) will automatically count ARG_BINDING edges.

Update `smoke.mjs` to include `ARG_BINDING: 0` in `LANG_SPEC_EDGES` so it tracks coverage.

## Implementation Order

1. Add `argIndex` metadata to PASSES_ARGUMENT edges (walk.ts + expressions.ts)
2. Add `paramIndex` metadata to PARAMETER nodes (all visitor files)
3. Add `linkArgumentsToParameters()` function to resolve.ts
4. Call it in resolveProject() Phase 3
5. Add `argsLinked: number` to ResolveResult.stats
6. Write `arg-binding.test.mjs` unit tests
7. Update `smoke.mjs` to track ARG_BINDING

## Scope Clarification

The ticket says "Add to resolve.ts post-file stage: for each resolved CALLS edge, match PASSES_ARGUMENT edges from the CALL node with RECEIVES_ARGUMENT edges on the target FUNCTION by position."

This confirms:
- Location: resolve.ts, in the Phase 3 derived-edges section
- Trigger: resolved CALLS edges
- Source of positional info for args: PASSES_ARGUMENT edges (need argIndex added to them)
- Source of positional info for params: RECEIVES_ARGUMENT edges pointing to PARAMETER nodes (need paramIndex on PARAMETERs)
- The new edges connect argument nodes to parameter nodes positionally

The only ambiguity is the new edge type name. Options:
1. Use `ARG_BINDING` (new, unambiguous)
2. Repurpose RECEIVES_ARGUMENT in an additive way (risky given current structural use)
3. Use `LINKS_ARG_TO_PARAM` or `BOUND_TO`

Recommend `ARG_BINDING` — concise, unambiguous, doesn't conflict.
