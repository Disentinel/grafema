## Don Melton — Technical Plan: REG-498

---

### Exploration Summary

I read every relevant file in full. Here is what I found:

#### Issue Verification — All Three Bugs Confirmed

**Bug 1: Ignores DERIVES_FROM (confirmed)**

`DataFlowValidator.ts` lines 98–101 only look for `ASSIGNED_FROM`:
```ts
const assignment = allEdges.find(e =>
  e.type === 'ASSIGNED_FROM' && e.src === variable.id
);
```
And `findPathToLeaf()` lines 233–234 also only checks `ASSIGNED_FROM`. `DERIVES_FROM` is never consulted.

`VariableVisitor.ts` line 314–320 confirms: for-of/for-in loop variables use `sourceType: 'DERIVES_FROM_VARIABLE'`, which results in `DERIVES_FROM` edges (not `ASSIGNED_FROM`). So every `for (const x of arr)` loop variable triggers a false `ERR_MISSING_ASSIGNMENT`.

**Bug 2: O(n×m) performance (confirmed)**

`DataFlowValidator.ts` lines 74–75 load all nodes and all edges into memory:
```ts
const allNodes = await graph.getAllNodes();
const allEdges = await graph.getAllEdges() as EdgeRecord[];
```
Then lines 99, 121, 223, 233, 247 each call `allEdges.find(...)` inside loops over every variable node — O(n×m) per variable.

**Bug 3: Wrong type filter (confirmed)**

`DataFlowValidator.ts` line 77–79:
```ts
const variables = allNodes.filter(n =>
  n.type === 'VARIABLE_DECLARATION' || n.type === 'CONSTANT'
);
```
But actual node types are `'VARIABLE'` (confirmed by `GraphBackend.ts` line 206: `'VARIABLE': 6`). The string `'VARIABLE_DECLARATION'` maps to kind 18, which is a distinct, legacy type. The validator is filtering for the wrong type and matching zero VARIABLE nodes.

#### Graph API Confirmed Available in GraphBackend interface (packages/types/src/plugins.ts lines 285–336)

- `queryNodes(filter: NodeFilter): AsyncIterable<NodeRecord>` — type-filtered async generator
- `getAllNodes(filter?: NodeFilter): Promise<NodeRecord[]>` — with optional filter (accepts `{type: 'VARIABLE'}`)
- `getOutgoingEdges(nodeId: string, edgeTypes?: EdgeType[] | null): Promise<EdgeRecord[]>` — per-node, type-filtered
- `getIncomingEdges(nodeId: string, edgeTypes?: EdgeType[] | null): Promise<EdgeRecord[]>` — per-node, type-filtered
- `getAllEdges?(): Promise<EdgeRecord[]>` — optional, marked for GUI use only

#### What Each Plugin Currently Does with getAllEdges/getAllNodes

| Plugin | getAllEdges | getAllNodes |
|--------|-----------|-----------|
| DataFlowValidator | Line 75: loads ALL edges to find ASSIGNED_FROM per variable | Line 74: loads ALL nodes to filter by type |
| GraphConnectivityValidator | Line 82: loads ALL edges to build adjacency map | Line 62: loads ALL nodes to find root nodes + unreachable |
| TypeScriptDeadCodeValidator | Line 90: `getAllEdges?.()` to find IMPLEMENTS/EXTENDS edges | None (uses queryNodes) |
| ShadowingDetector | None | Lines 80–83: 4× getAllNodes with type filter |
| SocketIOAnalyzer | None | Lines 176–177: getAllNodes with type filter in createEventChannels; Line 432: getAllNodes with type+name+file filter |

#### PluginGraphBackend (actually named GraphBackend in types)

The public interface plugins receive as `context.graph` is the `GraphBackend` interface in `packages/types/src/plugins.ts` (lines 285–336). `getAllEdges` is already marked optional (`getAllEdges?()`) and annotated "For GUI/export — use with caution on large graphs". This is the interface that needs the final removal.

The concrete `RFDBServerBackend` and abstract `GraphBackend` class (in `packages/core/src/core/GraphBackend.ts`) both declare `getAllEdges()` as non-optional — these should stay.

#### Existing Tests

- `test/unit/ShadowingDetector.test.js` — full test suite for ShadowingDetector (6 tests)
- `test/unit/DataFlowTracking.test.js` — tests graph data flow patterns (not DataFlowValidator plugin directly — tests the graph builder)
- `test/unit/ParameterDataFlow.test.js` — data flow for function parameters
- `test/unit/DestructuringDataFlow.test.js` — destructuring data flow
- No direct test file for DataFlowValidator, GraphConnectivityValidator, TypeScriptDeadCodeValidator, or SocketIOAnalyzer

#### Additional getAllEdges Usages Outside the 5 Plugins

Found in files outside plugin scope (not in Phase 2 scope, but noted):
- `packages/mcp/src/analysis-worker.ts` line 262: `db.getAllEdgesAsync()` — only for counting edges at analysis end, fine (internal use)
- `packages/cli/src/commands/doctor/checks.ts` line 425: `backend.getAllEdges()` — duplicate connectivity check logic (mirrors GraphConnectivityValidator, same bug, out of scope)
- `packages/api/src/resolvers/query.ts` line 58: `backend.getAllNodes(query)` — filtered getAllNodes, this is fine since it's not a plugin
- `packages/vscode/src/nodeLocator.ts` lines 26, 101: `client.getAllNodes(filter)` — filtered, acceptable in GUI code

---

### Phase 1: Fix DataFlowValidator

**File:** `packages/core/src/plugins/validation/DataFlowValidator.ts`

**Step 1.1: Write test first (TDD)**

Create `test/unit/DataFlowValidator.test.js` with these cases:
- for-of loop variable: no ERR_MISSING_ASSIGNMENT (was false positive)
- for-in loop variable: no ERR_MISSING_ASSIGNMENT (was false positive)
- Unassigned variable: does get ERR_MISSING_ASSIGNMENT (regression guard)
- VARIABLE node: found and validated (not VARIABLE_DECLARATION)

**Step 1.2: Fix the `execute()` method**

Remove:
```ts
// Lines 67–75 (guards + getAllNodes + getAllEdges)
if (!graph.getAllEdges) { ... }
const allNodes = await graph.getAllNodes();
const allEdges = await graph.getAllEdges() as EdgeRecord[];
const variables = allNodes.filter(n =>
  n.type === 'VARIABLE_DECLARATION' || n.type === 'CONSTANT'
);
```

Replace with:
```ts
const variables: NodeRecord[] = [];
for await (const node of graph.queryNodes({ nodeType: 'VARIABLE' })) {
  variables.push(node);
}
for await (const node of graph.queryNodes({ nodeType: 'CONSTANT' })) {
  variables.push(node);
}
```

**Step 1.3: Fix the assignment check (lines 98–118)**

Remove `allEdges.find()`. Replace with per-node edge lookup:
```ts
for (const variable of variables) {
  const outgoing = await graph.getOutgoingEdges(variable.id, ['ASSIGNED_FROM', 'DERIVES_FROM']);
  const assignment = outgoing[0]; // first edge of either type

  if (!assignment) {
    errors.push(new ValidationError(
      `Variable "${variable.name}" (${variable.file}:${variable.line}) has no ASSIGNED_FROM or DERIVES_FROM edge`,
      ...
    ));
    continue;
  }

  // Source node
  const source = await graph.getNode(assignment.dst);
  if (!source) { ... }
  ...
}
```

**Step 1.4: Refactor `findPathToLeaf()` signature and body**

The private method currently takes `allNodes: NodeRecord[]` and `allEdges: EdgeRecord[]` and does `allEdges.find()` and `allNodes.find()` throughout (lines 200–253). All of these must be converted to per-node graph API calls:

New signature:
```ts
private async findPathToLeaf(
  startNode: NodeRecord,
  graph: PluginContext['graph'],
  leafTypes: Set<string>,
  visited: Set<string> = new Set(),
  chain: string[] = []
): Promise<PathResult>
```

Changes inside `findPathToLeaf`:
- Line 223: `allEdges.find(e => e.type === 'USES' && e.dst === startNode.id)` → `await graph.getIncomingEdges(startNode.id, ['USES'])`, take first result
- Line 227: `allNodes.find(n => n.id === usedByCall.src)` → `await graph.getNode(usedByCall.src)`
- Lines 233–234: `allEdges.find(e => e.type === 'ASSIGNED_FROM' && e.src === startNode.id)` → `await graph.getOutgoingEdges(startNode.id, ['ASSIGNED_FROM', 'DERIVES_FROM'])`, take first result
- Line 247: `allNodes.find(n => n.id === assignment.dst)` → `await graph.getNode(assignment.dst)`
- Recursive call: update to use new signature (no allNodes/allEdges)

**Step 1.5: Remove `EdgeRecord` local interface**

The local `EdgeRecord` interface (lines 22–28) was only needed because `allEdges` required explicit typing. Once we use `graph.getOutgoingEdges()`, the return type is already `EdgeRecord[]` from types. Remove or simplify.

**Step 1.6: Remove stale `getAllEdges` guard**

Line 67–71:
```ts
if (!graph.getAllEdges) {
  logger.debug('Graph does not support getAllEdges, skipping validation');
  return createSuccessResult({ nodes: 0, edges: 0 }, { skipped: true });
}
```
Delete this block entirely. The guard was only needed because the old code required `getAllEdges`. With `getOutgoingEdges`/`queryNodes`, no guard is needed.

**Scope:** ~100 lines modified, 0 lines added (net reduction). The method becomes fully async throughout.

---

### Phase 2: Remove getAllEdges/getAllNodes from Remaining Plugins

#### 2A: TypeScriptDeadCodeValidator

**File:** `packages/core/src/plugins/validation/TypeScriptDeadCodeValidator.ts`

**Current issue (lines 89–96):**
```ts
const allEdges = await graph.getAllEdges?.() ?? [];
for (const edge of allEdges) {
  if (edge.type === 'IMPLEMENTS' || edge.type === 'EXTENDS') {
    const count = implementedInterfaces.get(edge.dst) || 0;
    implementedInterfaces.set(edge.dst, count + 1);
  }
}
```
This loads ALL edges to count which interfaces have implementations.

**Replace with:** For each interface, check incoming edges directly:
```ts
for (const [id, iface] of interfaces) {
  const incoming = await graph.getIncomingEdges(id, ['IMPLEMENTS', 'EXTENDS']);
  const implCount = incoming.length;
  ...
}
```
The comment on line 89 says "no queryEdges in GraphBackend yet" — this is now outdated since `getIncomingEdges` with type filter exists.

**Scope:** Lines 89–96 replaced with per-interface `getIncomingEdges` call (~10 lines changed). Loop over interfaces moves `implementedInterfaces` counting into the same `for` loop. The `implementedInterfaces` Map can be eliminated entirely.

**Note:** This changes the algorithmic structure — instead of one getAllEdges pass then one loop, we do one `getIncomingEdges` call per interface. Total requests = number of interfaces (not number of edges).

#### 2B: ShadowingDetector

**File:** `packages/core/src/plugins/validation/ShadowingDetector.ts`

**Current issue (lines 80–83):**
```ts
const allClasses   = await graph.getAllNodes({ type: 'CLASS' });
const allVariables = await graph.getAllNodes({ type: 'VARIABLE' }) as ShadowableNode[];
const allConstants = await graph.getAllNodes({ type: 'CONSTANT' }) as ShadowableNode[];
const allImports   = await graph.getAllNodes({ type: 'IMPORT' }) as ShadowableNode[];
```
`getAllNodes(filter)` with a type filter is already functionally correct — it calls `queryNodes` internally. However, the task requires removing `getAllNodes` from plugins.

**Replace with `queryNodes` pattern:**
```ts
const allClasses: NodeRecord[] = [];
for await (const node of graph.queryNodes({ nodeType: 'CLASS' })) {
  allClasses.push(node);
}
const allVariables: ShadowableNode[] = [];
for await (const node of graph.queryNodes({ nodeType: 'VARIABLE' })) {
  allVariables.push(node as ShadowableNode);
}
// ... same for CONSTANT and IMPORT
```

**Scope:** Lines 80–83 expand to ~12 lines. No logic change, pure API migration.

**Risk note:** The comment at line 18 in ShadowingDetector.ts says "use getAllNodes for arrays" — this was the original justification for using getAllNodes instead of queryNodes. That comment should be removed or updated after this change.

#### 2C: SocketIOAnalyzer

**File:** `packages/core/src/plugins/analysis/SocketIOAnalyzer.ts`

**Current issue 1 (lines 176–177 in `createEventChannels`):**
```ts
const allEmits     = await graph.getAllNodes({ type: 'socketio:emit' });
const allListeners = await graph.getAllNodes({ type: 'socketio:on' });
```

**Replace with queryNodes:**
```ts
const allEmits: NodeRecord[] = [];
for await (const node of graph.queryNodes({ nodeType: 'socketio:emit' })) {
  allEmits.push(node);
}
const allListeners: NodeRecord[] = [];
for await (const node of graph.queryNodes({ nodeType: 'socketio:on' })) {
  allListeners.push(node);
}
```

**Current issue 2 (lines 432–433 in `analyzeModule`):**
```ts
const handlerFunctions = await graph.getAllNodes({
  type: 'FUNCTION', name: listener.handlerName, file: listener.file
});
```

**Replace with queryNodes:**
```ts
const handlerFunctions: NodeRecord[] = [];
for await (const node of graph.queryNodes({
  nodeType: 'FUNCTION', name: listener.handlerName, file: listener.file
})) {
  handlerFunctions.push(node);
}
```

**Scope:** 3 occurrences expanded to ~6 lines each. No logic change.

#### 2D: GraphConnectivityValidator — Hardest Case

**File:** `packages/core/src/plugins/validation/GraphConnectivityValidator.ts`

**Current issue (lines 62–82):**
```ts
const allNodes = await graph.getAllNodes();  // ALL nodes
// ...
const allEdges = await graph.getAllEdges();  // ALL edges
// Build adjacency maps from allEdges, then BFS
```

**The challenge:** GraphConnectivityValidator needs to find ALL unreachable nodes. This is a global graph problem. There is no way to do this without knowing all nodes and all connectivity.

**Proposed approach using queryNodes + BFS with getOutgoingEdges/getIncomingEdges:**

```ts
// Step 1: Collect ALL nodes via queryNodes (paged, lazy)
const allNodes: NodeRecord[] = [];
for await (const node of graph.queryNodes({})) {
  allNodes.push(node);
}

// Step 2: BFS from roots using getOutgoingEdges/getIncomingEdges
// No adjacency map needed — query per node during BFS
const reachable = new Set<string>();
const queue: string[] = [...rootNodes.map(n => n.id)];

while (queue.length > 0) {
  const nodeId = queue.shift()!;
  if (reachable.has(nodeId)) continue;
  reachable.add(nodeId);

  const outgoing = await graph.getOutgoingEdges(nodeId);
  const incoming = await graph.getIncomingEdges(nodeId);

  for (const edge of [...outgoing, ...incoming]) {
    const neighborId = edge.src === nodeId ? edge.dst : edge.src;
    if (!reachable.has(neighborId)) queue.push(neighborId);
  }
}
```

**Trade-off:** This replaces one `getAllEdges` call with N `getOutgoingEdges`+`getIncomingEdges` calls (one per node during BFS). For a graph where all nodes are connected (common case), N = total nodes. For a disconnected graph, N = reachable nodes < total.

On large graphs this is potentially MORE network round-trips to the RFDB server. However, it removes the memory spike of loading all edges. Whether this is a net positive depends on graph size. The Linear issue says to do it, so we do it.

**Alternative considered:** `graph.bfs()` method exists on RFDBServerBackend. However, it's not on the `GraphBackend` interface in `packages/types/src/plugins.ts`, so plugins can't use it.

**Note:** getAllNodes with empty filter (line 62: `graph.getAllNodes()`) is still needed here since we need all nodes to find unreachable ones. However, we can change it to:
```ts
for await (const node of graph.queryNodes({})) { allNodes.push(node); }
```
This keeps memory usage the same (we still collect all nodes) but uses the queryNodes API consistently.

**Scope:** Lines 75–84 (getAllEdges + adjacency map build) replaced. BFS inner loop becomes async with awaits. Lines 62–63 (getAllNodes) changes to queryNodes pattern. Approximately 20 lines change.

---

### Phase 3: Type-level Enforcement

**File:** `packages/types/src/plugins.ts`

**Current (lines 301–303):**
```ts
// For GUI/export - use with caution on large graphs
getAllEdges?(): Promise<EdgeRecord[]>;
```

**Change:** Remove `getAllEdges?()` from the `GraphBackend` interface entirely (the interface that plugins receive as `context.graph`).

**What keeps getAllEdges:**
- `packages/core/src/core/GraphBackend.ts` — abstract class, line 196: `abstract getAllEdges(): Promise<EdgeRecord[]>` — KEEP (internal backend contract)
- `packages/core/src/storage/backends/RFDBServerBackend.ts` — lines 544–555: `getAllEdges()` and `getAllEdgesAsync()` — KEEP (concrete implementation)

**Cascading changes required after removing from interface:**
- TypeScriptDeadCodeValidator already uses `graph.getAllEdges?.()` with optional chaining — after Phase 2, this call is removed
- GraphConnectivityValidator already checks `if (!graph.getAllEdges)` guard — after Phase 2, this guard is removed
- DataFlowValidator checks `if (!graph.getAllEdges)` guard — after Phase 1, this guard is removed
- No other plugins call `graph.getAllEdges` (confirmed by grep)

**What else uses the GraphBackend interface from types:**
- `packages/mcp/src/types.ts` line 187 has its own local `getAllNodes(filter?)` without `getAllEdges` — already correct
- `packages/api/src/resolvers/query.ts` uses `context.backend.getAllNodes(query)` — not via plugin interface, fine
- `packages/vscode/src/nodeLocator.ts` — not via plugin interface, fine

**Scope:** Remove 2 lines from `packages/types/src/plugins.ts`. Verify TypeScript compilation still passes (`pnpm build`).

---

### Files to Modify

| File | Phase | Changes |
|------|-------|---------|
| `packages/core/src/plugins/validation/DataFlowValidator.ts` | 1 | Full rewrite of execute() and findPathToLeaf(); ~100 lines modified |
| `packages/core/src/plugins/validation/TypeScriptDeadCodeValidator.ts` | 2A | Replace getAllEdges block with getIncomingEdges per interface; ~10 lines |
| `packages/core/src/plugins/validation/ShadowingDetector.ts` | 2B | Replace 4x getAllNodes with queryNodes; ~12 lines; remove stale comment |
| `packages/core/src/plugins/analysis/SocketIOAnalyzer.ts` | 2C | Replace 3x getAllNodes with queryNodes; ~15 lines |
| `packages/core/src/plugins/validation/GraphConnectivityValidator.ts` | 2D | Replace getAllNodes + getAllEdges + adjacency map with queryNodes + per-node BFS; ~25 lines |
| `packages/types/src/plugins.ts` | 3 | Remove getAllEdges? from GraphBackend interface; 2 lines |
| `test/unit/DataFlowValidator.test.js` | 1 | NEW: TDD tests for DataFlowValidator (for-of false positive, VARIABLE type, etc.) |

**Files NOT to modify:**
- `packages/core/src/core/GraphBackend.ts` — keep `abstract getAllEdges()` (internal contract)
- `packages/core/src/storage/backends/RFDBServerBackend.ts` — keep `getAllEdges()` + `getAllEdgesAsync()` (implementation)
- `packages/mcp/src/analysis-worker.ts` — uses `db.getAllEdgesAsync()` for counting only (not a plugin, out of scope)
- `packages/cli/src/commands/doctor/checks.ts` — duplicate connectivity logic, separate concern
- `packages/api/src/resolvers/query.ts` — not a plugin
- `packages/vscode/src/nodeLocator.ts` — not a plugin

---

### Risk Assessment

**Phase 1 (DataFlowValidator) — Medium Risk**
- `findPathToLeaf()` becoming async changes the call signature. It's private, so no external callers to update. But it's now recursive and async — need to verify there's no stack overflow on deep chains with cycles. The `visited: Set<string>` guard already prevents infinite recursion.
- The DERIVES_FROM fix will change validation output in real codebases. Previously, loop variables silently failed (ERR_MISSING_ASSIGNMENT). Now they pass. This is correct behavior but changes observable output.
- Tests for DataFlowValidator don't exist yet — must write them first (TDD).

**Phase 2A (TypeScriptDeadCodeValidator) — Low Risk**
- Changes algorithm from "one pass over all edges" to "N requests per interface". On a graph with 1000 interfaces, this is 1000 `getIncomingEdges` calls instead of one `getAllEdges` call. Acceptable.
- Existing behavior is preserved. No new test required (no test existed before).

**Phase 2B (ShadowingDetector) — Low Risk**
- Pure API migration. Logic unchanged. Existing test suite (ShadowingDetector.test.js) covers all paths.
- `getAllNodes(filter)` and `queryNodes(filter)` have the same semantics — confirmed by RFDBServerBackend implementation.

**Phase 2C (SocketIOAnalyzer) — Low Risk**
- Pure API migration. No tests exist for SocketIOAnalyzer, but logic is unchanged.
- The filtered `getAllNodes({type: 'FUNCTION', name: ..., file: ...})` in analyzeModule becomes a `queryNodes` with `nodeType` instead of `type` (note: `NodeFilter` accepts both `type` and `nodeType` as aliases).

**Phase 2D (GraphConnectivityValidator) — Highest Risk**
- BFS with per-node `getOutgoingEdges` + `getIncomingEdges` is N×2 round-trips to RFDB server instead of 1. On large graphs (100k nodes, 500k edges) this could be slow if the graph is well-connected (BFS visits many nodes).
- However, RFDBServerBackend uses a Unix socket — local IPC, not network. Latency is microseconds per call. For 10k reachable nodes × 2 calls = 20k IPC calls, which should still complete in seconds.
- The existing behavior of building an adjacency map from `getAllEdges` avoids the N IPC calls but loads potentially GBs of edge data into Node.js memory. The trade-off favors IPC calls.
- GraphConnectivityValidator has no dedicated test file. The behavior must be validated manually or by adding a test.

**Phase 3 (Type enforcement) — Low Risk**
- Removing `getAllEdges?()` from the interface causes TypeScript errors wherever plugin code calls `graph.getAllEdges`. After Phases 1 and 2, no plugin code should call it. TypeScript build (`pnpm build`) will confirm.
- Internal code that needs `getAllEdges` must use the concrete `RFDBServerBackend` type, not the `GraphBackend` interface — this is the intended enforcement.

---

### Estimated Scope

| File | Lines Changed | Lines Added | Lines Removed | Net |
|------|--------------|-------------|---------------|-----|
| `DataFlowValidator.ts` | ~60 | ~20 | ~40 | -20 |
| `TypeScriptDeadCodeValidator.ts` | ~15 | ~10 | ~10 | 0 |
| `ShadowingDetector.ts` | ~12 | ~10 | ~4 | +6 |
| `SocketIOAnalyzer.ts` | ~20 | ~15 | ~6 | +9 |
| `GraphConnectivityValidator.ts` | ~30 | ~15 | ~20 | -5 |
| `packages/types/src/plugins.ts` | 2 | 0 | 2 | -2 |
| `test/unit/DataFlowValidator.test.js` | — | ~80 | 0 | +80 |
| **Total** | | **~150** | **~82** | **+68** |

---

### Execution Order

The three phases must be done in sequence because Phase 3 will cause TypeScript compile errors if Phases 1 and 2 haven't removed all `graph.getAllEdges` calls from plugins yet.

Within Phase 2, the four plugins are independent of each other and could theoretically be parallelized across workers. However, since they share the `packages/types/src/plugins.ts` interface change in Phase 3, they should all land before Phase 3.

Recommended order:
1. Phase 1 (DataFlowValidator) — highest value, fixes real bugs with false positives
2. Phase 2B (ShadowingDetector) — lowest risk, existing tests protect regression
3. Phase 2C (SocketIOAnalyzer) — low risk, pure API migration
4. Phase 2A (TypeScriptDeadCodeValidator) — slight algorithm change
5. Phase 2D (GraphConnectivityValidator) — requires most careful testing
6. Phase 3 (type enforcement) — final, compile-time verification that all plugins are clean
