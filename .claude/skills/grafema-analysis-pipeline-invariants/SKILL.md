---
name: grafema-analysis-pipeline-invariants
description: |
  Pattern for adding data quality invariants to Grafema's analysis pipeline that
  surface bugs at analysis time instead of silently producing corrupt graph data.
  Use when: (1) suspecting a node type is missing required fields, (2) adding a new
  required field to node metadata, (3) debugging "works on our codebase but breaks
  on open-source" issues. Key insight: JSASTAnalyzer silently swallows all errors
  in its catch block — use GraphDataError to bypass it.
author: Claude Code
version: 1.0.0
date: 2026-02-21
---

# Grafema Analysis Pipeline Invariants

## Problem

`JSASTAnalyzer` wraps each module analysis in a silent catch:
```ts
} catch {
  // Error analyzing module - silently skip, caller handles the result
}
```

Any validation thrown inside `GraphBuilder._bufferNode` or builders gets swallowed.
Corrupt data ends up in the graph silently.

## Pattern: GraphDataError

`GraphDataError` is a special error class that bypasses the silent catch:

```ts
// GraphBuilder.ts
export class GraphDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphDataError';
  }
}
```

In `JSASTAnalyzer.ts`:
```ts
import { GraphBuilder, GraphDataError } from './ast/GraphBuilder.js';

} catch (err) {
  if (err instanceof GraphDataError) throw err; // propagate data quality errors
  // Error analyzing module - silently skip, caller handles the result
}
```

## Where to Add Guards

The canonical place: `GraphBuilder._bufferNode()` — all nodes pass through here
before being written to the graph. Guards here cover all builders.

```ts
private _bufferNode(node: GraphNode): void {
  if (!this._graph) throw new Error('...');
  const n = node as Record<string, unknown>;

  // DO NOT REMOVE: invariant guard for CALL node data quality.
  if (n['type'] === 'CALL' || n['nodeType'] === 'CALL') {
    if (n['endLine'] === undefined || n['endColumn'] === undefined || (n['endLine'] as number) <= 0) {
      throw new GraphDataError(
        `CALL node missing endLine/endColumn: name="${n['name']}" file="${n['file']}" ` +
        `line=${n['line']} col=${n['column']} endLine=${n['endLine']} endColumn=${n['endColumn']} id="${n['id']}"`
      );
    }
  }
  // ...
}
```

## When to Use

- Adding a new required field to a node type → add a guard immediately
- Testing against open-source codebases → existing guards catch indexer gaps
- After refactoring a visitor → guards validate the refactor didn't drop fields

## Guard vs Warning

Use `GraphDataError` (throws) for:
- Fields required for core functionality (cursor matching, data flow, etc.)
- Invariants that should never be violated

Use `console.warn` for:
- Optional enrichment data that might legitimately be absent
- Cross-file references that may not resolve

## Existing Guards (as of 2026-02-21)

- `CALL` nodes: `endLine !== undefined && endColumn !== undefined && endLine > 0`
  Location: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts:_bufferNode`
