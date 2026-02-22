# REG-552: Implementation Report

**Author:** Rob Pike (Implementer)
**Date:** 2026-02-22
**Updated:** 2026-02-22 (post Uncle Bob review fixes)

---

## Changes Made

### 1. `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`

**Import addition (line 30):**
Added `typeNodeToString` to the import from `./TypeScriptVisitor.js`:
```typescript
import { extractTypeParameters, typeNodeToString } from './TypeScriptVisitor.js';
```

**New private method: `handleNonFunctionClassProperty` (lines 165-213):**
Extracted from the duplicated `else` branches in both ClassDeclaration and ClassExpression handlers (Uncle Bob review Issue 1 — blocker). The method takes `propNode`, `propName`, `propLine`, `propColumn`, `currentClass`, `className`, `module`, `collections`, and `scopeTracker` as parameters. It:
1. Computes a semantic ID via `computeSemanticIdV2('VARIABLE', propName, ...)`
2. Null-guards `currentClass.properties` before push (matching REG-271 pattern)
3. Extracts modifier from `accessibility` and `readonly` fields
4. Extracts TypeScript type annotation via `typeNodeToString`
5. Pushes to `collections.variableDeclarations` with `isClassProperty: true`

**ClassDeclaration > ClassProperty handler:**
The `else` branch now calls `this.handleNonFunctionClassProperty(...)` — five lines instead of ~35.

**ClassExpression > ClassProperty handler:**
Same call to `this.handleNonFunctionClassProperty(...)`. Added comment explaining that decorator extraction is intentionally omitted for ClassExpression properties (Uncle Bob review Issue 3).

### 2. `packages/core/src/plugins/analysis/ast/types.ts`

**`VariableDeclarationInfo` extended (Uncle Bob review Issue 2):**
Added `metadata?: Record<string, unknown>` field to the interface. The `isClassProperty` and `isStatic` fields already existed from REG-271. This removes the `as any` cast on the pushed object literal in `handleNonFunctionClassProperty`.

### 3. `test/unit/ClassPropertyDeclarations.test.js`

Fixed test assertions to match RFDB storage behavior. The RFDB client/server pipeline flattens nested `metadata` objects into top-level node fields. Changed:
- `node.metadata?.modifier` -> `node.modifier`
- `node.metadata?.type` -> `node.declaredType`

Renamed the stored field from `type` to `declaredType` to avoid collision with the node's own `type` field (`'VARIABLE'`), which the RFDB `_parseNode` strips during deserialization.

---

## Uncle Bob Review Fixes (Post-Review)

| Issue | Severity | Fix |
|-------|----------|-----|
| Duplicated ~35-line else branch | Blocker | Extracted `handleNonFunctionClassProperty` private method, called from both handlers |
| `as any` cast on variableDeclarations push | Minor | Added `metadata?: Record<string, unknown>` to `VariableDeclarationInfo` interface |
| Missing decorator omission comment in ClassExpression | Minor | Added two-line comment explaining intentional omission |

---

## brandNodeInternal Verification

**Result:** `brandNodeInternal` does NOT strip metadata.

Located at `packages/core/src/core/brandNodeInternal.ts`, it is a pure type cast:
```typescript
export function brandNodeInternal<T extends BaseNodeRecord>(node: T): BrandedNode<T> {
  return node as BrandedNode<T>;
}
```

No field stripping occurs. All fields survive the branding.

### RFDB Metadata Flattening (Discovery)

During implementation, discovered that the RFDB storage pipeline flattens nested `metadata` objects into top-level node fields. The chain is:

1. `GraphBuilder._bufferNode()` -> `_nodeBuffer` (fallback path, since `batchNode` is not available on test backend)
2. `_flushFallbackBuffers()` -> `RFDBServerBackend.addNodes()`
3. `addNodes` destructures the node: `{ id, type, ..., ...rest }` and serializes `rest` (including nested `metadata: {modifier, type}`) as JSON
4. `rfdb-client/base-client.ts addNodes` re-parses the metadata JSON and re-serializes it — the nested `metadata` object stays intact through this step
5. However, when reading back via `_parseNode`, the metadata JSON is parsed and spread as `...safeMetadata` into the returned node object
6. The `type` field inside the nested metadata collides with `_parseNode`'s exclusion of `type` from `safeMetadata`, causing the declared type to be silently dropped

**Fix applied:** Used `declaredType` instead of `type` as the field name for the TypeScript type annotation, avoiding the collision. The `modifier` field has no collision and works correctly at top level.

---

## Build Result

Build succeeds with no errors:
```
pnpm build  # All packages compiled successfully
```

## Test Result

All 7 tests pass:
```
node --test test/unit/ClassPropertyDeclarations.test.js

✔ should create VARIABLE nodes for fields with private/public/protected modifiers
✔ should store TypeScript type annotation in declaredType
✔ should create HAS_PROPERTY edge from CLASS to field VARIABLE
✔ should record correct source position for field
✔ should handle readonly modifier
✔ should index field with initializer value
✔ should not break function-valued class properties (regression check)

tests 7 | pass 7 | fail 0
```

Regression test suite also passes:
```
node --test test/unit/ClassPrivateMembers.test.js
tests 28 | pass 27 | fail 0 | skipped 1
```

## Commit Hash

Not yet committed (awaiting user instruction).
