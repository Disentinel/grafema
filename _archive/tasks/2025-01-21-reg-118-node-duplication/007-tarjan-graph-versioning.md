# Graph Versioning: A Graph-Theoretic Analysis

**Author:** Robert Tarjan (Graph Theory Analysis)
**Date:** 2025-01-22
**Context:** REG-118 and the broader question of graph versioning for Grafema

---

## 1. Problem Formalization

Let G = (V, E) be the code analysis graph where:
- V = set of nodes (FUNCTION, CLASS, IMPORT, etc.)
- E = set of directed edges (CALLS, CONTAINS, IMPORTS_FROM, etc.)

Each node v in V has:
- A **semantic identity** sigma(v) - what the entity IS (e.g., "function `foo` in file `bar.js`")
- **Attributes** A(v) - properties that may change (line number, parameters, etc.)

Each edge e = (u, v, type) in E represents a relationship between entities.

**The versioning problem:**

Given a sequence of analysis operations over time t_0, t_1, ..., t_n, we want to:
1. Efficiently update G when a subset of files changes
2. Compare G(t_i) with G(t_j)
3. Query G at any version efficiently
4. Minimize storage for unchanged subgraphs

---

## 2. Analysis of the Proposed "Versions as Attribute" Model

### 2.1 The Proposed Structure

```
Node {
  id: "FUNCTION:foo:file.js"  // stable semantic ID
  type: "FUNCTION"
  versions: {
    "main": { line: 10, params: ["a", "b"] },
    "__local": { line: 12, params: ["a", "b", "c"] }
  }
}

Edge {
  src: "FUNCTION:foo:file.js"
  dst: "FUNCTION:bar:file.js"
  type: "CALLS"
  versions: ["main", "__local"]
}
```

### 2.2 Evaluation

**Strengths:**
1. **Identity stability**: The semantic ID serves as a stable identifier across versions
2. **Space efficiency for unchanged entities**: If node attributes don't change, only version labels differ
3. **Natural representation of "same entity, different state"**

**Weaknesses:**

1. **Temporal query complexity**: Finding "all nodes in version X" requires O(|V|) scan if versions are embedded in nodes.

2. **Edge versioning is incomplete**: The proposed model tracks which versions an edge exists in, but not *attribute changes* to edges. Consider:
   ```
   // v1: foo calls bar with 2 args
   // v2: foo calls bar with 3 args
   ```
   The edge CALLS(foo, bar) exists in both, but its semantics differ.

3. **Deletion representation problem**: The proposed model doesn't cleanly handle "node existed in v1, deleted in v2". Options:
   - `versions: { "main": {...}, "__local": null }` - requires null checks
   - Separate "deleted" flag per version - adds complexity

4. **Structural changes are hard**: If foo() is split into foo1() and foo2(), how do we track this? The semantic ID changes.

---

## 3. Alternative Data Models from Graph Theory

### 3.1 Temporal Graphs (Snapshot Model)

Store a separate graph G_t for each time point t.

**Space complexity:** O(|V| * T) where T = number of versions
**Query complexity:** O(1) for single-version queries
**Diff complexity:** O(|V| + |E|) for comparing versions

**Verdict:** Wasteful for large, slowly-changing graphs. Not recommended.

### 3.2 Delta Encoding (Event Sourcing)

Store G_0 as base, then store deltas Delta_1, Delta_2, ... where:
- Delta_i = { add_nodes: [...], remove_nodes: [...], update_nodes: [...], add_edges: [...], ... }

**Space complexity:** O(|V_0| + sum of |Delta_i|)
**Query complexity:** O(sum of deltas) to reconstruct version i
**Diff complexity:** O(|Delta_i - Delta_j|) - trivial, deltas ARE the diff

**Verdict:** Good for audit trails and undo, but slow for random version access.

### 3.3 Copy-on-Write with Structural Sharing (Persistent Data Structures)

Like Clojure's persistent vectors or Git's tree structure:
- Each version is a root pointer
- Changed subtrees are copied, unchanged subtrees are shared

**Space complexity:** O(|V| + k*log(|V|)) for k changes
**Query complexity:** O(log(|V|)) per node lookup
**Diff complexity:** O(changed nodes) - only compare different subtrees

**Verdict:** Excellent for version-heavy workloads, but complex to implement.

### 3.4 Bitemporal Model (Validity Intervals)

Each node/edge carries [valid_from, valid_to) interval:

```
Node {
  id: "FUNCTION:foo:file.js",
  valid_from: "v1",
  valid_to: "v3",  // null = current
  attributes: {...}
}
```

**Space complexity:** O(|V| * average_changes_per_node)
**Query complexity:** O(log(versions)) with proper indexing
**Diff complexity:** O(entities_changed_between_versions)

**Verdict:** Industry standard for temporal databases. Scales well.

---

## 4. Recommended Model: Hybrid Bitemporal + Subgraph Partitioning

For Grafema's specific use case (code analysis with file-level updates), I recommend:

### 4.1 Core Principles

**Principle 1: File-Based Partitioning**

Partition V into subsets V_f for each file f:
- V = Union of V_f for all files f
- Each V_f contains all nodes with `file = f`

This exploits the **locality property**: when file f changes, only V_f needs updating.

**Principle 2: Monotonic Version Ordering**

Versions form a partially ordered set (poset):
- `main` is the shared baseline
- `__local` branches from `main`
- Git branches can form a DAG

**Principle 3: Validity Intervals at File Granularity**

Instead of per-node versioning, track file-level version stamps:

```
FileVersion {
  file: "foo.js",
  contentHash: "sha256:abc...",
  version: "__local",
  timestamp: 1705924800
}

Node {
  id: "FUNCTION:foo:file.js#10:0",  // includes position for uniqueness
  semanticId: "FUNCTION:foo:file.js",  // position-independent
  fileVersion: "sha256:abc...",  // links to FileVersion
  attributes: {...}
}
```

### 4.2 Data Structure

```typescript
interface VersionedGraph {
  // Current active version context
  activeVersion: VersionId;

  // File version tracking
  fileVersions: Map<FilePath, Map<VersionId, FileVersionInfo>>;

  // Node storage: semantic ID -> version -> full node
  nodes: Map<SemanticId, Map<VersionId, NodeData | DELETED>>;

  // Edge storage: (src, dst, type) -> version -> edge attributes
  edges: Map<EdgeKey, Map<VersionId, EdgeData | DELETED>>;

  // Indexes for efficient queries
  nodesByFile: Map<FilePath, Set<SemanticId>>;
  nodesByType: Map<NodeType, Set<SemanticId>>;

  // For each version, which files were modified from parent
  versionDelta: Map<VersionId, Set<FilePath>>;
}

type SemanticId = string;  // e.g., "FUNCTION:foo:file.js"
type EdgeKey = string;     // e.g., "FUNCTION:foo:file.js|CALLS|FUNCTION:bar:file.js"
type DELETED = symbol;     // Tombstone marker
```

### 4.3 Key Operations

**Extract Subgraph for File X:**
```
extractFileSubgraph(file: FilePath, version: VersionId):
  nodeIds = nodesByFile.get(file)
  result = new Graph()
  for id in nodeIds:
    node = resolveNode(id, version)  // handles version fallback
    if node != DELETED:
      result.addNode(node)
      // Add edges where this node is src or dst
      for edge in findEdgesInvolving(id, version):
        result.addEdge(edge)
  return result
```

**Complexity:** O(|V_f| + |E_f|) where V_f, E_f are nodes/edges involving file f.

**Replace Subgraph for File X:**
```
replaceFileSubgraph(file: FilePath, version: VersionId, newNodes: Node[], newEdges: Edge[]):
  // Step 1: Mark all existing nodes for this file as DELETED in new version
  for id in nodesByFile.get(file):
    nodes.get(id).set(version, DELETED)

  // Step 2: Mark all edges involving these nodes as DELETED
  for id in nodesByFile.get(file):
    for edgeKey in findEdgeKeysInvolving(id):
      edges.get(edgeKey).set(version, DELETED)

  // Step 3: Insert new nodes
  for node in newNodes:
    semanticId = computeSemanticId(node)
    nodes.getOrCreate(semanticId).set(version, node)
    nodesByFile.getOrCreate(file).add(semanticId)
    nodesByType.getOrCreate(node.type).add(semanticId)

  // Step 4: Insert new edges
  for edge in newEdges:
    edgeKey = computeEdgeKey(edge)
    edges.getOrCreate(edgeKey).set(version, edge)

  // Step 5: Record this file was modified
  versionDelta.getOrCreate(version).add(file)
```

**Complexity:** O(|V_f_old| + |E_f_old| + |V_f_new| + |E_f_new|)

**Resolve Node at Version (with fallback):**
```
resolveNode(semanticId: SemanticId, version: VersionId): NodeData | null:
  nodeVersions = nodes.get(semanticId)
  if nodeVersions == null:
    return null

  // Check if node exists in this exact version
  if nodeVersions.has(version):
    data = nodeVersions.get(version)
    return data == DELETED ? null : data

  // Fall back to parent version (e.g., __local -> main)
  parentVersion = getParentVersion(version)
  if parentVersion != null:
    return resolveNode(semanticId, parentVersion)

  return null
```

---

## 5. Diff Algorithm

### 5.1 File-Level Diff (Efficient)

When diffing version A vs version B, the key insight is:

**Only files in `versionDelta[A]` or `versionDelta[B]` can differ.**

```
diffVersions(versionA: VersionId, versionB: VersionId):
  changedFiles = union(versionDelta[versionA], versionDelta[versionB])

  diff = { addedNodes: [], removedNodes: [], changedNodes: [],
           addedEdges: [], removedEdges: [], changedEdges: [] }

  for file in changedFiles:
    graphA = extractFileSubgraph(file, versionA)
    graphB = extractFileSubgraph(file, versionB)
    fileDiff = diffGraphs(graphA, graphB)
    diff.merge(fileDiff)

  return diff
```

**Complexity:** O(sum of |V_f| + |E_f| for changed files only)

### 5.2 Graph Diff Algorithm

Given two graphs G_A and G_B with the same node ID scheme:

```
diffGraphs(G_A, G_B):
  nodesA = Set(G_A.nodeIds)
  nodesB = Set(G_B.nodeIds)

  addedNodes = nodesB - nodesA
  removedNodes = nodesA - nodesB
  commonNodes = nodesA intersect nodesB

  changedNodes = []
  for id in commonNodes:
    if not deepEqual(G_A.getNode(id), G_B.getNode(id)):
      changedNodes.push({ id, old: G_A.getNode(id), new: G_B.getNode(id) })

  // Same logic for edges...

  return { addedNodes, removedNodes, changedNodes, ... }
```

**Note on Graph Isomorphism:**

The semantic ID scheme sidesteps the graph isomorphism problem. We don't need to match "structurally equivalent" nodes - the semantic ID gives us identity directly. This is a **huge simplification**.

However, this means we can't detect "foo was renamed to bar" - we'll see "foo deleted, bar added". This is acceptable for code analysis (renaming IS a semantic change).

---

## 6. Query Complexity Analysis

### 6.1 "Find all CALLS edges in version main"

**Without versioning:** O(|E|) - scan all edges

**With proposed model (versions embedded):**
```
for edge in allEdges:
  if edge.type == 'CALLS' and 'main' in edge.versions:
    yield edge
```
Complexity: O(|E|)

**With recommended model (bitemporal + index):**
```
// Pre-built index: edges by type
callEdges = edgesByType.get('CALLS')  // Set of EdgeKey
for edgeKey in callEdges:
  edgeData = resolveEdge(edgeKey, 'main')
  if edgeData != null:
    yield edgeData
```
Complexity: O(|E_CALLS|) - only edges of type CALLS

**Recommendation:** Add type-based indexes for edges:
```
edgesByType: Map<EdgeType, Set<EdgeKey>>
```

### 6.2 "Find all functions that call X"

This is a reverse edge lookup (incoming edges to X).

**Without versioning:** O(|E|) or O(1) with adjacency list for incoming edges

**With recommended model:**
```
// Maintain incoming edge index
incomingEdges: Map<SemanticId, Set<EdgeKey>>

findCallers(targetId: SemanticId, version: VersionId):
  edgeKeys = incomingEdges.get(targetId)
  for edgeKey in edgeKeys:
    edge = resolveEdge(edgeKey, version)
    if edge != null and edge.type == 'CALLS':
      yield edge.src
```
Complexity: O(incoming degree of X)

---

## 7. Edge Cases and Solutions

### 7.1 Node Exists in v1, Deleted in v2

**Solution:** Use tombstone marker.

```
nodes.get("FUNCTION:foo:file.js") = {
  "main": { ...nodeData... },
  "__local": DELETED  // tombstone
}
```

When resolving:
- `resolveNode("FUNCTION:foo:file.js", "__local")` returns `null`
- `resolveNode("FUNCTION:foo:file.js", "main")` returns the node

**Garbage collection:** When a version is "sealed" (no longer active), tombstones can be compacted:
- If all descendants have DELETED, the entry can be fully removed
- If merging __local back to main with DELETED, propagate deletion

### 7.2 Edge with Deleted Endpoint (Dangling Edge)

**Invariant:** An edge should only exist if both endpoints exist in that version.

**Prevention strategy:**
When deleting a node, automatically mark all incident edges as DELETED:

```
deleteNode(semanticId, version):
  nodes.get(semanticId).set(version, DELETED)

  // Find and delete all incident edges
  for edgeKey in outgoingEdges.get(semanticId):
    edges.get(edgeKey).set(version, DELETED)
  for edgeKey in incomingEdges.get(semanticId):
    edges.get(edgeKey).set(version, DELETED)
```

This is analogous to **cascading delete** in relational databases.

### 7.3 Cross-File Edges and Partial Updates

When file A imports from file B, there's an edge:
`IMPORT:foo:A.js --IMPORTS_FROM--> EXPORT:foo:B.js`

If only A.js is re-analyzed:
- The IMPORT node gets updated
- The edge to B.js's EXPORT might become invalid if B.js changed independently

**Solution:** Edge validation on query, not on write.

```
resolveEdge(edgeKey, version):
  edge = edges.get(edgeKey).get(version)
  if edge == null or edge == DELETED:
    return null

  // Validate endpoints exist
  srcNode = resolveNode(edge.src, version)
  dstNode = resolveNode(edge.dst, version)

  if srcNode == null or dstNode == null:
    return null  // Dangling edge - treat as non-existent

  return edge
```

This is **lazy validation** - we don't maintain perfect consistency, but queries return valid results.

### 7.4 Version Branch and Merge

**Branch:** Create new version with parent pointer.
```
branchVersion(parentVersion, newVersionName):
  versionParents.set(newVersionName, parentVersion)
  versionDelta.set(newVersionName, new Set())  // No changes yet
```

**Merge:** More complex. Need to:
1. Identify conflicting changes (same file modified in both branches)
2. Apply non-conflicting changes
3. Resolve conflicts (semantic merge or manual)

For Grafema's use case (main vs __local), merge is typically:
- "Accept all __local changes" (commit local changes)
- "Discard __local" (reset to main)

Full 3-way merge is rarely needed.

---

## 8. Storage Backend Recommendations

### 8.1 For RFDB (Rust Backend)

The Rust backend should implement:

1. **Versioned node storage** with O(1) lookup by (semanticId, version)
2. **Cascading soft-delete** when nodes are removed
3. **Efficient range queries** for "all nodes in file X"
4. **Version metadata** tracking which files changed

Key insight: The current `addNodes()` behavior (INSERT without check) is correct IF we first delete old nodes. The issue is the orchestration layer not calling delete.

### 8.2 Index Structures

Recommended indexes:
```rust
// Primary storage
nodes: HashMap<SemanticId, HashMap<VersionId, Option<NodeData>>>
edges: HashMap<EdgeKey, HashMap<VersionId, Option<EdgeData>>>

// Secondary indexes
nodes_by_file: HashMap<FilePath, HashSet<SemanticId>>
nodes_by_type: HashMap<NodeType, HashSet<SemanticId>>
edges_by_type: HashMap<EdgeType, HashSet<EdgeKey>>
incoming_edges: HashMap<SemanticId, HashSet<EdgeKey>>
outgoing_edges: HashMap<SemanticId, HashSet<EdgeKey>>
```

All indexes should be maintained incrementally on insert/delete.

---

## 9. Summary of Recommendations

### 9.1 For REG-118 (Immediate Fix)

**Do NOT implement full versioning yet.**

The immediate fix is simpler:
1. Before re-analyzing file F, delete all nodes where `file = F`
2. Delete all edges involving those nodes
3. Insert new nodes/edges

This is **Clear-and-Rebuild** and is correct for a single-version system.

### 9.2 For Future Versioning

When implementing versioning:

1. **Use file-based partitioning** - exploit locality
2. **Use bitemporal validity intervals** - industry standard, scales well
3. **Semantic IDs as stable identity** - already implemented, good choice
4. **Tombstones for deletion** - don't actually remove, mark as deleted
5. **Lazy edge validation** - validate on query, not on write
6. **Version DAG** - support branching with parent pointers

### 9.3 Key Invariants to Maintain

1. **Semantic ID stability:** Same entity always has same semantic ID across versions
2. **Edge consistency:** Edges reference semantic IDs, not version-specific IDs
3. **File partitioning:** Each node belongs to exactly one file (for indexed lookup)
4. **Version monotonicity:** Versions form a DAG with clear parent relationships
5. **Cascading delete:** Deleting a node marks all incident edges as deleted

### 9.4 What NOT to Do

1. **Don't embed version in node ID** - this defeats semantic identity
2. **Don't store full graph per version** - wasteful
3. **Don't validate edges on write** - creates ordering dependencies
4. **Don't use UPSERT as primary deduplication** - hides logic errors upstream

---

## 10. Complexity Summary

| Operation | Without Versioning | With Versioning |
|-----------|-------------------|-----------------|
| Insert node | O(1) | O(1) |
| Delete node (cascading) | O(degree) | O(degree) |
| Query node by ID | O(1) | O(version depth) |
| Query by file | O(\|V_f\|) | O(\|V_f\|) |
| Query by type | O(\|V_type\|) | O(\|V_type\|) |
| Diff versions | N/A | O(changed files only) |
| Replace file subgraph | O(\|V_f\| + \|E_f\|) | O(\|V_f\| + \|E_f\|) |

The versioning overhead is minimal if implemented correctly.

---

*"An algorithm must be seen to be believed."*
-- Donald Knuth

The theoretical foundations are sound. The implementation complexity lies in maintaining the invariants across concurrent operations and handling the edge cases around cross-file references. But these are engineering challenges, not fundamental barriers.

---

**Robert Tarjan**
