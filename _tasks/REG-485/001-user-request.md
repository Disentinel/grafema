# REG-485: MethodCallResolver — cross-class method calls not resolved

## Problem

`impact addNodes` returns 0 callers despite many call sites existing in the codebase (GraphBuilder, PhaseRunner, 21+ analysis plugins all call `graph.addNodes()`).

MethodCallResolver now runs correctly (REG-483 fix: +600 edges), but it doesn't resolve method calls through variable type chains like:

```typescript
// In plugin code:
context.graph.addNodes(nodes);  // graph is typed as GraphBackend

// Definition lives in:
class RFDBServerBackend extends GraphBackend {
  async addNodes(nodes) { ... }
}
```

## Root Cause

MethodCallResolver resolves `obj.method()` calls but doesn't trace `obj`'s type through:

1. Interface/abstract class → concrete implementation chain
2. Variable assignment chains (`const graph = context.graph` where context comes from PluginContext interface)
3. Constructor injection patterns

## Expected Behavior

`impact addNodes` should show all 21+ analysis plugins, GraphBuilder, PhaseRunner etc. as callers.

## Context

Found during dogfooding after fixing enricher propagation (REG-483). The enrichers now run, but cross-class method resolution is a separate capability gap.

## Source

Linear issue REG-485 (task/REG-485 branch)
