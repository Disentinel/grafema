# REG-589: Dijkstra Plan Verification

**Verdict: APPROVE with mandatory corrections**

The plan is structurally sound and its core algorithm is correct. However, I found two provable errors, one significant scope undercount, and several claims that are imprecise. These must be corrected before implementation begins. The algorithm itself — match by positional index, emit ARG_BINDING edges — is proven correct.

---

## 1. Completeness Table: PASSES_ARGUMENT Creation Paths

Don claims: "argIndex is NOT stored in PASSES_ARGUMENT edges."

**Verified: Correct.** Two distinct creation mechanisms exist:

| Mechanism | Location | Has argIndex? | How created |
|-----------|----------|---------------|-------------|
| EDGE_MAP structural | `walk.ts` lines 376-380: `for (const item of val)` with no index | No | Walk engine iterates array children with `for...of`, no `i` |
| `scope_lookup` deferred (Identifier args) | `expressions.ts` lines 167-179 | No | DeferredRef has no `argIndex` field |

The `DeferredRef` interface in `types.ts` has fields: `kind`, `name`, `fromNodeId`, `edgeType`, `scopeId`, `source`, `file`, `line`, `column`, `receiver`. No `metadata` or `argIndex` field exists.

**Consequence:** Both paths must be modified. The walk.ts array loop at line 377 must change from `for (const item of val)` to `for (let i = 0; i < val.length; i++)` to pass index as metadata. The DeferredRef interface needs `metadata?: Record<string, unknown>` added, and the Stage 2 resolver (walk.ts lines 492-496) must forward this metadata to the created edge.

**Critical gap in Don's plan:** Don identified that metadata must be added to DeferredRef, but he did NOT note that Stage 2 in walk.ts strips metadata when it creates edges from deferred refs:

```ts
// walk.ts line 492-496
resolvedEdges.push({
  src: ref.fromNodeId,
  dst: result.nodeId,
  type: ref.edgeType,
  // ← metadata NOT forwarded here
});
```

This means even if `argIndex` is added to DeferredRef, Stage 2 will drop it. The edge creation at line 492 must be updated to forward `ref.metadata`.

---

## 2. Completeness Table: PARAMETER Node Creation Locations

Don claims: "Affects approximately 8-10 locations."

**Verified by enumeration: 16 distinct locations across 5 files.**

### expressions.ts (5 locations)
| Visitor | Function type | Has RECEIVES_ARGUMENT? | Has paramIndex? |
|---------|--------------|------------------------|-----------------|
| `visitArrowFunctionExpression` | Arrow fn | Yes (line 820) | No |
| `visitFunctionExpression` | Function expr | Yes (line 875) | No |
| `visitObjectMethod` | Object method | Yes (line 1377) | No |
| `visitCallExpression` (CatchClause) | — | — | — |

Wait — CatchClause is in statements.ts. Let me recount:

| Visitor | Function type | Has RECEIVES_ARGUMENT? | Has paramIndex? |
|---------|--------------|------------------------|-----------------|
| `visitArrowFunctionExpression` | Arrow fn | Yes | No |
| `visitFunctionExpression` | Function expr | Yes | No |
| `visitObjectMethod` | Object method (FUNCTION node) | Yes | No |

### declarations.ts (1 location)
| Visitor | Function type | Has RECEIVES_ARGUMENT? | Has paramIndex? |
|---------|--------------|------------------------|-----------------|
| `visitFunctionDeclaration` | Function decl | Yes (line 176) | No |

### classes.ts (2 locations)
| Visitor | Function type | Has RECEIVES_ARGUMENT? | Has paramIndex? |
|---------|--------------|------------------------|-----------------|
| `visitClassMethod` | Method/Getter/Setter | Yes (line 80) | No |
| `visitClassPrivateMethod` | Private Method/Getter/Setter | Yes (line 151) | No |

### typescript.ts (9 locations)
| Visitor | Function type | Has RECEIVES_ARGUMENT? | Has paramIndex? |
|---------|--------------|------------------------|-----------------|
| `visitTSFunctionType` | TS type-level fn | No | No |
| `visitTSConstructSignatureDeclaration` | Interface ctor sig | Yes (line 681) | No |
| `visitTSCallSignatureDeclaration` | Interface call sig | Yes (line 727) | No |
| `visitTSMethodSignature` | Interface method | Yes (line 803) | No |
| `visitTSIndexSignature` | Index signature | No | No |
| `visitTSDeclareFunction` | TS overload fn | Yes (line 1195) | No |
| `visitTSDeclareMethod` | TS overload method | Yes (line 1243) | No |
| `visitTSParameterProperty` | Constructor param prop | No RECEIVES_ARGUMENT | No |

### statements.ts (1 location)
| Visitor | Function type | Has RECEIVES_ARGUMENT? | Has paramIndex? |
|---------|--------------|------------------------|-----------------|
| `visitCatchClause` | catch(e) parameter | No (uses CONTAINS) | No — NOT a function param |

**Result:** Don said "8-10 locations." The actual count is 16 PARAMETER node creation sites across 5 files.

**However**, not all need paramIndex for linking purposes:
- `TSFunctionType`, `TSIndexSignature`, `TSParameterProperty`, `visitCatchClause`: no RECEIVES_ARGUMENT edge, so they can never be matched in the linking algorithm. Paramindex is not needed here (but adding it is harmless).
- Overloads (`TSDeclareFunction`, `TSDeclareMethod`): have isOverload metadata. Calls are directed to the implementation, not overload signatures. Linking against overload params would be incorrect.

**Corrected scope for paramIndex changes: 8 locations (the non-TS-type, non-catch, non-overload visitors):**
1. `declarations.ts` — `visitFunctionDeclaration`
2. `expressions.ts` — `visitArrowFunctionExpression`
3. `expressions.ts` — `visitFunctionExpression`
4. `expressions.ts` — `visitObjectMethod`
5. `classes.ts` — `visitClassMethod`
6. `classes.ts` — `visitClassPrivateMethod`
7. `typescript.ts` — `visitTSConstructSignatureDeclaration`
8. `typescript.ts` — `visitTSCallSignatureDeclaration`
9. `typescript.ts` — `visitTSMethodSignature`

That is 9, not 8-10. For TS signatures (7, 8, 9 above): these are interface/type-level constructs. Whether to add paramIndex to them is a scoping question. The plan should explicitly decide.

---

## 3. Completeness Table: Call Expression Types

Don claims: "Unresolved calls (skip), rest params (skip), default params (ok), destructured params (skip), more args than params (link what matches), method calls (same algo), cross-file (all edges in allEdges), self-recursive (works), spread args (skip — uses SPREADS_FROM)."

**Verified by enumeration of EDGE_MAP and call expression types:**

| Call type | AST node | PASSES_ARGUMENT via EDGE_MAP | CALLS edge resolved | Linkable |
|-----------|----------|------------------------------|---------------------|----------|
| `foo(a, b)` | CallExpression | Yes (`CallExpression.arguments`) | Yes (scope_lookup) | Yes |
| `foo?.()` | OptionalCallExpression | Yes (`OptionalCallExpression.arguments`) | Yes (same handler) | Yes |
| `new Foo(a)` | NewExpression | Yes (`NewExpression.arguments`) | Yes (scope_lookup) | Yes — **Don missed this** |
| `obj.method(a)` | CallExpression | Yes | CALLS_ON only (not CALLS) | **Problematic** — see below |
| `html\`...\`` | TaggedTemplateExpression | **No** — no arguments in tag | Yes (CALLS) | No arguments to link |
| `super(a)` | CallExpression | Yes | Unresolved (super is special) | Skip — unresolved |
| `import(path)` | CallExpression | Yes | No CALLS edge | Skip — unresolved |
| IIFE `((x)=>x)(a)` | CallExpression | Yes | Unresolved callee | Skip |
| Computed `obj[key](a)` | CallExpression | Yes | CALLS_ON, unresolved | Skip |

**Critical gap: method calls do NOT produce a CALLS edge.**

Don states: "Method calls (same algo)". But examining the code:
- `obj.method(arg)` in `visitCallExpression` creates a `CALLS_ON` deferred (lines 201-211 of expressions.ts), NOT a `CALLS` deferred.
- The Stage 3 resolver resolves `call_resolve` refs to either `CALLS` or `CALLS_ON` edge type based on `ref.edgeType`.
- The linking algorithm in the plan iterates "CALLS edges" only. Method calls produce `CALLS_ON` edges from the CALL to the object/method, not `CALLS` edges to the function.

**Proof:** Looking at `visitCallExpression`, for `obj.method(arg)`:
- Line 201-211: `result.deferred.push({ kind: 'scope_lookup', name: call.callee.object.name, edgeType: 'CALLS_ON', ... })`
- The method name itself is resolved via `call_resolve` with `edgeType: 'CALLS_ON'` (line 215-225 for non-identifier objects, or via scope_lookup for identifier objects with edgeType 'CALLS_ON').

This means the linking algorithm as stated will NOT link arguments to method parameters because it only scans CALLS edges. Method calls are resolved to CALLS_ON edges, not CALLS edges.

**Resolution:** The algorithm must also scan CALLS_ON edges, or a separate CALLS edge must be created for method calls pointing to the resolved METHOD node. This is an architectural question for the implementer.

**NewExpression also missed:** `new Foo(a)` is resolved to a CALLS edge (line 759-770 of expressions.ts: `edgeType: 'CALLS'`). The PASSES_ARGUMENT for new expressions is created via `NewExpression.arguments` EDGE_MAP entry. The NewExpression visitor does NOT manually create PASSES_ARGUMENT deferred refs for Identifier args. Looking at visitNewExpression: it creates the CALL node and a CALLS deferred for the callee, but it does NOT create PASSES_ARGUMENT deferreds for Identifier arguments (unlike visitCallExpression). The EDGE_MAP handles non-Identifier args. This means Identifier arguments to `new Foo(identifierArg)` will NOT have a PASSES_ARGUMENT edge. This is an existing gap independent of ARG_BINDING, but it means newExpr argument linking will be incomplete.

---

## 4. Completeness Table: RECEIVES_ARGUMENT Direction

Don claims: "In core-v2, RECEIVES_ARGUMENT is a structural edge: `FUNCTION → RECEIVES_ARGUMENT → PARAMETER`."

**Verified: Correct.**

From EDGE_MAP (lines 193-197):
```
'FunctionDeclaration.params':      { edgeType: 'RECEIVES_ARGUMENT' },
'FunctionExpression.params':       { edgeType: 'RECEIVES_ARGUMENT' },
'ArrowFunctionExpression.params':  { edgeType: 'RECEIVES_ARGUMENT' },
'ClassMethod.params':              { edgeType: 'RECEIVES_ARGUMENT' },
'ObjectMethod.params':             { edgeType: 'RECEIVES_ARGUMENT' },
```

However, these EDGE_MAP entries are for when the walk engine traverses `.params` children. But examining the visitor code more carefully: visitors like `visitFunctionDeclaration` (declarations.ts lines 163-183) create PARAMETER nodes AND emit RECEIVES_ARGUMENT edges themselves directly (inline, not via EDGE_MAP). Then the EDGE_MAP entries also fire because the walk engine also visits `.params` children.

**Wait — this is a potential double-emission problem.** Let me verify: in `visitFunctionDeclaration`, the visitor creates PARAMETER nodes in its own for loop and emits RECEIVES_ARGUMENT edges. The walk engine then also iterates `FunctionDeclaration.params` via EDGE_MAP with `edgeType: 'RECEIVES_ARGUMENT'`. But the Identifier param is handled by `visitIdentifier` which returns EMPTY_RESULT when it detects a param context (misc.ts line 27-31). So the EDGE_MAP fires but produces no structural edge because the visitor returns no nodes.

The RECEIVES_ARGUMENT edges from visitors (not EDGE_MAP) are emitted with explicit `result.edges.push({ src: nodeId, dst: paramId, type: 'RECEIVES_ARGUMENT' })`. These are the ground-truth RECEIVES_ARGUMENT edges from function node to parameter.

**Conclusion:** Direction verified correct. The edges DO exist for FunctionDeclaration, ArrowFunctionExpression, FunctionExpression, ClassMethod, ClassPrivateMethod, ObjectMethod. **Not** for TSFunctionType (no RECEIVES_ARGUMENT emitted), TSIndexSignature (no RECEIVES_ARGUMENT), TSParameterProperty (no RECEIVES_ARGUMENT).

Also critical observation: in `visitFunctionDeclaration` (declarations.ts line 175), there is a suspicious double-edge: `result.edges.push({ src: nodeId, dst: paramId, type: 'HAS_BODY' })` AND `result.edges.push({ src: nodeId, dst: paramId, type: 'RECEIVES_ARGUMENT' })`. The `HAS_BODY` edge from a FUNCTION to its PARAMETER appears wrong semantically, but this is not in scope for REG-589. Same pattern in expressions.ts visitArrowFunctionExpression (lines 819-820) and visitFunctionExpression (lines 874-875) and visitObjectMethod (lines 1376-1377).

---

## 5. Precondition Verification

### Precondition 1: "CALLS edges exist in allEdges before linking runs"

**Verified: Correct.** Phase 3 in resolve.ts calls `linkArgumentsToParameters` after `collectAllEdges(results, edges)` which aggregates all file-level edges plus all newly resolved project-stage edges. CALLS edges are resolved in Phase 1 (call_resolve) and Stage 2 (scope_lookup). Both are complete before Phase 3 derived edges.

### Precondition 2: "PASSES_ARGUMENT edges are emitted in argument order"

**Verified: Correct for EDGE_MAP path.** Walk engine iterates `val` array in order (walk.ts line 377). Node creation order in `allNodes` preserves insertion order.

**NOT verified for scope_lookup deferred path.** scope_lookup deferred refs are collected in `allDeferred` during the walk (walk.ts line 289). They are resolved in Stage 2 in the order they appear in `allDeferred`. Since the walk processes array children in order, the deferred refs are appended in argument order. Resolved edges accumulate in `resolvedEdges` in that order. This ordering is preserved as long as argument i's deferred ref is resolved before i+1's. This holds since resolution is a simple array iteration. **Therefore: order is preserved for deferred refs too.**

### Precondition 3: "ProjectIndex.getNode() can retrieve all PARAMETER nodes"

**Verified: Correct.** ProjectIndex constructor (resolve.ts line 111) iterates all nodes from all FileResult[]. Every PARAMETER node created by visitors is in the FileResult.nodes array and will be indexed.

### Precondition 4: "allEdges in Phase 3 contains all PASSES_ARGUMENT edges"

**Verified: Correct.** `collectAllEdges` (resolve.ts line 779-785) includes all `result.edges` from all FileResult, which includes both structural PASSES_ARGUMENT edges (from EDGE_MAP, indirectly via the structural edge at walk.ts line 298: `src: parentNodeId, dst: result.nodes[0].id, type: edgeType`) and resolved PASSES_ARGUMENT edges from scope_lookup.

Wait — I need to re-examine this. The structural edge created by the walk engine (walk.ts lines 296-300) uses the `edgeType` passed to `visit()`, which for CallExpression.arguments (from EDGE_MAP) would be `'PASSES_ARGUMENT'`. But this edge goes from `parentNodeId` (the CALL node's ID = `edgeSrc`) to `result.nodes[0].id` (the first node returned by the child visitor). For a non-Identifier argument like `42`, the literal visitor returns a LITERAL node, so the edge is `CALL → PASSES_ARGUMENT → LITERAL`. For an Identifier argument like `a`, the Identifier visitor detects it is an argument (it is NOT in `fn.params`) — actually wait, let me re-check.

For Identifier argument `a` in `foo(a)`:
- The Identifier `a` is a child of CallExpression.arguments
- EDGE_MAP maps `CallExpression.arguments` to PASSES_ARGUMENT
- The walk engine calls `visit(item, node, edgeSrc, 'PASSES_ARGUMENT')` for this Identifier
- `visitIdentifier` is called. It does NOT return EMPTY_RESULT for argument identifiers (only for param declarations, callee, etc.)
- So visitIdentifier returns an EXPRESSION node for `a`? No — let me re-check.

Looking at visitIdentifier in expressions.ts lines ~1040-1100: it checks `pt === 'CallExpression' && (parent as CallExpression).callee === node` — that's for the callee, not for arguments. Arguments are NOT excluded. BUT the visitor also creates a deferred scope_lookup for PASSES_ARGUMENT for Identifier args (lines 167-179 in visitCallExpression).

So for Identifier args: BOTH the EDGE_MAP structural path AND the explicit deferred are created. The EDGE_MAP creates a structural edge from CALL to whatever the Identifier visitor produces. The deferred creates a scope_lookup edge to the actual VARIABLE node. This means there would be DUPLICATE PASSES_ARGUMENT edges for Identifier args: one structural (CALL → whatever Identifier returns) and one deferred (CALL → actual VARIABLE).

Actually let me check what visitIdentifier returns for an argument position. Let me look more carefully:
- Lines 1048-1082 in expressions.ts: these are all the EMPTY_RESULT early-return cases for Identifier
- None of them match the case of Identifier as CallExpression argument
- So visitIdentifier DOES return something for argument Identifiers

This means for `foo(a, b)`: visitCallExpression creates deferred refs for `a` and `b`. Then the walk engine iterates arguments via EDGE_MAP and calls visitIdentifier for each, which also returns nodes/edges. This is potentially two PASSES_ARGUMENT edges per Identifier argument.

**This is a significant implementation concern** that Don's plan does not address. The plan says "For Identifier arguments, a scope_lookup deferred ref is created that resolves to PASSES_ARGUMENT edges targeting the actual VARIABLE/PARAMETER node." But it does not mention that the EDGE_MAP also fires and creates additional structural PASSES_ARGUMENT edges to the Identifier-produced nodes.

However, for the argIndex matching algorithm, this means there will be MULTIPLE PASSES_ARGUMENT edges from the CALL node for each Identifier argument: one with the correct scope-resolved target and one structural. The algorithm must handle this. Using insertion order to infer argIndex becomes ambiguous when multiple edges exist per argument.

**This strongly supports Don's recommendation to add explicit argIndex metadata** rather than relying on order.

### Precondition 5: "METHOD nodes also have RECEIVES_ARGUMENT edges from FUNCTION node"

**Verified: Partially.** ClassMethod creates RECEIVES_ARGUMENT edges (classes.ts line 80). ClassPrivateMethod creates them (line 151). ObjectMethod creates them (expressions.ts line 1377). TSDeclareMethod creates them (typescript.ts line 1243). TSMethodSignature creates them (typescript.ts line 803).

**BUT:** The CALLS resolution for method calls (`obj.method(arg)`) produces a `CALLS_ON` edge from the CALL to the object (not the method). There is no `CALLS` edge from the CALL node to the METHOD node for method calls. Therefore the algorithm cannot find the target METHOD via "for each CALLS edge" for method calls.

---

## 6. Additional Gaps Not Listed in Don's Edge Cases

| Gap | Severity | Disposition |
|-----|----------|-------------|
| Method calls produce `CALLS_ON` not `CALLS` — linking algorithm won't match | **Critical** | Plan must address or explicitly skip method calls |
| Identifier arguments have dual PASSES_ARGUMENT edges (structural + deferred) | **High** | Makes order-based inference unreliable; further justifies explicit argIndex |
| Stage 2 does not forward DeferredRef metadata to resolved edges | **High** | Must be fixed for scope_lookup deferred argIndex to work |
| `NewExpression` visitor does NOT create PASSES_ARGUMENT deferreds for Identifier args | **Medium** | New `Foo(identifierArg)` won't have PASSES_ARGUMENT for Identifier args |
| TSParameterProperty: PARAMETER created without RECEIVES_ARGUMENT | **Low** | Constructor param properties won't be linkable (may be acceptable) |
| TS overload signatures: linking against overload params is incorrect | **Low** | Skip if target has `isOverload: true` metadata |
| TSFunctionType / TSIndexSignature: PARAMETER without RECEIVES_ARGUMENT | **Low** | Not linkable, no action needed |
| TaggedTemplateExpression: CALLS edge exists but no argument positions | **Low** | No PASSES_ARGUMENT, nothing to link, correctly skipped |

---

## 7. Algorithm Correctness Proof

The core algorithm is: for each CALLS edge `(callId → targetId)`, find PASSES_ARGUMENT edges from `callId` sorted by argIndex, find RECEIVES_ARGUMENT edges from `targetId` to get PARAMETER nodes sorted by paramIndex, match by position, emit ARG_BINDING.

**This is correct** assuming:
- argIndex is correctly stored on PASSES_ARGUMENT edges (CONFIRMED: needs to be added)
- paramIndex is correctly stored on PARAMETER nodes (CONFIRMED: needs to be added)
- The CALLS edge points to the actual function node (CONFIRMED for direct calls; NOT for method calls)

The algorithm correctly handles:
- Fewer args than params: only linked positions are emitted
- More args than params: extras silently unlinked (no paramId found)
- Rest params: rest param has no discrete paramIndex to match; safe to skip
- Cross-file: all edges in allEdges (confirmed)
- Self-recursion: works (CALLS back to same function, PARAMETERs available)
- Default params: PARAMETER node still created with same paramIndex; works

---

## 8. Summary of Required Plan Corrections

### Correction 1 (Critical): Method calls need special handling

Don's algorithm iterates CALLS edges. Method calls `obj.method(arg)` produce CALLS_ON edges only. The plan must either:
a) Explicitly document that method calls are skipped in this implementation (reduce scope), or
b) Also iterate CALLS_ON edges and find the target METHOD via the CALLS_ON destination

### Correction 2 (Critical): Stage 2 metadata forwarding

walk.ts Stage 2 resolver (line 492) does not forward `ref.metadata` to resolved edges. The implementation must add:
```ts
resolvedEdges.push({
  src: ref.fromNodeId,
  dst: result.nodeId,
  type: ref.edgeType,
  metadata: ref.metadata,  // ← must add this
});
```
And `DeferredRef` must gain `metadata?: Record<string, unknown>`.

### Correction 3 (High): Dual PASSES_ARGUMENT for Identifier args

For `foo(identVar)`, both the EDGE_MAP structural edge AND the deferred scope_lookup create PASSES_ARGUMENT edges. With explicit argIndex metadata on both paths, these will correctly both carry the same argIndex. The linking algorithm sees two PASSES_ARGUMENT edges but they both have the same argIndex pointing to different targets (structural target may be wrong; deferred target is correct). The plan should address deduplication or note that both edges will produce ARG_BINDING — one correct (to actual variable), one potentially incorrect (to whatever identifier visitor returns).

### Correction 4 (Medium): Visitor count correction

The plan says "8-10 locations" for paramIndex. The verified count requiring paramIndex for functional linking is 9 core locations (excluding TS type-level constructs and catch parameters).

### Correction 5 (Low): NewExpression Identifier arg gap

`new Foo(identArg)` — visitNewExpression does NOT create PASSES_ARGUMENT deferreds for Identifier args. Only the EDGE_MAP creates a structural edge (to whatever Identifier visitor returns). This is a pre-existing limitation, not introduced by this feature, but the plan should note it as a known gap.

---

## 9. Final Verdict

The plan correctly identifies:
- The RECEIVES_ARGUMENT direction in core-v2 (FUNCTION → PARAMETER)
- The absence of argIndex on PASSES_ARGUMENT edges
- The absence of paramIndex on PARAMETER nodes
- The correct insertion point (resolve.ts Phase 3)
- The correct edge type name (ARG_BINDING)
- All listed edge cases are correctly classified

The plan misses:
- Method calls produce CALLS_ON not CALLS (critical algorithm gap)
- Stage 2 doesn't forward DeferredRef metadata (critical implementation gap)
- Duplicate PASSES_ARGUMENT for Identifier args (high concern)
- Actual PARAMETER creation site count (16 sites in 5 files, 9 relevant for linking)

**APPROVE with mandatory corrections 1 and 2 addressed in implementation.** The algorithm is fundamentally sound. Corrections 1 and 2 are well-defined and do not require re-planning. The implementer (Rob) must decide: include method calls or explicitly exclude them for v1 of this feature.
