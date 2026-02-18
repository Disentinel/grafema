## Dijkstra Correctness Review

**Verdict:** APPROVE with one annotation

**Functions reviewed:**

| Function | File | Verdict |
|---|---|---|
| `DataFlowValidator.execute` | DataFlowValidator.ts | APPROVE |
| `DataFlowValidator.findPathToLeaf` | DataFlowValidator.ts | APPROVE (with annotation) |
| `GraphConnectivityValidator.execute` (BFS) | GraphConnectivityValidator.ts | APPROVE |
| `TypeScriptDeadCodeValidator.execute` | TypeScriptDeadCodeValidator.ts | APPROVE |
| `ShadowingDetector.execute` | ShadowingDetector.ts | APPROVE |
| `SocketIOAnalyzer.createEventChannels` | SocketIOAnalyzer.ts | APPROVE |
| `SocketIOAnalyzer.analyzeModule` (queryNodes migration) | SocketIOAnalyzer.ts | APPROVE |

---

## Enumeration — DataFlowValidator.execute (lines 31–153)

### Input enumeration

`context.graph` — any object satisfying the `PluginContext['graph']` interface:
- `queryNodes({ nodeType: 'VARIABLE' })` — async generator, zero or more nodes
- `queryNodes({ nodeType: 'CONSTANT' })` — async generator, zero or more nodes
- `getOutgoingEdges(id, edgeTypes[])` — returns edge array
- `getNode(id)` — returns node or null

### Condition completeness (lines 62–117)

For each variable node, the function branches on three successive conditions:

**Branch A** (line 65): `!assignment` — variable has neither ASSIGNED_FROM nor DERIVES_FROM outgoing edge.
- **Fires when:** `getOutgoingEdges(variable.id, ['ASSIGNED_FROM', 'DERIVES_FROM'])` returns empty array.
- **Action:** push `ERR_MISSING_ASSIGNMENT`, `continue`.
- **What passes to Branch B:** only nodes that have at least one such edge.

**Branch B** (line 83): `!source` — assignment edge exists but its `dst` node does not exist in the graph.
- **Fires when:** `getNode(assignment.dst)` returns `null`.
- **Action:** push `ERR_BROKEN_REFERENCE`, `continue`.
- **What passes to Branch C:** nodes where assignment edge exists AND destination node exists.

**Branch C** (line 101): `!path.found` — recursive path did not reach a leaf.
- **Action:** push `ERR_NO_LEAF_NODE`.

**Coverage:** Every VARIABLE/CONSTANT node falls into exactly one of: A (no edge), B (broken dst), or through to C (path search). No case falls through without classification. Correct.

**Note on `outgoing[0]`:** Only the first matching edge is followed (line 63). If a variable has two ASSIGNED_FROM edges (possible in a graph with redundant edges), the second is silently ignored. This is not a new bug introduced by REG-498 — it was pre-existing behavior — but I enumerate it here for the record.

### Loop termination

- `for await ... of graph.queryNodes(...)` (lines 38–43): terminates when the async generator is exhausted, which is guaranteed by the graph backend interface contract. If the backend hangs, the loop hangs — but that is outside the scope of this component.
- `for (const variable of variables)` (line 61): finite because `variables` is a pre-collected array.
- Both loops handle the empty-collection case correctly: zero iterations, no errors reported.

### Invariant after execute

After `execute` completes:
- `summary.total === variables.length` — **verified** (line 129).
- `summary.validated === variables.length - errors.length` — **verified** (line 130). This can go negative only if a single variable produces two errors. Enumerating: each variable hits at most one `continue` branch (A or B) or falls through to C. Branch A and B both `continue`, so a variable that hits A cannot also hit C. Branch C is the only branch that does not `continue`. Therefore each variable produces at most one error. Invariant holds.

---

## Enumeration — DataFlowValidator.findPathToLeaf (lines 155–198)

### Cycle detection — the specific concern

The signature is:

```typescript
private async findPathToLeaf(
  startNode: NodeRecord,
  graph: PluginContext['graph'],
  leafTypes: Set<string>,
  visited: Set<string> = new Set(),
  chain: string[] = []
): Promise<PathResult>
```

The `visited` Set is passed **by reference** through all recursive calls. I will prove termination.

**Claim:** Every execution path through `findPathToLeaf` terminates.

**Proof by enumeration of exit points:**

1. Line 162: `if (visited.has(startNode.id))` — returns immediately. This fires when a node is visited twice. Because `visited` is shared across the recursion and nodes are added on line 166, this guard fires on any repeated visit.

2. Line 169: `if (leafTypes.has(startNode.type))` — returns immediately when `startNode` is a leaf. Leaf types are: LITERAL, net:stdio, db:query, net:request, fs:operation, event:listener, CLASS, FUNCTION, METHOD_CALL, CALL_SITE.

3. Line 173–178: If `incomingUses[0]` exists — returns immediately. No recursion.

4. Line 183–189: If no outgoing ASSIGNED_FROM/DERIVES_FROM edge — returns immediately. No recursion.

5. Line 192–195: If `nextNode` is null — returns immediately.

6. Line 197: `return this.findPathToLeaf(nextNode, graph, leafTypes, visited, chain)` — recursive call. This is the only recursive site.

**For exit 6:** `nextNode` must be a node with a valid id. Before recursing, `startNode.id` was added to `visited` on line 166. On the next call, if `nextNode.id === startNode.id` (direct self-loop), exit 1 fires immediately. If `nextNode.id` leads through a chain back to any already-visited node, exit 1 will eventually fire. Because `visited` grows monotonically and the graph is finite (finite node count), exit 1 is guaranteed to fire in at most `|V|` steps, where `|V|` is the total number of distinct node ids reachable via ASSIGNED_FROM/DERIVES_FROM. Termination is **proved**.

**Async recursion concern:** The recursive call on line 197 is `return this.findPathToLeaf(...)`. Since JavaScript/TypeScript processes each `await` sequentially on the microtask queue and the visited Set is shared by reference across the same logical call chain (not across concurrent calls), there is no race condition. The concurrency concern does not apply here because `execute` processes one variable at a time in a sequential `for` loop (line 61). No two `findPathToLeaf` calls run concurrently for the same variable.

**One annotation (not a bug, a potential confusion):** The `visited` Set is passed by reference. If the same Set were reused across multiple top-level calls to `findPathToLeaf`, a node visited while tracing variable A would be considered visited when tracing variable B, causing false `CYCLE` returns. Looking at the call site (line 101), `findPathToLeaf` is called with `new Set()` implicitly (default parameter). Each variable gets a fresh Set. This is correct. However: the default parameter `visited: Set<string> = new Set()` is evaluated once per call to `findPathToLeaf` where `visited` is not passed — which in TypeScript/JS means a new Set is created per external call. This is the correct behavior for default parameter values that are expressions (unlike Python). Correct.

---

## Enumeration — GraphConnectivityValidator BFS (lines 54–208)

### Input enumeration

- `graph.queryNodes({})` — all nodes, possibly zero.
- `graph.getOutgoingEdges(nodeId)` and `graph.getIncomingEdges(nodeId)` — edges in both directions, possibly empty arrays.

### Early exit (line 75–78)

`if (rootNodes.length === 0)` — returns `skipped: true`. The BFS loop is never entered. The `reachable` set remains empty. No unreachable nodes are reported. This is semantically correct: if there are no root nodes, connectivity cannot be established, and reporting every node as unreachable would be misleading.

### BFS correctness — condition completeness

The queue starts with all root node ids (line 82). The loop invariant before each iteration:
- `reachable` contains all nodes confirmed reachable.
- `queue` contains node ids that may or may not be in `reachable`.

**Guard on line 87:** `if (reachable.has(nodeId)) continue` — skips nodes already processed. This prevents infinite loops in cyclic graphs. Because a node is added to `reachable` on line 88 before its neighbors are enqueued (lines 94–103), and `reachable` is checked before processing, no node is processed twice.

**Termination:** Each node id is processed at most once (the guard prevents re-processing). The number of distinct node ids is finite (bounded by `allNodes.length` plus any dangling edge destinations). Termination is **proved**.

**Disconnected subgraph handling — the specific concern:**

The BFS traverses edges in **both** directions (outgoing on line 91, incoming on line 92). This means the reachable set grows to include all nodes in the same weakly connected component as any root node. A subgraph that is weakly connected to a root (via any path ignoring direction) is fully reached.

If a subgraph has zero edges connecting it to a root — not even a path in either direction — it will not be in `reachable`. This is correct: those nodes will appear in `unreachable` (line 107). This is the intended behavior.

**One edge case to enumerate explicitly:** A node whose id appears only as `edge.dst` in incoming edges of root nodes but was not in `allNodes`. Such a node would be enqueued (line 101: `queue.push(edge.src)`) — wait, I need to re-read.

Re-reading lines 99–103:
```typescript
for (const edge of incoming) {
  if (!reachable.has(edge.src)) {
    queue.push(edge.src);
  }
}
```

For an incoming edge of `nodeId`, `edge.dst === nodeId` and `edge.src` is the upstream node. `edge.src` is enqueued. If `edge.src` is not in `allNodes` (a dangling reference), it will be processed by the BFS but `getOutgoingEdges(edge.src)` and `getIncomingEdges(edge.src)` will return empty arrays (no edges from that phantom node). The phantom id will be added to `reachable`. It will NOT appear in `unreachable` because `unreachable` is computed by filtering `allNodes` (which does not contain the phantom). This is correct behavior: phantom nodes (referenced but not in the graph) do not generate false positives.

### Summary of BFS correctness

Termination: proved. Cycle safety: proved (guard on line 87 + monotone reachable set). Disconnected subgraphs: correctly detected. Bidirectional traversal: correctly implements weakly-connected-component reachability from roots.

---

## Enumeration — TypeScriptDeadCodeValidator.execute — getIncomingEdges direction

**The specific concern:** Does `getIncomingEdges(id, ['IMPLEMENTS', 'EXTENDS'])` match the old filter semantics?

The semantics of an IMPLEMENTS edge in Grafema's graph:
- Edge direction: `ClassNode --IMPLEMENTS--> InterfaceNode`
  (the implementing class is `src`, the interface is `dst`)

Therefore, for a given interface node with id `id`:
- `getIncomingEdges(id, ['IMPLEMENTS'])` returns all edges where `edge.dst === id` and `edge.type === 'IMPLEMENTS'`.
- These edges have `edge.src` equal to the implementing class node.

This is exactly the correct semantic: "how many classes implement this interface?" is answered by counting incoming IMPLEMENTS edges to the interface node.

**Verification by enumeration:**
- Zero incoming IMPLEMENTS/EXTENDS edges → `implCount === 0` → UNUSED_INTERFACE. Correct: no class implements or extends this interface.
- One incoming edge → `implCount === 1` → SINGLE_IMPLEMENTATION. Correct.
- Two or more → neither branch. Correct: well-used interface.

The direction is semantically correct.

---

## Enumeration — ShadowingDetector.execute — queryNodes migration

**Cross-file shadowing (lines 113–133):**

For each VARIABLE node `v`, look up `classesByName.get(v.name)`, then filter classes where `c.file !== v.file`. This identifies a variable in file X that shares a name with a class defined in file Y (X ≠ Y).

**Condition completeness:**
- If `v.name` has no matching class name: `classesWithSameName` is undefined, the inner block is skipped. Correct.
- If `v.name` matches classes only in the same file: `shadowedClasses` is empty, no issue pushed. Correct.
- If `v.name` matches classes in both same and different files: only different-file classes generate issues. Correct.

**Empty collection:** If `allVariables` is empty, the outer loop has zero iterations. No issues reported. Correct.

**Scope-aware shadowing (lines 137–158):**

`allLocalVars` filters variables/constants that have `parentScopeId` set (i.e., inside a function scope). The key `${localVar.file}:${name}` is used to look up imports.

**Condition completeness:**
- If `shadowedImport` is undefined: no issue. Correct.
- If `shadowedImport` is defined: issue pushed. The `nodeType` distinction (CONSTANT vs VARIABLE) correctly selects the label text.

**Potential observation:** `importsByFileAndLocal` uses `imp.local` as the local name. If `imp.local` is undefined (an import node without a `local` field set), the key becomes `${file}:undefined`. A variable named `"undefined"` in the same file would match this key. This is a pre-existing concern unrelated to REG-498 and not introduced by the queryNodes migration. The migration itself is correct.

---

## Enumeration — SocketIOAnalyzer.createEventChannels — queryNodes migration

**Input enumeration:**
- `graph.queryNodes({ nodeType: 'socketio:emit' })` — async generator, zero or more nodes.
- `graph.queryNodes({ nodeType: 'socketio:on' })` — async generator, zero or more nodes.

**Condition completeness (event name extraction, lines 193–202):**
- `emit.event` is set on line 331 of analyzeModule via `this.extractStringArg(node.arguments[0])`. `extractStringArg` returns 'unknown', 'dynamic', or a string value — never null or undefined. The `typeof emit.event === 'string'` guard (line 194) is redundant but harmless. All emit events have string event names; they will always pass this guard. Similarly for listeners.

**Empty collection:** If `allEmits` and `allListeners` are both empty, `eventNames` is empty, the for loop over `eventNames` has zero iterations, `createdCount === 0`, zero nodes and edges are submitted. Returns 0. Correct.

**Event name deduplication:** `eventNames` is a Set. If the same event name appears in both `allEmits` and `allListeners`, one event channel node is created. The `EMITS_EVENT` and `LISTENED_BY` edges then correctly link all emitters and listeners to that single channel node. Correct.

**Node id consistency (line 213 vs factory):** The `eventNodeId` is constructed as `socketio:event#${eventName}`. The `EMITS_EVENT` and `LISTENED_BY` edges use this string as `dst`/`src`. The actual node is created via `NodeFactory.createSocketIOEvent(eventName)`. If the factory generates a different id format, the edges would reference a non-existent node id. This is outside the scope of REG-498 (the factory call was not changed) and is pre-existing behavior. I enumerate it for completeness.

---

## Issues Found

**No blocking issues found.** The following observations are enumerated but are not regressions introduced by REG-498:

- [DataFlowValidator.ts:63] — Only `outgoing[0]` is used. A variable with two ASSIGNED_FROM edges silently ignores the second. Pre-existing; not introduced by this PR.

- [ShadowingDetector.ts:109] — If an IMPORT node has no `local` field, `imp.local` is undefined, producing a key `"file:undefined"`. Pre-existing.

- [SocketIOAnalyzer.ts:213] — Event node id constructed inline must match what `NodeFactory.createSocketIOEvent` generates. Pre-existing.

- [DataFlowValidator.ts:159] — Default parameter `visited: Set<string> = new Set()` creates a new Set per external call. This is correct JavaScript behavior, not Python. No bug.

---

## Verdict

**APPROVE.**

All changes in REG-498 are correct:
1. `findPathToLeaf` cycle detection via shared `visited` Set is proved correct and terminates in bounded steps.
2. The BFS in `GraphConnectivityValidator` correctly handles disconnected subgraphs and cycles.
3. `getIncomingEdges(id, ['IMPLEMENTS', 'EXTENDS'])` correctly retrieves implementing nodes (direction semantics verified).
4. `queryNodes` migration in all files is functionally equivalent to the former `getAllNodes`-based approach, with the addition of streaming support.
5. Tests in `DataFlowValidator.test.js` correctly enumerate the three bug categories and provide regression guards.
