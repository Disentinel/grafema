# REG-418: Duplicate inline CALL nodes from processVariableDeclarations

## Problem

`JSASTAnalyzer.processVariableDeclarations()` creates inline CALL nodes with IDs like `CALL#data.filter#index.js#7:18:inline` for member expression calls in variable initializers (e.g., `const valid = data.filter(this.validate)`).

The same call also gets a standard CALL node from `CallExpressionVisitor` with ID like `index.js->Pipeline->run->CALL->data.filter#0`.

This results in **two CALL nodes for the same call site** in the graph.

## Impact

- Graph has duplicate nodes for the same semantic entity
- `getAllNodes().find(n => n.type === 'CALL' && n.method === 'filter')` returns non-deterministic results
- CALLS edges are attached to the visitor-created node, not the inline one
- Discovered during REG-408 because changing ID format altered node ordering in RFDB

## Reproduction

```js
class Pipeline {
  validate(item) { return item != null; }
  run(data) {
    const valid = data.filter(this.validate);
  }
}
```

## Root cause

`processVariableDeclarations()` in JSASTAnalyzer.ts creates CALL nodes independently of the visitor pipeline.

## Expected

One CALL node per call site.
