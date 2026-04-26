# User Request: REG-115

## Linear Issue

**REG-115: Data Flow: Transitive reachability queries**

## Problem

Even with FLOWS_INTO edges, we need a way to query transitive data flow:

> "What objects eventually reach `graph.addNode()`?"

This requires traversing multiple edge types:

```
OBJECT_LITERAL
  → FLOWS_INTO → array
  → PASSES_ARGUMENT → func()
  → RETURNS → result
  → PASSES_ARGUMENT → addNode()
```

## Proposed API

```javascript
// Find all sources that flow into a sink
const sources = await graph.reachability({
  sink: 'CALL#addNode#...',
  edgeTypes: ['FLOWS_INTO', 'PASSES_ARGUMENT', 'ASSIGNED_FROM', 'RETURNS'],
  direction: 'backward',
  maxDepth: 10
});

// Find where a source flows to
const sinks = await graph.reachability({
  source: 'OBJECT_LITERAL#123',
  edgeTypes: ['FLOWS_INTO', 'PASSES_ARGUMENT'],
  direction: 'forward'
});
```

## Use Cases

* Security: "Does user input reach SQL query?"
* Validation: "Do all objects passed to addNode come from NodeFactory?"
* Impact analysis: "What functions are affected if this value changes?"

## Related

* REG-113: Array mutations (creates edges)
* REG-114: Object mutations (creates edges)
* This issue: queries over those edges

## Acceptance Criteria

- [ ] `graph.reachability()` API implemented
- [ ] Backward traversal works
- [ ] Forward traversal works
- [ ] Configurable edge types
- [ ] Depth limit works
- [ ] Performance acceptable for large graphs

## Blocks

- REG-98: Refactor: Migrate all node creation to NodeFactory
