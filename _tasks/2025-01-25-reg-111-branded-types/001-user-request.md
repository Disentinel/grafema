# REG-111: Add TypeScript type enforcement to prevent inline node creation

## Task

Add TypeScript type constraints to make NodeFactory the only way to create valid nodes.

## Current State

Anyone can create inline objects that satisfy the node interface, bypassing NodeFactory validation.

## Proposed Solution (from Linear)

### Option 1: Branded Types (recommended)

```typescript
const NODE_BRAND = Symbol('ValidNode');
type ValidNode<T> = T & { [NODE_BRAND]: true };

// Factory methods return branded type
static createFunction(...): ValidNode<FunctionNodeRecord> { ... }

// graph.addNode only accepts branded nodes
addNode(node: ValidNode<NodeRecord>): void;
```

### Option 2: Private Constructor Pattern

```typescript
class FunctionNode {
  private constructor(data: FunctionNodeRecord) { ... }

  static create(...): FunctionNode {
    return new FunctionNode(validated);
  }
}
```

## Acceptance Criteria

- [ ] TypeScript prevents inline node creation at compile time
- [ ] Factory is the only valid way to create nodes
- [ ] All tests pass
