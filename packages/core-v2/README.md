# @grafema/core-v2

> Declarative three-stage AST analysis pipeline for Grafema

**Warning: This package is in beta stage and the API may change between minor versions.**

## Overview

Core v2 replaces the imperative `GraphBuilder` from `@grafema/core` with a declarative, edge-map-driven pipeline. Instead of visitors manually creating edges via builder methods, core-v2 visitors are pure functions that return data (`GraphNode[]`, `GraphEdge[]`, `DeferredRef[]`), and the walk engine handles structural edges automatically using the edge map.

The pipeline runs in three stages:

1. **Walk** (Stage 1) -- Single recursive pass over the Babel AST. Each node is dispatched to a pure visitor function. The walk engine consults the `EDGE_MAP` to determine the correct structural edge type for each parent-child relationship (e.g., `ReturnStatement.argument` produces `RETURNS`, not `CONTAINS`). Scope stack is managed automatically with auto-pop.

2. **Post-file** (Stage 2) -- Resolves file-scoped deferred references using the scope tree built during the walk. `scope_lookup` and `export_lookup` refs are resolved here. A secondary pass (Stage 2.5) catches forward references and out-of-scope same-file declarations by name matching.

3. **Post-project** (Stage 3) -- Cross-file resolution. Takes `FileResult[]` from all files, builds a `ProjectIndex`, and resolves `import_resolve`, `call_resolve`, `type_resolve`, and `alias_resolve` deferred refs into concrete edges. Also derives transitive edges (`DERIVES_FROM`, `INSTANCE_OF`, `ELEMENT_OF`).

## Key Concepts

### Edge Map

The `EDGE_MAP` (`src/edge-map.ts`) is a declarative table mapping `ASTType.childKey` pairs to edge types. Instead of each visitor knowing which edge type to emit, the walk engine looks up `ForStatement.init` and emits `HAS_INIT`, `ReturnStatement.argument` and emits `RETURNS` (sourced from the enclosing function), etc. This eliminates a class of bugs where visitors create wrong edge types.

### Visitors

Visitors are pure functions: `(node, parent, ctx) => VisitResult`. They produce graph nodes, edges, and deferred references but perform no side effects. The walk engine handles scope management, structural edges, and child traversal. Every Babel AST node type must have a registered visitor -- encountering an unknown type is a fatal error.

### Deferred References

References that cannot be resolved at walk time are captured as `DeferredRef` objects with 6 concrete kinds:

| Kind | Resolved at | Purpose |
|------|------------|---------|
| `scope_lookup` | Stage 2 (file) | Variable references via scope chain |
| `export_lookup` | Stage 2 (file) | Named export resolution |
| `import_resolve` | Stage 3 (project) | Cross-file import binding |
| `call_resolve` | Stage 3 (project) | Function/method call binding |
| `type_resolve` | Stage 3 (project) | Type reference binding |
| `alias_resolve` | Stage 3 (project) | Re-export and alias chains |

### Scope Tracking

The scope tree (`src/scope.ts`) tracks declarations across `module`, `function`, `block`, `class`, `catch`, and `with` scopes. It handles `var` hoisting to the nearest function/module scope, detects variable shadowing, and supports `with` statement ambiguity. Closure captures are detected when a `scope_lookup` crosses a function boundary.

## Source Structure

```
src/
  index.ts          -- Public API exports
  walk.ts           -- Walk engine (Stage 1 + Stage 2)
  resolve.ts        -- File-level and project-level resolution (Stage 2.5 + Stage 3)
  edge-map.ts       -- Declarative AST child-key to edge-type mapping
  types.ts          -- Core type definitions (GraphNode, GraphEdge, DeferredRef, etc.)
  scope.ts          -- Scope tree construction and lookup
  registry.ts       -- JS/TS visitor registry (maps all Babel AST types to visitors)
  visitors/
    classes.ts      -- ClassBody, ClassMethod, ClassProperty, StaticBlock
    declarations.ts -- VariableDeclaration, FunctionDeclaration, ClassDeclaration
    expressions.ts  -- CallExpression, MemberExpression, ArrowFunction, etc.
    literals.ts     -- String, Number, Boolean, Null, BigInt, RegExp, Template
    misc.ts         -- Patterns, JSX, Decorator, RestElement, Super, etc.
    modules.ts      -- Import/Export declarations and specifiers
    statements.ts   -- If, For, While, Switch, Try/Catch, Block, etc.
    typescript.ts   -- TS interfaces, type aliases, enums, mapped types, etc.
```

## Integration

Core-v2 is used via the CLI with the `--engine v2` flag:

```bash
grafema analyze --engine v2 ./src
```

## Current Status

65% golden construct coverage (385/591 constructs). Active development.

## License

Apache-2.0
