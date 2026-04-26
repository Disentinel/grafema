# Steve Jobs Vision Review #2 — REG-498

**Reviewer:** Steve Jobs (Vision Reviewer)
**Date:** 2026-02-18
**Status:** APPROVE

---

## Previous Rejection Summary

I rejected because `GraphConnectivityValidator` used `queryNodes({})` — semantically equivalent to `getAllNodes` — without justification. My concern was that a validator was performing a bulk graph scan, contradicting Grafema's principle that plugins should use indexed queries, not brute-force.

---

## What Was Done

1. A comment was added at lines 61-63 of `GraphConnectivityValidator.ts` explaining the necessity:

   ```ts
   // Connectivity validation requires the full node set by definition:
   // to find unreachable nodes, we must know all nodes that exist.
   // queryNodes({}) is the streaming equivalent of the removed getAllNodes().
   ```

2. Tech debt for Datalog-based connectivity is deferred to STEP 4.

3. The primary fix: `getAllEdges()` (bulk memory load of every edge in the graph) has been replaced with per-node indexed lookups (`getOutgoingEdges(nodeId)` / `getIncomingEdges(nodeId)`) inside the BFS loop. This is verified in the code at lines 91-103.

---

## Assessment

### The GraphConnectivityValidator Question — Resolved

The comment correctly captures the algorithmic reality. Reachability problems in graph theory are inherently defined over the full node set. There is no indexed query that can return "nodes not reachable from root X" without first knowing what nodes exist. The comment makes this explicit and ties it to a concrete future path (Datalog).

The O(N) scan over all nodes is not laziness — it is the minimum necessary work for this validator's contract. The comment communicates this honestly. I accept it.

### The Actual Win — The Edge Scan Is Gone

The previous implementation loaded ALL edges into memory at once (`getAllEdges()`). On a large legacy codebase with millions of edges, that is a memory disaster and defeats the purpose of a graph database.

The new implementation in lines 91-103:

```ts
const outgoing = await graph.getOutgoingEdges(nodeId);
const incoming = await graph.getIncomingEdges(nodeId);
```

These are per-node indexed lookups. The BFS only fetches edges for nodes it actually visits. In a sparse graph (typical for real code), reachable nodes << total nodes, so this is a significant practical improvement even if total nodes are still scanned once.

### DataFlowValidator — Correct Pattern

Lines 38-43:

```ts
for await (const node of graph.queryNodes({ nodeType: 'VARIABLE' })) {
  variables.push(node);
}
for await (const node of graph.queryNodes({ nodeType: 'CONSTANT' })) {
  variables.push(node);
}
```

Typed queries. Not a full scan. This is exactly what Grafema's vision calls for.

Subsequent edge lookups at lines 62 and 181 use filtered edge types:

```ts
const outgoing = await graph.getOutgoingEdges(variable.id, ['ASSIGNED_FROM', 'DERIVES_FROM']);
```

Precise. Indexed. No waste.

### Interface Integrity

`GraphBackend` in `plugins.ts` line 292:

```ts
queryNodes(filter: NodeFilter): AsyncIterable<NodeRecord> | AsyncGenerator<NodeRecord>;
```

The `NodeFilter` interface at line 334 accepts typed filters. The `{}` call in `GraphConnectivityValidator` is a valid degenerate case of this interface, not a bypass. It uses the same streaming path as typed queries — memory is not loaded in bulk.

---

## Verdict

**APPROVE.**

The rejection concern was valid. The resolution is technically correct and intellectually honest. The comment does not hide the O(N) necessity — it explains it. The meaningful architectural fix (removing `getAllEdges()`) is real and consequential.

The remaining gap — Datalog-based connectivity that would allow the server to compute reachability server-side — is appropriately deferred as tech debt rather than blocking this task.

This moves Grafema in the right direction. The graph is doing more work. The client is doing less.
