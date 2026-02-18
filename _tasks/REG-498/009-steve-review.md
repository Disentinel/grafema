## Steve Jobs — Vision Review

**Verdict:** REJECT

**Vision alignment:** Issues found
**Architecture:** Issues found
**Complexity:** Mixed — some plugins are fine, one is a fundamental violation

---

### The Core Issue: GraphConnectivityValidator

This is not a migration — it is the same problem with a different API name.

```typescript
// GraphConnectivityValidator.ts, lines 62-65
const allNodes: NodeRecord[] = [];
for await (const node of graph.queryNodes({})) {
  allNodes.push(node);
}
```

`queryNodes({})` with an empty filter is `getAllNodes` with a different name. Removing `getAllNodes` from the interface and then immediately calling the equivalent operation through `queryNodes({})` is not a fix. It is cosmetic. The interface constraint was supposed to enforce that plugins do not load the entire graph into memory. This plugin violates that constraint while appearing to comply with it.

The BFS that follows is O(nodes + edges). Every reachable node gets its outgoing and incoming edges fetched individually via `getOutgoingEdges(nodeId)` and `getIncomingEdges(nodeId)` with no type filter. For a codebase with 50,000 nodes, this is 50,000 graph round-trips.

The question in the review prompt asks: "Is this acceptable?" The answer is no. GraphConnectivityValidator is a global graph property check. There is no way to compute "are all nodes connected to root?" without touching all nodes. But the current implementation makes it worse than necessary by pulling all nodes into a JS array first, then doing individual edge queries per node in a BFS loop.

This plugin needs to either:
1. Be implemented as a Datalog query (if RFDB supports transitive reachability), or
2. Be acknowledged as a necessary O(n) scan with a documented exception explaining why no targeted approach is possible for this invariant

Right now it silently bypasses the type-level constraint that this PR was supposed to enforce. That is the real regression.

---

### What Is Working

**DataFlowValidator** — Correct. Queries only VARIABLE and CONSTANT nodes (specific types, not all nodes). Path traversal is bounded by visited set. No brute force.

**TypeScriptDeadCodeValidator** — Acceptable. Queries INTERFACE, ENUM, TYPE node types specifically. Each query is for a defined node type. The iteration is over a specific semantic category, not the entire graph.

**ShadowingDetector** — Borderline. Loads CLASS, VARIABLE, CONSTANT, IMPORT into memory. Each is a specific type query, which is fine. The cross-product check (variables vs. classesByName map) is O(variables * classes-per-name), not O(n^2) in practice because the map lookup is O(1). The approach is defensible, though note that it loads four entire node-type collections simultaneously. This is acceptable but worth watching as graphs grow.

**SocketIOAnalyzer** — Correct. Uses `getModules()` (queryNodes with type MODULE), then processes each module individually. The `createEventChannels` method queries only `socketio:emit` and `socketio:on` nodes. Forward registration pattern. This is how plugins should work.

**plugins.ts interface** — The removal of `getAllEdges` and `getAllNodes` is correct. The type-level enforcement is the right direction. The problem is that it does not prevent `queryNodes({})` which is semantically equivalent.

---

### Specific Issues

1. **GraphConnectivityValidator line 63: `queryNodes({})` must be removed.** This is getAllNodes. Either replace with a Datalog transitive-reachability query, or document a formal exception with a tracking issue.

2. **The type-level enforcement has a gap.** `GraphBackend.queryNodes(filter: NodeFilter)` accepts an empty object `{}` because `NodeFilter` has all optional fields. The interface allows unlimited scans. A stricter NodeFilter that requires at least one discriminating field (type, nodeType, name, file) would prevent this class of bypass.

3. **ShadowingDetector comment on line 18:** "Datalog doesn't support inequality (\=), so we use JS filtering." This is a known limitation that should be a tracked product gap, not a code comment. If this is a gap in the Datalog engine, it should be filed as a separate issue so the engine can be improved. Comments in production code that say "the infrastructure doesn't support this" are technical debt markers disguised as explanations.

---

### Decision

Fix GraphConnectivityValidator before merging. The rest of the implementation is sound. The specific fix required: replace `queryNodes({})` with either a Datalog query for transitive reachability from root types, or file a separate issue for that specific validator and mark it as a known O(n) exception pending engine capability.

The goal of this PR — removing getAllNodes/getAllEdges from the interface and fixing DataFlowValidator — is substantially achieved. Do not let GraphConnectivityValidator be the unexamined loophole that undermines it.
