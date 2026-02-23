# REG-552 Implementation Report

## Summary

Added `else` branches to ClassVisitor's `ClassProperty` handlers so that non-function TypeScript class fields (`private graph: GraphBackend`, `readonly count: number`, etc.) produce VARIABLE nodes visible in the graph, with accessibility, readonly, and type annotation metadata.

## Changes Made

### Change 1: `packages/core/src/plugins/analysis/ast/types.ts` (line 262)

Added three optional fields to `VariableDeclarationInfo`:

```typescript
// REG-552: TypeScript class property metadata
accessibility?: 'public' | 'private' | 'protected';  // undefined = implicit public
isReadonly?: boolean;                                   // true for readonly modifier
tsType?: string;                                        // TypeScript type annotation string
```

### Change 2: `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` (line 30)

Added `typeNodeToString` to import from `TypeScriptVisitor.js`:

```typescript
import { extractTypeParameters, typeNodeToString } from './TypeScriptVisitor.js';
```

### Change 3: `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` (lines 335-367)

Added `else` branch to **ClassDeclaration** handler's `ClassProperty` visitor. When the property value is not a function (arrow/function expression), the branch:

1. Skips computed keys (`[Symbol.iterator]`)
2. Skips `declare`-only fields (type-only, no runtime presence)
3. Computes a semantic ID for the field as a VARIABLE node
4. Adds the field ID to `currentClass.properties` for HAS_PROPERTY edges
5. Extracts `accessibility`, `readonly`, and type annotation via `typeNodeToString`
6. Pushes a `VariableDeclarationInfo` to `collections.variableDeclarations`

### Change 4: `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` (lines 813-845)

Added the identical `else` branch to **ClassExpression** handler's `ClassProperty` visitor, matching the same logic as Change 3.

### Change 5: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` (lines 275-287)

Replaced the simple variable buffering loop with metadata extraction logic (mirrors the REG-401 FUNCTION pattern):

```typescript
for (const varDecl of variableDeclarations) {
  const { accessibility: _accessibility, isReadonly: _isReadonly, tsType: _tsType, ...varData } = varDecl;
  const node = varData as unknown as GraphNode;
  if (_accessibility !== undefined || _isReadonly || _tsType) {
    if (!node.metadata) node.metadata = {};
    if (_accessibility !== undefined) (node.metadata as Record<string, unknown>).accessibility = _accessibility;
    if (_isReadonly) (node.metadata as Record<string, unknown>).readonly = true;
    if (_tsType) (node.metadata as Record<string, unknown>).type = _tsType;
  }
  this._bufferNode(node);
}
```

## Build Result

`pnpm build` -- **SUCCESS**. All 8 workspace packages compiled without TypeScript errors. Rust warnings are pre-existing and unrelated.

## Snapshot Test Result

`node --test --test-concurrency=1 test/unit/GraphSnapshot.test.js` -- **ALL 6 PASS**. No snapshot regeneration was needed (existing fixtures are JS-based and don't contain TypeScript class property declarations).

## Issues Encountered

None. Implementation was straightforward, following the existing pattern from REG-271 (ClassPrivateProperty handler) and REG-401 (metadata extraction in GraphBuilder).
