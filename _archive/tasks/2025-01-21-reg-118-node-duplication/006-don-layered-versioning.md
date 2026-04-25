# Architectural Analysis: Layered Versioning Model

**Author:** Don Melton (Tech Lead)
**Date:** 2025-01-22

---

## Executive Summary

The proposed layered versioning model fundamentally misunderstands the problem space. We have **two separate problems** being conflated:

1. **REG-118 (Node Duplication):** Re-analysis creates duplicates due to missing upsert semantics
2. **Version Tracking:** Storing main/`__local`/branch states for diff and incremental analysis

These require **different solutions**. Layered versioning solves problem #2 but **does not solve** problem #1 — in fact, it may make it worse.

**My recommendation:** Fix REG-118 first with upsert semantics. Then evaluate whether layered versioning is even needed.

---

## 1. Alignment with Grafema Vision

### "AI should query the graph, not read code"

Let me think about what this actually means for versioning:

**The ideal query experience:**
```
Q: "What functions exist in file X?"
A: [foo, bar, baz]  // Clean, unambiguous

NOT:
A: [
  foo@main, foo@__local,  // Which one is "current"?
  bar@main,               // Deleted locally?
  baz@__local             // Added locally?
]
```

### Does layered versioning help or complicate this?

**It complicates.** Every query now needs to:
1. Decide which version(s) to include
2. Handle version-merging logic
3. Understand temporal semantics

This pushes **complexity onto the consumer** (the AI agent querying the graph).

**Counter-argument:** "But we need version-aware queries for diff/impact analysis!"

Yes, but those are **specific queries**, not the default case. The common case is "what does the code look like NOW?" — that should be trivial.

### Grafema's Target Environment

Remember our target: **massive legacy codebases** where:
- Type systems don't exist
- Custom build systems, templating engines
- Migration is economically unfeasible

In this context, version tracking is a **nice-to-have**, not a core requirement. The core requirement is: **understand the current state of the code**.

**Verdict:** Layered versioning adds complexity without serving the core mission.

---

## 2. Key Design Decisions

### 2.1 Where Does Version Live?

The proposal suggests version as an attribute of nodes/edges:

```typescript
Node: FUNCTION:foo:file.js
  versions:
    main: { line: 10, params: ["a", "b"], bodyHash: "abc123" }
    __local: { line: 12, params: ["a", "b", "c"], bodyHash: "def456" }
```

**Problem 1: Schema explosion**

Every node type now needs:
- Base identity fields (type, name, file)
- Version-specific fields (line, column, params, returnType, bodyHash...)

Who decides which fields are version-specific? It's not obvious:
- `name` — stable across versions (semantic identity)
- `line` — changes on version
- `exported` — could change (refactoring)
- `async` — could change (refactoring)

**Problem 2: Query complexity**

```typescript
// Before layered versioning:
const func = await graph.getNode('FUNCTION:foo:file.js');
console.log(func.line);  // 10

// After layered versioning:
const func = await graph.getNode('FUNCTION:foo:file.js');
console.log(func.versions.main.line);  // Which version? Default?
console.log(func.versions.__local?.line);  // Optional chaining everywhere
```

**Problem 3: Edge semantics**

```
Edge: CALLS
  src: FUNCTION:foo
  dst: FUNCTION:bar
  versions: [main, __local]  // exists in both
```

What if `foo@__local` calls `bar`, but `foo@main` doesn't? The edge:
- Exists in `__local`
- Doesn't exist in `main`

Is this "versions: [__local]"? Or do we create two separate edges? Or one edge with complex metadata?

### 2.2 "Node exists in main but deleted in __local"

Current proposal doesn't address this clearly.

**Option A: Tombstone**
```
Node: FUNCTION:baz:file.js
  versions:
    main: { ... }
    __local: { _deleted: true }
```
Ugly. Now every query needs to check `_deleted`.

**Option B: Absence indicates deletion**
```
Node: FUNCTION:baz:file.js
  versions:
    main: { ... }
    // no __local = deleted in local
```
How do you query "what was deleted locally"? You need to scan ALL nodes with `main` but no `__local`.

**Option C: Separate tracking**
```
deletions:
  - stableId: FUNCTION:baz:file.js
    version: __local
```
Now you have two sources of truth.

**None of these are elegant.** The reason: we're trying to encode a **directed acyclic graph of changes** (like Git commits) into a flat key-value model.

### 2.3 "Give me the graph as of version X"

This is the killer query. If you can't do this efficiently, the entire model collapses.

**With layered versioning:**
```typescript
async function getGraphAtVersion(version: string): AsyncGenerator<Node> {
  for await (const node of graph.queryNodes()) {
    if (node.versions[version]) {
      yield { ...node.base, ...node.versions[version] };
    }
  }
}
```

**Problems:**
1. Must scan ALL nodes to construct a version snapshot
2. Memory pressure: holding entire graph in memory
3. No indexing by version: every query is O(n)

**Alternative: Version as first-class entity**

What if we flip the model?

```
Version: main
  nodes: [...]
  edges: [...]

Version: __local
  nodes: [...] (only changed nodes)
  edges: [...]
  parent: main
```

This is basically Git's model. Much better for "give me version X", but now you have **two storage models** — one for the graph, one for versions.

---

## 3. Impact on Existing Code

### 3.1 NodeFactory

Currently generates nodes like:
```typescript
static createFunction(name, file, line, column, options) {
  return {
    id: `${file}:FUNCTION:${name}:${line}:${counter}`,
    type: 'FUNCTION',
    name,
    file,
    line,
    column,
    ...options
  };
}
```

**With layered versioning:**

```typescript
static createFunction(name, file, line, column, version, options) {
  const stableId = `FUNCTION:${name}:${file}`;
  return {
    stableId,
    type: 'FUNCTION',
    name,
    file,
    version,
    versionData: { line, column, ...options }
  };
}
```

**Changes required:**
- All `create*` methods need `version` parameter
- Need to separate "identity fields" from "version-specific fields"
- ID generation changes completely

**Estimate:** Major refactor, ~20+ files affected.

### 3.2 GraphBuilder

Currently buffers nodes and edges, then flushes:
```typescript
this._bufferNode(funcData as GraphNode);
// ...
await this._flushNodes(graph);
```

**With layered versioning:**

```typescript
// Need to check if node exists first
const existing = await graph.getNode(stableId);
if (existing) {
  // Merge version data
  await graph.addVersion(stableId, version, versionData);
} else {
  // Create new node with first version
  await graph.addNode({ stableId, versions: { [version]: versionData } });
}
```

**Problems:**
1. **Kills batching:** Every node now requires a lookup
2. **N+1 problem:** Can't buffer anymore, must query for each node
3. **Complexity explosion:** GraphBuilder becomes aware of versioning semantics

**Estimate:** Complete rewrite of GraphBuilder.

### 3.3 RFDBServerBackend

Currently uses simple add/get operations:
```typescript
await this.client.addNodes(wireNodes);
```

**With layered versioning:**

Backend needs:
- `getNode(stableId)` — returns all versions
- `addVersion(stableId, version, data)` — add/update version
- `removeVersion(stableId, version)` — for deletions
- `queryNodesByVersion(version, query)` — filtered queries

**Estimate:** Significant backend changes, protocol changes.

---

## 4. Trade-offs

### 4.1 Storage Efficiency vs Query Complexity

**Layered versioning claims storage efficiency:**
- One node entry with multiple versions
- Vs. `foo@main` and `foo@__local` as separate nodes

**Reality check:**

For a 10,000 node graph:
- Separate nodes: 10,000 main + 500 local changes = 10,500 nodes
- Layered: 10,000 nodes with embedded version data

**Actual storage difference:** Minimal (500 extra entries).

**Query complexity cost:** Every query must understand versions.

**The trade-off is WRONG.** We're saving trivial storage at the cost of massive query complexity.

### 4.2 Simplicity vs Flexibility

**Simplicity (current model, with upsert fix):**
- Node = latest state
- Want diff? Run analysis twice, compare
- Simple queries, simple model

**Flexibility (layered versioning):**
- Node = history of states
- Diff built-in
- Complex queries, complex model

**Which serves Grafema's mission better?**

Remember: "AI should query the graph, not read code."

AI agents need **simple, predictable queries**. If the agent has to understand version semantics to ask "what functions are in this file?", we've failed.

---

## 5. Alternative: Version as Context, Not Data

Instead of storing versions in nodes, what if version is a **query-time context**?

```typescript
// Analysis produces nodes into named "layers"
await analyzer.analyze(files, { layer: 'main' });
await analyzer.analyze(changedFiles, { layer: '__local' });

// Query specifies layer
const functions = await graph.queryNodes({ type: 'FUNCTION', layer: 'main' });

// Diff is explicit
const diff = await graph.diffLayers('main', '__local');
```

**Benefits:**
- Storage remains simple (node = node, no embedded versions)
- Query complexity is opt-in (only when you NEED version context)
- Diff becomes a first-class operation, not emergent behavior

**This is closer to Git's model:** Branches are pointers to commits, not embedded in the content.

---

## 6. My Recommendation

### Is layered versioning the RIGHT architecture for Grafema?

**No.** Here's why:

1. **It solves the wrong problem.** REG-118 is about duplicate nodes on re-analysis. Fix upsert semantics, problem solved.

2. **It adds complexity without proportional value.** Version tracking is a feature, not a core requirement. The complexity cost is high, the benefit is marginal.

3. **It complicates the core mission.** "AI queries the graph" becomes "AI queries the graph AND understands versioning semantics."

4. **It's premature optimization.** We don't have clear user stories for version-aware queries. Design should follow need.

### Non-negotiables

If we DO implement versioning (after fixing REG-118 and validating the need):

1. **Version must NOT be embedded in nodes.** Use layers/contexts instead.

2. **Default queries return "current" state.** Version-aware queries are explicit.

3. **Diff is a first-class operation.** Not "compare version attributes on every node."

4. **Incremental analysis uses layers, not embedded versions.** `__local` layer, `main` layer — not `foo@main`, `foo@__local`.

5. **NodeFactory, GraphBuilder remain version-agnostic.** Layer/version is a storage concern, not a node concern.

### What to do NOW

1. **Fix REG-118 with upsert semantics** (TRIZ analysis was right: use semantic ID as primary key)

2. **Delete IncrementalAnalysisPlugin's `@version` suffix approach.** It creates the duplication problem REG-118 describes.

3. **Implement "Clear Before Write" as interim.** Before analyzing a file, delete its nodes. Simple, correct, fast.

4. **Collect user stories for versioning.** Who needs it? What queries? What's the actual use case?

5. **Design versioning AFTER understanding the need.** Don't architect in a vacuum.

---

## 7. Summary Table

| Aspect | Layered Versioning | My Recommendation |
|--------|-------------------|-------------------|
| Node identity | stableId + versions object | Simple ID (semantic) |
| Version storage | Embedded in node | Separate layer/context |
| Default query | Requires version selection | Returns current state |
| Diff capability | Implicit (compare versions) | Explicit (diff operation) |
| REG-118 fix | Doesn't solve it | Upsert with semantic ID |
| Complexity | High (every component changes) | Low (fix upsert, done) |
| Grafema vision alignment | Poor (complicates queries) | Good (simple queries) |

---

## 8. Final Word

I understand the appeal of layered versioning. It feels like an elegant, unified model. But elegance in design doesn't always mean elegance in use.

**The question isn't "is this a good data model?"**

**The question is "does this serve our users and our mission?"**

For Grafema — a tool where AI agents query the graph instead of reading code — the answer is no. Complexity in the data model becomes complexity in every query, which becomes confusion for the AI agent.

Keep it simple. Fix the actual bug (REG-118). Collect real requirements before designing versioning.

---

*"I don't care if it works. Is it RIGHT?"*

— Don Melton
