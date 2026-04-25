# Don Melton - Revised Architecture for REG-395

## Pivot: From `grafema grep` to Closing the Property Access Gap

### Problem
`grafema query maxBodyLength` returns NOTHING. Property reads are invisible in the graph.

### Solution: PROPERTY_ACCESS Nodes

New node type following the CALL node pattern (one per access site):

```
[PROPERTY_ACCESS:maxBodyLength]
  file: lib/adapters/http.js
  line: 279
  name: "maxBodyLength"
  metadata: { objectName: "config", fullExpression: "config.maxBodyLength" }
```

Contained in enclosing scope via CONTAINS edges (like CALL nodes).

### Why Nodes, Not Edges
- Nodes are searchable via queryNodes — edges metadata is NOT
- Consistent with CALL node pattern
- `grafema query maxBodyLength` works directly

### Prior Art
Code Property Graphs (Joern, Qwiet AI) track member expressions as nodes.
This is industry-standard for graph-based code analysis.

### Performance
- RFDB handles millions of nodes — no explosion concern
- ~50-100ms overhead for 10K property accesses during analysis
- O(log N) query via indexed lookup

### Scope
- Add PROPERTY_ACCESS to node types
- Add visitor in analyzer (MemberExpression handling)
- GraphBuilder creates nodes + containment edges
- ~400 LOC across 3-4 files

### Priority 2: Attribute Search
If PROPERTY_ACCESS name = property name, then `grafema query` works directly.
Separate attribute search may not be needed for this use case.
