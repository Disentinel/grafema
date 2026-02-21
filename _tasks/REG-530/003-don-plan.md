## Don's Plan: REG-530 — Multi-specifier imports resolve only to first specifier

### Problem

`findNodeAtCursor` returns the wrong IMPORT node when multiple specifiers share one line.
Root cause: ImportExportVisitor captures position from `ImportDeclaration` (the `import` keyword), not from individual `ImportSpecifier` nodes. All specifiers get the same column=0.

### Architecture

- **WireNode**: `{ id, nodeType, name, file, exported, metadata: string }` — metadata is JSON
- **BaseNodeRecord**: `{ id, type, name, file, line, column, metadata, ... }` — extra fields serialize into WireNode.metadata
- **ImportNodeRecord**: extends BaseNodeRecord with `column`, `source`, etc.
- When stored in RFDB, `line`, `column`, and all extra fields go into the `metadata` JSON string
- `parseNodeMetadata()` in vscode package deserializes back

### Plan

**4 files to change, ~30 LOC total:**

#### 1. ImportExportVisitor.ts — capture per-specifier columns

In the `ImportDeclaration` handler (line 108), when iterating specifiers, extract each specifier's column and endColumn from `spec.loc`:

```
ImportSpecifierInfo interface: add optional column?: number, endColumn?: number
```

For each ImportSpecifier:
- `column = getColumn(spec)` — specifier start column (e.g., `join` at col 9)
- `endColumn = getEndLocation(spec).column` — specifier end column (e.g., `join` ends at col 13)

For ImportDefaultSpecifier and ImportNamespaceSpecifier: same pattern.

Keep the ImportDeclaration-level `line` and `column` on ImportInfo as fallbacks.

#### 2. ImportSpecifierInfo + ImportInfo interfaces (same file)

```typescript
interface ImportSpecifierInfo {
  imported: string;
  local: string;
  importKind?: 'value' | 'type' | 'typeof';
  column?: number;      // NEW: specifier start column
  endColumn?: number;   // NEW: specifier end column
}
```

No changes to ImportInfo — it keeps the declaration-level line/column as fallback.

#### 3. ModuleRuntimeBuilder.ts — use per-specifier column

In `bufferImportNodes` (line 102), when creating import nodes per specifier:
- Use `spec.column ?? column ?? 0` instead of `column || 0` for the column parameter
- Pass `endColumn: spec.endColumn` in options

#### 4. ImportNode.ts — add endColumn to record

```typescript
interface ImportNodeRecord extends BaseNodeRecord {
  // existing fields...
  endColumn?: number;  // NEW: specifier end column for cursor matching
}

interface ImportNodeOptions {
  // existing fields...
  endColumn?: number;  // NEW
}
```

In `create()`: if `options.endColumn !== undefined`, set `record.endColumn = options.endColumn`.

#### 5. nodeLocator.ts — use column range matching

In `findNodeAtCursor` (line 45), when `nodeLine === line`:
- If node has `endColumn` metadata: check `column >= nodeColumn && column <= endColumn` → specificity 2000 (exact range match)
- Else: keep current distance-based matching (specificity 1000 - distance)

This means nodes WITH column ranges always beat nodes WITHOUT (2000 > 1000).

### Edge Cases

1. **Single specifier**: `import { join } from 'path'` — column range works, just one match
2. **Default import**: `import React from 'react'` — gets column range too
3. **Namespace import**: `import * as path from 'path'` — gets column range too
4. **Multi-line import**: `import {\n  join,\n  resolve\n}` — each specifier has its own line, so line-based matching already works. Column ranges are bonus.
5. **Mixed import**: `import React, { useState } from 'react'` — each specifier has own column range
6. **Dynamic imports**: `import('./module')` — no specifiers to split, unchanged
7. **Side-effect imports**: `import './polyfill'` — no specifiers, unchanged
8. **Cursor between specifiers**: e.g., on the comma between `join,` and `resolve` — no endColumn range matches, falls back to distance-based matching (closest column wins)
9. **Backward compatibility**: Old graphs without endColumn still work — distance-based matching is fallback
10. **Type imports**: `import { type Foo } from './bar'` — specifier has own loc, works same way

### Files to Modify

| File | Change | LOC |
|------|--------|-----|
| `packages/core/src/plugins/analysis/ast/visitors/ImportExportVisitor.ts` | Add column/endColumn to ImportSpecifierInfo, extract from spec.loc | ~10 |
| `packages/core/src/plugins/analysis/ast/builders/ModuleRuntimeBuilder.ts` | Use spec.column, pass endColumn in options | ~3 |
| `packages/core/src/core/nodes/ImportNode.ts` | Add endColumn to record + options + create() | ~5 |
| `packages/vscode/src/nodeLocator.ts` | Column range matching logic | ~10 |
| **Total** | | **~28 LOC** |

### Tests Needed

1. **ImportExportVisitor**: verify specifier-level columns are captured
2. **ImportNode**: verify endColumn is stored in record
3. **findNodeAtCursor**: mock nodes with endColumn, verify correct match for each specifier position
4. **GraphBuilder integration**: analyze multi-specifier import, verify each IMPORT node has distinct column/endColumn

### Not Changing

- `location.ts` — already has `getEndLocation()` helper
- `types.ts` (vscode) — `NodeMetadata` already has `endColumn?: number`
- No changes to RFDB storage — endColumn goes through existing metadata serialization
