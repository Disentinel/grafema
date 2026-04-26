# REG-589: ArgumentParameterLinker — Revised Plan (Don Melton)

## What Changed from Previous Plan

This revision incorporates:
1. Dijkstra's corrections (two critical bugs: method-call algorithm gap, Stage 2 metadata strip)
2. User's six scope expansions: CALLS_ON, ISSUE nodes, rest params, extra-args ISSUE, spread args, destructured params

---

## Section 1: Graph Facts Confirmed by Investigation

### 1.1 How CALLS_ON Edges Work

For `obj.method(arg)`, two deferred refs are created in `visitCallExpression`:

| Deferred kind | name | edgeType | Resolves to |
|---------------|------|----------|-------------|
| `scope_lookup` | `obj` (the object identifier) | `CALLS_ON` | `CALL → CALLS_ON → obj_variable_node` |
| `call_resolve` | `method` (the method name) | `CALLS_ON` | `CALL → CALLS_ON → METHOD_node` |

For `this.method(arg)` inside a class, only the `call_resolve` ref is created (no object scope_lookup since `this` is not an Identifier). It resolves to `CALL → CALLS_ON → METHOD_node`.

**Key insight:** There are TWO CALLS_ON edges per method call, but only the one from `call_resolve` points to the METHOD node (which has RECEIVES_ARGUMENT → PARAMETER). The `scope_lookup` CALLS_ON points to the object variable, which has no RECEIVES_ARGUMENT edges.

**Algorithm for CALLS_ON:** In `linkArgumentsToParameters`, iterate CALLS_ON edges where the destination is a METHOD (or FUNCTION or GETTER/SETTER) node. Skip CALLS_ON edges where the destination is a VARIABLE (the object). This is the discriminator: check `index.getNode(edge.dst)?.type` — only proceed if type is METHOD, FUNCTION, GETTER, or SETTER.

### 1.2 How Rest Parameters Are Represented

`visitRestElement` in `misc.ts` creates a PARAMETER node with `metadata: { rest: true }`. The walk engine creates `FUNCTION → RECEIVES_ARGUMENT → rest_PARAMETER` via the EDGE_MAP structural mechanism (`FunctionDeclaration.params → RECEIVES_ARGUMENT`).

**Key insight:** Rest params DO have RECEIVES_ARGUMENT edges. They are discoverable by the linking algorithm. The PARAMETER node has `metadata.rest === true`.

**Rest param linking:** The rest param absorbs all arguments from position `paramIndex` to the end. If rest param is at index `k`, it should receive ARG_BINDING edges from all PASSES_ARGUMENT edges at positions `k, k+1, k+2, ...`. All those bindings point to the same rest PARAMETER node, each with their respective `argIndex`.

### 1.3 How Spread Arguments Are Represented

For `foo(...arr)`, the `SpreadElement` is in `call.arguments`. The EDGE_MAP fires:
- `CallExpression.arguments → PASSES_ARGUMENT` → `visitSpreadElement` returns `EXPRESSION(spread)` node
- So: `CALL → PASSES_ARGUMENT → EXPRESSION(spread, name='spread')`
- Then: `SpreadElement.argument → SPREADS_FROM` → `EXPRESSION(spread) → SPREADS_FROM → arr_variable`

**Key insight:** A spread argument appears as a PASSES_ARGUMENT edge to an EXPRESSION node named `'spread'` (not a VARIABLE/PARAMETER). It occupies one positional slot in the argument list. The actual array being spread is reachable via the SPREADS_FROM edge on that EXPRESSION node.

**Spread arg handling:** When we encounter a PASSES_ARGUMENT edge whose destination is an EXPRESSION node with `name === 'spread'`, we know it is a spread arg. We cannot statically determine how many params it fills. We should:
- Treat it as filling the rest param's slot if the target function has a rest param at this position
- Otherwise stop matching: a spread arg at position `k` prevents deterministic linking of params at positions `k` onwards (the spread could expand to 0 or N values)
- Still emit ARG_BINDING for already-matched params before the spread position

### 1.4 How Destructured Parameters Are Represented

Three variants:

**ObjectPattern param** (`function f({a, b})`): `visitObjectPattern` creates PARAMETER nodes for each property binding (`a`, `b`) when `isParam === true`. The structural edge from walk engine only connects the function to `result.nodes[0]` (the first binding). There is NO RECEIVES_ARGUMENT edge from the function to the ObjectPattern "as a whole" — it doesn't exist as a single node. The individual bindings (a, b) may or may not have RECEIVES_ARGUMENT edges depending on walk engine ordering.

**ArrayPattern param** (`function f([a, b])`): Same situation as ObjectPattern — multiple PARAMETER nodes created, structural edge only to first one.

**AssignmentPattern param** (`function f(x = 5)`): `visitAssignmentPattern` returns one PARAMETER node with `metadata: { hasDefault: true }`. Walk engine creates `FUNCTION → RECEIVES_ARGUMENT → param`. This case works normally with the linking algorithm.

**Key finding:** ObjectPattern and ArrayPattern params have an edge problem: the structural RECEIVES_ARGUMENT edge from walk engine only connects to `result.nodes[0]` (the first binding). The other bindings in the destructured pattern are orphaned from the function's RECEIVES_ARGUMENT chain. This means they cannot be discovered by "find all RECEIVES_ARGUMENT targets of this function."

**More critical finding:** For destructured params, what does "linking arg to param" mean? When `foo({name, age})` is called with `foo(userObj)`, we know arg 0 maps to the destructured pattern as a whole, not to individual bindings `name` or `age`. The graph representation stores individual PARAMETER nodes for each binding, not a single "objectPattern" PARAMETER node. The call passes a single argument at position 0.

**Conclusion:** Destructured params require a different strategy. The plan is:
- In visitor code: when `ObjectPattern` or `ArrayPattern` is in param position, create a "synthetic" PARAMETER node representing the whole destructured pattern (type `PARAMETER`, name `'{...}'` or `'[...]'`), with `metadata: { destructured: true, kind: 'object'|'array' }`, and emit `FUNCTION → RECEIVES_ARGUMENT → synthetic_param`. Then the individual binding PARAMETERs become children of this synthetic node via CONTAINS.
- The linking algorithm links the argument at position `k` to the synthetic PARAMETER node. Individual bindings are linked deeper (via `KEY_OF` / `ELEMENT_OF` semantics on the destructured param) but that is out of scope for REG-589.

**Scope decision:** Per the user's request "destructured parameters in scope", the minimum requirement is: when `foo(obj)` is called and `foo` has `function foo({a, b})`, emit an ARG_BINDING from the destructured param (represented as a synthetic PARAMETER node or the first binding) to the argument. The simplest safe approach is to add the synthetic PARAMETER node for ObjectPattern/ArrayPattern params so the RECEIVES_ARGUMENT chain is complete.

### 1.5 How ISSUE Nodes Work in core-v2

ISSUE nodes do NOT exist in core-v2's type system or in `resolveProject`. In v1, ISSUE nodes are created by validation plugins in the VALIDATION phase via `context.reportIssue()`. They live in the graph DB.

In core-v2's `ResolveResult`, only `edges` and `unresolved` are returned. There is no `nodes` field in `ResolveResult`. `CoreV2Analyzer` only calls `graph.addEdges(resolved.edges)`.

**To add ISSUE nodes from `resolveProject`:** `ResolveResult` must be extended with `nodes: GraphNode[]`. `CoreV2Analyzer` must call `graph.addNodes(resolved.nodes)` (or equivalent). The ISSUE node format follows `IssueNode` in v1: `type: 'issue:*'`, with `metadata.category`, `metadata.severity`, `metadata.message`.

In core-v2, `GraphNode` has `type: string` so `issue:unresolved-call` is valid as a node type without changing the schema.

**Minimum ISSUE format for core-v2:**
```ts
{
  id: `issue:unresolved-call#<callNodeId>`,  // deterministic from call node ID
  type: 'issue:unresolved-call',
  name: '<callee name> has unresolved arguments',
  file: callNode.file,
  line: callNode.line,
  column: callNode.column,
  metadata: {
    category: 'unresolved-call',
    severity: 'warning',
    callId: callNode.id,
    callee: callNode.name,
  }
}
```
Connected via `AFFECTS` edge: `issue_node → AFFECTS → call_node`.

**Alternative (simpler, no ResolveResult changes):** Store issue metadata directly on the CALL node as `metadata.issues` array. This requires no API changes to `CoreV2Analyzer`. However, this is not discoverable via standard ISSUE queries. Recommendation: extend `ResolveResult.nodes` properly.

---

## Section 2: Confirmed Corrections from Dijkstra (Mandatory)

### Correction 1 (Critical): Stage 2 metadata forwarding

In `walk.ts` line 492-496, the scope_lookup resolver creates edges without forwarding `ref.metadata`:

```ts
// Current (broken for argIndex):
resolvedEdges.push({
  src: ref.fromNodeId,
  dst: result.nodeId,
  type: ref.edgeType,
  // metadata NOT forwarded
});

// Fixed:
resolvedEdges.push({
  src: ref.fromNodeId,
  dst: result.nodeId,
  type: ref.edgeType,
  metadata: ref.metadata,
});
```

Also: `DeferredRef` in `types.ts` must gain `metadata?: Record<string, unknown>`.

### Correction 2 (High): Dual PASSES_ARGUMENT for Identifier args

For `foo(identVar)`, both the explicit `scope_lookup` deferred (from `visitCallExpression` lines 167-179) AND the EDGE_MAP structural visit create PASSES_ARGUMENT edges. With argIndex added to both paths, both edges carry the correct argIndex. The linking algorithm will produce two ARG_BINDING edges from the same PARAMETER to two different argument nodes. The deferred-resolved one points to the actual VARIABLE/PARAMETER node; the EDGE_MAP one points to whatever `visitIdentifier` returns (READS_FROM deferred, no node — actually for identifier args that are not in param context, visitIdentifier returns no NODES, only a deferred READS_FROM). So the structural EDGE_MAP path for Identifier args: walk engine calls `visit(arg, callExpr, callNodeId, 'PASSES_ARGUMENT')` for an Identifier, visitIdentifier returns `{ nodes: [], edges: [], deferred: [READS_FROM...] }` — NO nodes. Therefore the structural edge creation at walk.ts line 296-302 (`if (result.nodes.length > 0)`) does NOT fire. There is no duplicate structural PASSES_ARGUMENT for Identifier args.

This contradicts Dijkstra's concern. Let me verify: `visitIdentifier` for an argument identifier returns `{ nodes: [], edges: [], deferred: [READS_FROM...] }`. Since `result.nodes.length === 0`, the structural edge at line 297 is not created. So there is only ONE PASSES_ARGUMENT per Identifier arg (the explicit deferred in visitCallExpression). Dijkstra's concern about duplicates may not apply, but the explicit argIndex on the deferred is still needed.

For non-Identifier args (literals, sub-calls): EDGE_MAP fires, `visitLiteral` or `visitCallExpression` returns nodes, structural PASSES_ARGUMENT is created with argIndex metadata. No explicit deferred from visitCallExpression. One PASSES_ARGUMENT edge.

---

## Section 3: Updated Algorithm for linkArgumentsToParameters()

### 3.1 Data Collection

Build two indices from allEdges + allNodes:
1. **callToArgs**: `Map<callId, { argIndex: number, dst: string }[]>` — from PASSES_ARGUMENT edges, grouped by CALL node ID, sorted by argIndex.
2. **targetToParams**: `Map<targetFnId, { paramIndex: number, paramId: string, isRest: boolean, isDestructured: boolean }[]>` — from RECEIVES_ARGUMENT edges, grouped by FUNCTION/METHOD node ID, sorted by paramIndex.

### 3.2 Eligible CALLS/CALLS_ON Edges

Iterate all edges in allEdges. For each edge:
- Type is `CALLS` → ELIGIBLE
- Type is `CALLS_ON` → only if `index.getNode(edge.dst)?.type` is one of `METHOD`, `FUNCTION`, `GETTER`, `SETTER` → ELIGIBLE (this filters out obj-variable CALLS_ON)

Skip CALLS_ON where dst is VARIABLE, PARAMETER, CLASS, EXTERNAL, EXTERNAL_MODULE, or anything that is not a callable node type.

### 3.3 Matching Algorithm

For each eligible edge `(callId → targetId)`:

```
passesArgs = callToArgs.get(callId) sorted by argIndex
params = targetToParams.get(targetId) sorted by paramIndex

argBindings = []
issues = []

// Find rest param index if any
restParam = params.find(p => p.isRest)
restParamIndex = restParam ? restParam.paramIndex : Infinity

// Track if we hit a spread arg (prevents deterministic linking after it)
hitSpread = false

for (argIndex, argDst) of passesArgs:
  argNode = index.getNode(argDst)
  isSpread = argNode?.type === 'EXPRESSION' && argNode?.name === 'spread'

  if isSpread:
    // Try to link spread to rest param if it aligns
    if argIndex === restParamIndex && restParam:
      // Spread at rest param position → link spread node to rest param
      argBindings.push({ src: restParam.paramId, dst: argDst, type: 'ARG_BINDING', metadata: { argIndex, callId } })
    hitSpread = true
    break  // Stop deterministic linking after spread

  if hitSpread:
    break  // Should not happen (already broken), defensive

  if argIndex < restParamIndex:
    // Normal param match
    param = params.find(p => p.paramIndex === argIndex)
    if param:
      argBindings.push({ src: param.paramId, dst: argDst, type: 'ARG_BINDING', metadata: { argIndex, callId } })
  else:
    // argIndex >= restParamIndex → goes to rest param
    if restParam:
      argBindings.push({ src: restParam.paramId, dst: argDst, type: 'ARG_BINDING', metadata: { argIndex, callId } })
    else:
      // Extra arg with no rest param → issue
      issues.push(makeExtraArgIssue(callId, argIndex, argDst, targetId))

// Check for unresolved call (has PASSES_ARGUMENT but no resolved target params)
// This is checked at the CALL level, before we even get here (see Section 3.4 below)
```

### 3.4 Unresolved Call ISSUE

After collecting all CALLS and CALLS_ON edges that were resolved, build a set of resolved call IDs. Then iterate all CALL nodes that have at least one PASSES_ARGUMENT edge but do NOT appear in the resolved-call set. For each such unresolved call:

```
issueId = 'issue:unresolved-call#' + callNode.id.replace(/[^a-z0-9]/gi, '')
issue = {
  id: issueId,
  type: 'issue:unresolved-call',
  name: `Unresolved call to '${callNode.name}'`,
  file: callNode.file,
  line: callNode.line,
  column: callNode.column ?? 0,
  metadata: {
    category: 'unresolved-call',
    severity: 'warning',
    callId: callNode.id,
    callee: callNode.name,
  }
}
affectsEdge = { src: issueId, dst: callNode.id, type: 'AFFECTS' }
```

### 3.5 Extra Args ISSUE

When argIndex >= restParamIndex and no rest param exists:

```
issueId = 'issue:extra-argument#' + callNodeId + '#' + argIndex
issue = {
  id: issueId,
  type: 'issue:extra-argument',
  name: `Extra argument at position ${argIndex} in call to '${calleeName}'`,
  file: callNode.file,
  line: callNode.line,
  column: callNode.column ?? 0,
  metadata: {
    category: 'extra-argument',
    severity: 'info',
    callId: callNodeId,
    argIndex,
    paramCount: params.length,
  }
}
affectsEdge = { src: issueId, dst: callNodeId, type: 'AFFECTS' }
```

---

## Section 4: Complete File Changes

### Phase A: Types and Walk Engine

#### 1. `packages/core-v2/src/types.ts`

Add `metadata?: Record<string, unknown>` to `DeferredRef`:
```ts
export interface DeferredRef {
  // ... existing fields ...
  /** Optional metadata to forward to the resolved edge */
  metadata?: Record<string, unknown>;
}
```

#### 2. `packages/core-v2/src/walk.ts`

**Change 1** — Array child loop: add argIndex to PASSES_ARGUMENT edges

In the array iteration loop (around line 377), change from `for (const item of val)` to:
```ts
for (let i = 0; i < val.length; i++) {
  const item = val[i];
  if (item && typeof item === 'object' && 'type' in item) {
    // Pass argIndex in metadata for PASSES_ARGUMENT edges
    const childMetadata = childEdgeType === 'PASSES_ARGUMENT' ? { argIndex: i } : undefined;
    visit(item as Node, node, edgeSrc, childEdgeType, childMetadata);
  }
}
```

Update `visit` signature to accept optional `metadata`:
```ts
function visit(
  node: Node,
  parent: Node | null,
  parentNodeId: string,
  edgeType: string = 'CONTAINS',
  edgeMetadata?: Record<string, unknown>,
): void
```

And in the structural edge creation (lines 296-302):
```ts
if (result.nodes.length > 0) {
  allEdges.push({
    src: parentNodeId,
    dst: result.nodes[0].id,
    type: edgeType,
    metadata: edgeMetadata,  // forward argIndex for PASSES_ARGUMENT
  });
}
```

**Change 2** — Stage 2 scope_lookup resolver: forward `ref.metadata` to resolved edge

At the resolved edge push (around line 492):
```ts
resolvedEdges.push({
  src: ref.fromNodeId,
  dst: result.nodeId,
  type: ref.edgeType,
  metadata: ref.metadata,  // forward argIndex for PASSES_ARGUMENT deferreds
});
```

#### 3. `packages/core-v2/src/visitors/expressions.ts`

In `visitCallExpression`, the explicit `scope_lookup` deferred for Identifier arguments (lines 167-179) must carry `argIndex`:

```ts
for (let i = 0; i < call.arguments.length; i++) {
  const arg = call.arguments[i];
  if (arg.type === 'Identifier') {
    result.deferred.push({
      kind: 'scope_lookup',
      name: arg.name,
      fromNodeId: nodeId,
      edgeType: 'PASSES_ARGUMENT',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line: arg.loc?.start.line ?? line,
      column: arg.loc?.start.column ?? 0,
      metadata: { argIndex: i },  // ← ADD THIS
    });
  }
}
```

### Phase B: Parameter Node Changes

#### 4. `packages/core-v2/src/visitors/declarations.ts`

In `visitFunctionDeclaration`, add `paramIndex` to PARAMETER nodes:

```ts
for (let i = 0; i < fn.params.length; i++) {
  const param = fn.params[i];
  if (param.type === 'Identifier') {
    const paramId = ctx.nodeId('PARAMETER', param.name, param.loc?.start.line ?? line);
    result.nodes.push({
      id: paramId,
      type: 'PARAMETER',
      name: param.name,
      file: ctx.file,
      line: param.loc?.start.line ?? line,
      column: param.loc?.start.column ?? 0,
      metadata: { paramIndex: i },  // ← ADD THIS
    });
    // ... rest of param handling unchanged
  }
}
```

#### 5. `packages/core-v2/src/visitors/expressions.ts`

Same pattern for `visitArrowFunctionExpression`, `visitFunctionExpression`, `visitObjectMethod` — add `paramIndex: i` to PARAMETER node metadata. Change `for (const param of fn.params)` to `for (let i = 0; i < fn.params.length; i++)` in each.

#### 6. `packages/core-v2/src/visitors/classes.ts`

Same pattern for `visitClassMethod` and `visitClassPrivateMethod`.

#### 7. `packages/core-v2/src/visitors/misc.ts` — `visitRestElement`

Add `paramIndex` metadata. But `visitRestElement` does not receive the position `i`. It only has access to `node` (the RestElement itself) and `parent`.

**Problem:** The walk engine visits `.params` as an array, but each element is visited independently — `visitRestElement` does not know its index in the array.

**Solution A:** Change `visitRestElement` to use the parent AST node's `.params` array to find its own index:
```ts
const parentParams = (parent as { params?: Node[] }).params;
const paramIndex = parentParams ? parentParams.indexOf(node) : -1;
```

**Solution B:** Add paramIndex to the structural edge metadata (walk engine knows the index). Then in `linkArgumentsToParameters`, get paramIndex from the RECEIVES_ARGUMENT edge metadata instead of the PARAMETER node metadata.

**Recommendation: Solution B** — metadata on the RECEIVES_ARGUMENT edge. This way the walk engine naturally carries the index, and visitors don't need to infer position from parent. The walk engine already has `i` in the array loop. Emit structural edge with `metadata: { paramIndex: i }` for RECEIVES_ARGUMENT edges (similar to how argIndex is added to PASSES_ARGUMENT).

Generalize the approach: for BOTH `PASSES_ARGUMENT` and `RECEIVES_ARGUMENT` array edges, the walk engine emits `{ argIndex: i }` or `{ paramIndex: i }` respectively. Update the walk engine condition:

```ts
const childMetadata = childEdgeType === 'PASSES_ARGUMENT' ? { argIndex: i }
  : childEdgeType === 'RECEIVES_ARGUMENT' ? { paramIndex: i }
  : undefined;
```

This eliminates the need to add `paramIndex` to PARAMETER nodes in visitor files entirely. The index is carried on the edge, not the node. **This simplifies the implementation significantly.**

**Revised approach for paramIndex:** Remove the plan to add `paramIndex` to PARAMETER nodes. Instead, carry `paramIndex` as metadata on `RECEIVES_ARGUMENT` edges (emitted by the walk engine for `.params` array children). The linking algorithm reads `edge.metadata?.paramIndex` from the RECEIVES_ARGUMENT edge instead of `paramNode.metadata?.paramIndex`.

This also automatically handles RestElement, AssignmentPattern, ObjectPattern, ArrayPattern — any node returned by any visitor for a `.params` child will get its RECEIVES_ARGUMENT edge annotated with `paramIndex: i`.

**But wait:** For Identifier params, `visitIdentifier` returns EMPTY_RESULT → no structural RECEIVES_ARGUMENT edge from walk engine. The function visitor manually emits RECEIVES_ARGUMENT. Those manually emitted edges have NO paramIndex metadata. This is the conflict.

**Resolution:** Keep paramIndex on PARAMETER nodes for Identifier params (existing manual RECEIVES_ARGUMENT edges) AND also emit paramIndex on the structural RECEIVES_ARGUMENT edges from the walk engine (for RestElement, ObjectPattern, etc.). The linking algorithm checks EITHER the node metadata OR the edge metadata for paramIndex.

Actually, cleaner: in the function visitors (declarations.ts, expressions.ts, classes.ts), update the manual `RECEIVES_ARGUMENT` edge emission to include `metadata: { paramIndex: i }`:
```ts
result.edges.push({ src: nodeId, dst: paramId, type: 'RECEIVES_ARGUMENT', metadata: { paramIndex: i } });
```

And in the walk engine, emit `metadata: { paramIndex: i }` on structural RECEIVES_ARGUMENT edges for non-Identifier params. Then ALL RECEIVES_ARGUMENT edges carry `paramIndex`. The linking algorithm reads `receivesArgEdge.metadata?.paramIndex`.

**Final decision: paramIndex on all RECEIVES_ARGUMENT edges** (both manual and structural). No changes to PARAMETER node metadata needed.

#### 8. `packages/core-v2/src/visitors/misc.ts` — `visitObjectPattern` and `visitArrayPattern` as params

**Problem:** When `function f({a, b})` is called, there is no single PARAMETER node representing the whole destructured pattern. `visitObjectPattern` creates PARAMETER nodes for each binding (`a`, `b`). The walk engine creates ONE structural RECEIVES_ARGUMENT edge to `result.nodes[0]` (which is the node for binding `a`). The binding `b` has no RECEIVES_ARGUMENT edge from the function.

**Required change:** Add a synthetic "container" PARAMETER node for the destructured pattern as a whole. This node represents the argument slot. Its individual bindings become children.

In `visitObjectPattern`:
```ts
export function visitObjectPattern(node, parent, ctx): VisitResult {
  const isParam = isParameterContext(node, parent);

  if (isParam) {
    // In param position: create a synthetic PARAMETER node for the whole pattern
    const line = node.loc?.start.line ?? 0;
    const patternId = ctx.nodeId('PARAMETER', '{...}', line);
    const result: VisitResult = {
      nodes: [{
        id: patternId,
        type: 'PARAMETER',
        name: '{...}',  // placeholder name indicating destructured object pattern
        file: ctx.file,
        line,
        column: node.loc?.start.column ?? 0,
        metadata: { destructured: true, kind: 'object' },
      }],
      edges: [],
      deferred: [],
    };
    // Walk engine creates FUNCTION → RECEIVES_ARGUMENT → patternId (structural edge)
    // The individual bindings are children of patternId via CONTAINS
    for (const prop of pattern.properties) {
      if (prop.type === 'ObjectProperty' && prop.value.type === 'Identifier') {
        const name = prop.value.name;
        const bindLine = prop.value.loc?.start.line ?? line;
        const bindId = ctx.nodeId('PARAMETER', name, bindLine);
        result.nodes.push({
          id: bindId, type: 'PARAMETER', name,
          file: ctx.file, line: bindLine, column: prop.value.loc?.start.column ?? 0,
        });
        result.edges.push({ src: patternId, dst: bindId, type: 'CONTAINS' });
        ctx.declare(name, 'param', bindId);
      }
    }
    return result;
  }

  // Non-param case: existing VARIABLE logic unchanged
  // ...existing code...
}
```

Same approach for `visitArrayPattern` in param position: synthetic PARAMETER node `[...]` with `metadata: { destructured: true, kind: 'array' }`, individual element PARAMETERs as CONTAINS children.

**NOTE:** This is a meaningful behavior change that the linking algorithm can then use: `CALL → PASSES_ARGUMENT(argIndex=k) → userObj` AND `FUNCTION → RECEIVES_ARGUMENT(paramIndex=k) → PARAM({...})`. `linkArgumentsToParameters` emits `PARAM({...}) → ARG_BINDING → userObj`. The individual bindings are not directly linked to the call argument — linking to the individual bindings is a deeper data-flow concern beyond this ticket.

### Phase C: resolve.ts Changes

#### 9. `packages/core-v2/src/resolve.ts`

**9.1 Extend `ResolveResult`:**
```ts
export interface ResolveResult {
  nodes: GraphNode[];   // ← NEW field (ISSUE nodes, etc.)
  edges: GraphEdge[];
  unresolved: DeferredRef[];
  stats: {
    // ... existing stats ...
    argsLinked: number;     // ← NEW
    unresolvedCallIssues: number;  // ← NEW
    extraArgIssues: number;        // ← NEW
  };
}
```

**9.2 Add `linkArgumentsToParameters` function:**

```ts
function linkArgumentsToParameters(
  results: FileResult[],
  allEdges: GraphEdge[],
  index: ProjectIndex,
): { edges: GraphEdge[], nodes: GraphNode[], argsLinked: number, unresolvedCallIssues: number, extraArgIssues: number }
```

This function:
1. Builds `callToArgs` map: for each PASSES_ARGUMENT edge, group by `src` (call node ID), record `{ argIndex: edge.metadata?.argIndex, dst: edge.dst }`. Filter out edges without argIndex (these are degenerate — should not exist after the changes to walk.ts and visitCallExpression).
2. Builds `targetToParams` map: for each RECEIVES_ARGUMENT edge in allEdges, group by `src` (function node ID), record `{ paramIndex: edge.metadata?.paramIndex, paramId: edge.dst }`. Get `isRest` and `isDestructured` from the param node's metadata.
3. Builds `resolvedCallIds` set: all CALL node IDs that are the `src` of a CALLS or callable-CALLS_ON edge.
4. Iterates all eligible edges (CALLS + callable CALLS_ON), runs the matching algorithm, emits ARG_BINDING edges.
5. Detects unresolved calls (CALL nodes with PASSES_ARGUMENT but not in resolvedCallIds) → emits ISSUE nodes + AFFECTS edges.
6. Returns all results.

**9.3 Call it in `resolveProject`:**

At the end of Phase 3 (derived edges):
```ts
const argLinks = linkArgumentsToParameters(results, [...allEdges, ...derivesFromEdges, ...instanceOfEdges], index);
edges.push(...argLinks.edges);
// collect nodes for ISSUE nodes:
resolveNodes.push(...argLinks.nodes);
stats.argsLinked = argLinks.argsLinked;
stats.unresolvedCallIssues = argLinks.unresolvedCallIssues;
stats.extraArgIssues = argLinks.extraArgIssues;
```

**9.4 Update `CoreV2Analyzer.ts`:**

After calling `resolveProject`:
```ts
const resolved = resolveProject(fileResults, builtins, packageMap);

// Add ISSUE nodes from linking phase
if (resolved.nodes && resolved.nodes.length > 0) {
  await graph.addNodes(resolved.nodes as InputNode[]);
  totalNodes += resolved.nodes.length;
}
if (resolved.edges.length > 0) {
  // ... existing edge add code ...
}
```

---

## Section 5: Edge Cases and Handling

| Case | Handling |
|------|----------|
| Direct call `foo(a, b)` resolved via CALLS | Link by argIndex: a→param0, b→param1 |
| Method call `obj.method(a)` resolved via CALLS_ON (call_resolve → METHOD) | Link by argIndex: a→param0 |
| `this.method(a)` in class via CALLS_ON (call_resolve) | Same |
| `obj.method(a)` via CALLS_ON (scope_lookup → VARIABLE) | Skip: dst is VARIABLE, not callable |
| Unresolved call with PASSES_ARGUMENT | Create issue:unresolved-call ISSUE node |
| Unresolved call without PASSES_ARGUMENT | Skip (no interesting issue — no args to link) |
| Rest param `function f(...args)` at index k | Link args at index k, k+1, k+2... all to rest PARAMETER |
| More args than params (no rest) | Link up to paramCount-1; issue:extra-argument for extras |
| Spread arg `foo(...arr)` | Link spread EXPRESSION node to rest param if spread lands at rest position; stop deterministic linking after spread |
| Spread + no rest param at spread position | Stop linking; no issue (spread count is unknowable) |
| Default param `function f(x = 5)` | Normal: RECEIVES_ARGUMENT edge exists; paramIndex on edge |
| Destructured ObjectPattern param `f({a, b})` | Synthetic PARAMETER `{...}` node; ARG_BINDING to it |
| Destructured ArrayPattern param `f([a, b])` | Synthetic PARAMETER `[...]` node; ARG_BINDING to it |
| Cross-file calls | Works: allEdges contains all resolved CALLS from Phase 1+2 |
| Self-recursive calls | Works: CALLS back to same function |
| TS overload signatures | Skip: check `index.getNode(edge.dst)?.metadata?.isOverload` |
| `new Foo(a)` NewExpression | CALLS edge resolved to CLASS; CLASS has no RECEIVES_ARGUMENT. Skip: target is CLASS. (Identifier args via visitNewExpression also not deferred — pre-existing gap) |
| IIFE `((x)=>x)(a)` | CALLS unresolved; issue:unresolved-call if PASSES_ARGUMENT exists |
| Optional call `foo?.(a)` | Same as normal call; PASSES_ARGUMENT edges exist |

---

## Section 6: New Edge Type

**`ARG_BINDING`** — `PARAMETER → ARG_BINDING → argument_node`

Metadata: `{ argIndex: number, callId: string }`

Semantics: "This parameter, at argument position argIndex, receives the value of this argument node when called from callId."

Must be added to `packages/types/src/edges.ts` (or the lang-spec edge catalog).

Also needed: `AFFECTS` edge type (already exists in v1; check if it's in core-v2's edge catalog).

---

## Section 7: Implementation Order

1. **Add `metadata` to `DeferredRef`** (`types.ts`)
2. **Walk engine changes** (`walk.ts`):
   - Accept `edgeMetadata` in `visit()` signature
   - Pass `{ argIndex: i }` for PASSES_ARGUMENT array edges
   - Pass `{ paramIndex: i }` for RECEIVES_ARGUMENT array edges
   - Forward `ref.metadata` in Stage 2 resolver
3. **visitCallExpression argIndex** (`expressions.ts`) — add `metadata: { argIndex: i }` to explicit PASSES_ARGUMENT deferreds
4. **RECEIVES_ARGUMENT paramIndex in function visitors** — add `metadata: { paramIndex: i }` to manual RECEIVES_ARGUMENT edges in `declarations.ts`, `expressions.ts` (3 visitors), `classes.ts` (2 visitors)
5. **Destructured param synthetic nodes** (`misc.ts`) — `visitObjectPattern` and `visitArrayPattern` in param position
6. **Extend `ResolveResult`** to include `nodes: GraphNode[]` and new stats
7. **Add `linkArgumentsToParameters`** to `resolve.ts`
8. **Update `CoreV2Analyzer.ts`** to call `graph.addNodes(resolved.nodes)`
9. **Write `arg-binding.test.mjs`** — unit tests
10. **Update `smoke.mjs`** — track ARG_BINDING count

---

## Section 8: Test Strategy

### 8.1 Unit tests (`packages/core-v2/test/arg-binding.test.mjs`)

Following `element-of.test.mjs` pattern.

**Tier 1: Direct calls (same-file)**
- `foo(a, b)` → `function foo(x, y)` — ARG_BINDING x→a, y→b
- `foo(42)` → `function foo(x)` — ARG_BINDING x→42
- `foo()` → `function foo(x)` — no ARG_BINDING (no args)
- `foo(a)` → `function foo(x, y)` — ARG_BINDING x→a, no binding for y (y has no call-side argument)

**Tier 2: Rest parameters**
- `f(1, 2, 3)` → `function f(...args)` — ARG_BINDING args→1, args→2, args→3 (all to rest param)
- `f(a, b, c)` → `function f(x, ...rest)` — ARG_BINDING x→a, rest→b, rest→c

**Tier 3: Extra args**
- `foo(a, b, c)` → `function foo(x)` — ARG_BINDING x→a; issue:extra-argument for b, c

**Tier 4: Method calls**
- `obj.method(arg)` → `class Foo { method(x) {} }` — ARG_BINDING x→arg
- `this.greet(name)` inside class → ARG_BINDING param→name

**Tier 5: Spread arguments**
- `foo(...arr)` → `function foo(x, y)` — no ARG_BINDING (spread at position 0 stops matching)
- `foo(a, ...rest)` → `function foo(x, ...params)` — ARG_BINDING x→a, params→spread_node

**Tier 6: Destructured parameters**
- `foo(obj)` → `function foo({a, b})` — ARG_BINDING synthetic_param→obj

**Tier 7: Default-value parameters**
- `foo(val)` → `function foo(x = 5)` — ARG_BINDING x→val

**Tier 8: Unresolved call ISSUE**
- `unknownFn(a, b)` (no declaration in scope) — issue:unresolved-call ISSUE node + AFFECTS edge

**Tier 9: Cross-file (project-level)**
- `// a.js: export function greet(name) {}`
- `// b.js: import { greet } from './a.js'; greet(userName);`
- Verify ARG_BINDING from name PARAMETER → userName VARIABLE

### 8.2 Smoke test update

Add to `smoke.mjs`:
```js
ARG_BINDING: 0,          // expected to be > 0 after linking
AFFECTS: 0,              // for ISSUE → AFFECTS → CALL edges
'issue:unresolved-call': 0, // ISSUE nodes for unresolved calls
```

---

## Section 9: Open Questions for Rob (Implementer)

1. **ISSUE node scope:** The user said "unresolved calls raise ISSUE." Should we also raise ISSUE for calls that are unresolvable by design (dynamic calls, computed property calls, external module calls)? Recommendation: only raise ISSUE for calls that have PASSES_ARGUMENT (i.e., they pass args) but no resolved target. Calls without args are not interesting for ARG_BINDING.

2. **Synthetic param naming:** `{...}` and `[...]` are placeholder names for destructured param nodes. Should they use the param's source text position or a more descriptive pattern? Alternative: use `'<destructured>'` as the name.

3. **NewExpression handling:** `new Foo(a)` — the target is CLASS, not FUNCTION. Currently the plan skips it. Should we also link args to the constructor's params? This requires finding the `constructor` METHOD inside the CLASS. Out of scope for this ticket, but document as a known gap.

4. **TS type-only RECEIVES_ARGUMENT:** TypeScript signature types (`visitTSConstructSignatureDeclaration`, etc.) have RECEIVES_ARGUMENT edges but won't have resolved CALLS edges pointing to them. They are safely skipped by the algorithm since no CALLS edge will have them as dst.

5. **argIndex on EDGE_MAP RECEIVES_ARGUMENT for non-array contexts:** The `ObjectMethod.params` EDGE_MAP entry fires for ObjectMethod (object literal methods). These should also get paramIndex. The walk engine change applies uniformly to ALL arrays with RECEIVES_ARGUMENT mapping, which is correct.
