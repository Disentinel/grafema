# User Request: REG-152

## Task
Implement FLOWS_INTO edges for `this.prop = value` patterns in class methods.

## Linear Issue
https://linear.app/reginaflow/issue/REG-152/flows-into-edges-for-thisprop-value-patterns-in-class-methods

## Context

REG-134 added PARAMETER nodes for class constructor/method parameters. However, FLOWS_INTO edges for `this.prop = value` patterns are still NOT created.

## Problem

When analyzing:

```javascript
class Config {
  constructor(handler) {
    this.handler = handler;  // No FLOWS_INTO edge created
  }
}
```

GraphBuilder.bufferObjectMutationEdges() explicitly skips edge creation when `objectName === 'this'` (line 1364):

```typescript
// Skip 'this' - it's not a variable node
if (objectName !== 'this') {
  // ... find target variable ...
  if (!objectNodeId) continue;  // SKIP edge creation
}
```

## Impact

* Cannot track data flow from parameters to class instance properties
* Queries like `MATCH (p:PARAMETER)-[:FLOWS_INTO]->(target)` return nothing for class methods

## Skipped Tests

`/test/unit/ObjectMutationTracking.test.js`:

* `should track this.prop = value in constructor with objectName "this"`
* `should track this.prop = value in class methods`

## Solution Options (from issue)

1. **Create PROPERTY nodes** for class instance properties (`this.prop`)
2. **Change FLOWS_INTO semantics** to allow property-level targets without a destination node
3. **Use CLASS node as target** with property metadata on the edge

## Related

* REG-134: Created PARAMETER nodes for class methods (prerequisite, done)
* REG-114: Object Property Mutation Tracking (discovered limitation)
