# REG-530: Don's Exploration Report

## Task Summary

`findNodeAtCursor` matches IMPORT nodes by line number only, not by column range. When `import { join, resolve, basename } from 'path'` has multiple specifiers on one line, hovering over `resolve` or `basename` returns `IMPORT "join"` instead of the correct node.

## 1. `findNodeAtCursor` Implementation

**File:** `/Users/vadimr/grafema-worker-1/packages/vscode/src/nodeLocator.ts`
**Lines:** 19-95

### Current Logic

```typescript
export async function findNodeAtCursor(
  client: BaseRFDBClient,
  filePath: string,
  line: number,
  column: number
): Promise<WireNode | null> {
  // Get all nodes in this file
  const fileNodes = await client.getAllNodes({ file: filePath });

  if (fileNodes.length === 0) {
    return null;
  }

  // Find nodes that contain the cursor position
  const matchingNodes: Array<{ node: WireNode; specificity: number }> = [];

  for (const node of fileNodes) {
    const metadata = parseNodeMetadata(node);
    const nodeLine = metadata.line;

    if (nodeLine === undefined) {
      continue;
    }

    // Simple matching: node line matches cursor line
    // More sophisticated matching could use startLine/endLine ranges
    if (nodeLine === line) {
      // Prefer nodes with column info closer to cursor
      const nodeColumn = metadata.column ?? 0;
      const distance = Math.abs(nodeColumn - column);

      matchingNodes.push({
        node,
        specificity: 1000 - distance, // Higher specificity for closer matches
      });
    }

    // Also check for range-based matching if we have endLine
    const endLine = metadata.endLine;
    if (endLine !== undefined && nodeLine <= line && endLine >= line) {
      // Node spans multiple lines and contains cursor
      const span = endLine - nodeLine + 1;
      matchingNodes.push({
        node,
        specificity: 500 - span, // Prefer smaller spans (more specific)
      });
    }
  }

  if (matchingNodes.length === 0) {
    // Fallback: find closest node by line number
    // ... (not relevant to this bug)
  }

  // Sort by specificity (higher is more specific)
  matchingNodes.sort((a, b) => b.specificity - a.specificity);

  return matchingNodes[0].node;
}
```

### Bug Analysis

**Lines 43-54:** The algorithm calculates specificity based on `Math.abs(nodeColumn - column)`. This works for nodes that start at different columns, BUT:

**Problem:** For multi-specifier imports like `import { join, resolve, basename } from 'path'`:
- All three IMPORT nodes have the **same line number** (e.g., line 5)
- All three IMPORT nodes have the **same column** — the column of the `import` keyword (column 0)
- When hovering over `resolve` (e.g., column 15), the algorithm calculates distance for all three:
  - `join`: `Math.abs(0 - 15) = 15` → specificity = 985
  - `resolve`: `Math.abs(0 - 15) = 15` → specificity = 985
  - `basename`: `Math.abs(0 - 15) = 15` → specificity = 985
- All three have identical specificity, so the **first one in the array wins** (likely `join`)

**Root Cause:** IMPORT nodes store the position of the **ImportDeclaration AST node** (the `import` keyword), not the position of each individual **ImportSpecifier**.

## 2. IMPORT Node Creation

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/visitors/ImportExportVisitor.ts`
**Lines:** 102-146

### How IMPORT Nodes Are Created

```typescript
ImportDeclaration: (path: NodePath) => {
  const node = path.node as ImportDeclaration;
  const source = node.source.value;

  // Collect imported names
  const specifiers: ImportSpecifierInfo[] = [];
  node.specifiers.forEach((spec) => {
    if (spec.type === 'ImportSpecifier') {
      // import { foo, bar } from './module'
      const importSpec = spec as ImportSpecifier;
      const importedName = importSpec.imported.type === 'Identifier'
        ? importSpec.imported.name
        : importSpec.imported.value;
      const specKind = (importSpec as ImportSpecifier & { importKind?: string }).importKind;
      specifiers.push({
        imported: importedName,
        local: importSpec.local.name,
        importKind: specKind as ImportSpecifierInfo['importKind']
      });
    }
    // ... (default, namespace)
  });

  (imports as ImportInfo[]).push({
    source,
    specifiers,
    line: getLine(node),      // ← node = ImportDeclaration (the entire statement)
    column: getColumn(node),  // ← column of "import" keyword
    importKind: (node as ImportDeclaration & { importKind?: string }).importKind as ImportInfo['importKind']
  });
}
```

**Lines 142-144:** `getLine(node)` and `getColumn(node)` extract position from the **ImportDeclaration** node, NOT from individual ImportSpecifier nodes.

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/builders/ModuleRuntimeBuilder.ts`
**Lines:** 102-121

```typescript
for (const spec of specifiers) {
  // Use ImportNode factory for proper semantic IDs and field population
  const importNode = ImportNode.create(
    spec.local,           // name = local binding
    module.file,          // file
    line,                 // ← SAME line for all specifiers
    column || 0,          // ← SAME column for all specifiers
    source,               // source module
    {
      imported: spec.imported,
      local: spec.local,
      sideEffect: false,
      importBinding: spec.importKind === 'type' ? 'type' : (importKind || 'value'),
      // importType is auto-detected from imported field
      // Dynamic import fields
      isDynamic,
      isResolvable,
      dynamicPath
    }
  );
  // ...
}
```

**Lines 107-108:** All specifiers from one ImportDeclaration get the **same line and column**.

### Babel AST Structure

For `import { join, resolve, basename } from 'path'`:

```javascript
{
  type: 'ImportDeclaration',
  loc: { start: { line: 5, column: 0 }, end: { line: 5, column: 50 } },  // whole statement
  source: { value: 'path' },
  specifiers: [
    {
      type: 'ImportSpecifier',
      loc: { start: { line: 5, column: 9 }, end: { line: 5, column: 13 } },  // "join"
      imported: { name: 'join' },
      local: { name: 'join' }
    },
    {
      type: 'ImportSpecifier',
      loc: { start: { line: 5, column: 15 }, end: { line: 5, column: 22 } },  // "resolve"
      imported: { name: 'resolve' },
      local: { name: 'resolve' }
    },
    {
      type: 'ImportSpecifier',
      loc: { start: { line: 5, column: 24 }, end: { line: 5, column: 32 } },  // "basename"
      imported: { name: 'basename' },
      local: { name: 'basename' }
    }
  ]
}
```

**Each ImportSpecifier has its own `loc` field** with precise column ranges. But we're **not capturing** this information.

## 3. IMPORT Node Metadata Storage

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/core/nodes/ImportNode.ts`
**Lines:** 10-22

```typescript
interface ImportNodeRecord extends BaseNodeRecord {
  type: 'IMPORT';
  column: number;          // ← Stored as top-level field
  source: string;
  importType: ImportType;
  importBinding: ImportBinding;
  imported: string;
  local: string;
  isDynamic?: boolean;
  isResolvable?: boolean;
  dynamicPath?: string;
  sideEffect?: boolean;
}
```

**Line 12:** `column` is a required field, but there's **no `endColumn` field**.

**File:** `/Users/vadimr/grafema-worker-1/packages/vscode/src/types.ts`
**Lines:** 10-16

```typescript
export interface NodeMetadata {
  line?: number;
  column?: number;
  endLine?: number;    // ← Available in metadata
  endColumn?: number;  // ← Available in metadata
  [key: string]: unknown;
}
```

The `NodeMetadata` interface supports `endLine` and `endColumn`, but IMPORT nodes don't populate these fields.

## 4. MCP/Extension Call Flow

**File:** `/Users/vadimr/grafema-worker-1/packages/vscode/src/hoverProvider.ts`
**Lines:** 24-44

```typescript
async provideHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken
): Promise<vscode.Hover | null> {
  // ... (connection checks)

  const line = position.line + 1;     // VS Code is 0-based, graph is 1-based
  const column = position.character;  // 0-based in both

  const node = await findNodeAtCursor(client, filePath, line, column);
  // ...
}
```

The MCP/extension correctly passes **both line and column** to `findNodeAtCursor`.

**File:** `/Users/vadimr/grafema-worker-1/packages/vscode/src/cursorTracker.ts`
**Lines:** 69-79

```typescript
const position = editor.selection.active;
const absPath = document.uri.fsPath;
const line = position.line + 1;
const column = position.character;

// ... (path conversion)

const node = await findNodeAtCursor(client, filePath, line, column);
```

Same flow — **line and column are both passed**.

## 5. Existing Test Coverage

**No tests for `findNodeAtCursor`** were found. The function is tested manually via integration (hover provider, cursor tracker), but there are no unit tests.

**Test files checked:**
- `/Users/vadimr/grafema-worker-1/packages/vscode/test/unit/hoverMarkdown.test.ts` — tests hover markdown rendering, not node lookup
- `/Users/vadimr/grafema-worker-1/packages/vscode/test/unit/traceEngine.test.ts` — tests trace engine
- `/Users/vadimr/grafema-worker-1/packages/vscode/test/unit/grafemaClient.test.ts` — tests client connection

**IMPORT node tests:**
- `/Users/vadimr/grafema-worker-1/test/unit/GraphBuilderImport.test.js` — tests IMPORT node creation, semantic IDs, graph structure
- `/Users/vadimr/grafema-worker-1/test/unit/NodeFactoryImport.test.js` — tests ImportNode.create()

**None of these tests cover multi-specifier imports or column range matching.**

## 6. Diagnosis

### Root Cause

**Two-level problem:**

1. **Data Collection Gap:** ImportExportVisitor captures `getLine(node)` and `getColumn(node)` from the **ImportDeclaration** AST node, not from individual **ImportSpecifier** nodes. This means all specifiers from one import statement share the same line/column.

2. **Matching Logic Gap:** `findNodeAtCursor` uses column distance for specificity, but when multiple nodes have identical line/column (as IMPORT nodes do), they all get the same specificity score, and the first one wins arbitrarily.

### Why This Matters

- **User Experience:** Hovering over `resolve` in `import { join, resolve, basename } from 'path'` shows info for `join` instead.
- **Scope:** Affects **all multi-specifier imports** — extremely common pattern in JavaScript/TypeScript.
- **Workaround:** None. User must hover over the first specifier to see any import info.

## 7. Recommended Fix

### Option A: Store Column Ranges in IMPORT Nodes (Preferred)

**Changes needed:**

1. **ImportExportVisitor.ts (lines 108-121):** Extract `spec.loc` for each ImportSpecifier and pass to ImportInfo:
   ```typescript
   node.specifiers.forEach((spec) => {
     if (spec.type === 'ImportSpecifier') {
       const importSpec = spec as ImportSpecifier;
       specifiers.push({
         imported: importedName,
         local: importSpec.local.name,
         importKind: specKind,
         column: getColumn(importSpec),      // ← NEW: specifier's start column
         endColumn: getEndColumn(importSpec) // ← NEW: specifier's end column
       });
     }
     // ... (similar for default/namespace)
   });
   ```

2. **ModuleRuntimeBuilder.ts (lines 102-121):** Pass specifier-specific column/endColumn to ImportNode.create():
   ```typescript
   for (const spec of specifiers) {
     const importNode = ImportNode.create(
       spec.local,
       module.file,
       line,
       spec.column || column || 0,     // ← Use specifier column if available
       source,
       {
         imported: spec.imported,
         local: spec.local,
         endColumn: spec.endColumn,    // ← NEW: store end column in metadata
         // ... (other fields)
       }
     );
   }
   ```

3. **ImportNode.ts (lines 10-22):** Add optional `endColumn` to ImportNodeRecord:
   ```typescript
   interface ImportNodeRecord extends BaseNodeRecord {
     type: 'IMPORT';
     column: number;
     endColumn?: number;  // ← NEW
     // ... (other fields)
   }
   ```

4. **nodeLocator.ts (lines 43-54):** Check column **range** instead of just start column:
   ```typescript
   if (nodeLine === line) {
     const nodeColumn = metadata.column ?? 0;
     const nodeEndColumn = metadata.endColumn;

     if (nodeEndColumn !== undefined) {
       // Check if cursor is within column range
       if (column >= nodeColumn && column <= nodeEndColumn) {
         matchingNodes.push({
           node,
           specificity: 2000  // Higher priority for exact range match
         });
       }
     } else {
       // Fallback: use distance-based matching
       const distance = Math.abs(nodeColumn - column);
       matchingNodes.push({
         node,
         specificity: 1000 - distance
       });
     }
   }
   ```

### Option B: Filter by Name (Quick Fix, Not Recommended)

Use the cursor position to extract the identifier under the cursor from source code, then filter IMPORT nodes by `name` field. **Problem:** Requires parsing source code in VS Code extension, adds complexity, doesn't solve the general problem.

## 8. Impact Assessment

### Affected Files
1. `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/visitors/ImportExportVisitor.ts`
2. `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/builders/ModuleRuntimeBuilder.ts`
3. `/Users/vadimr/grafema-worker-1/packages/core/src/core/nodes/ImportNode.ts`
4. `/Users/vadimr/grafema-worker-1/packages/vscode/src/nodeLocator.ts`
5. `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/utils/location.ts` (add `getEndColumn` helper)

### Compatibility
- **Breaking change:** No. Adding optional `endColumn` field is backward-compatible.
- **Reanalysis required:** Yes. Existing graphs won't have `endColumn` data, so users must re-run `grafema analyze`.

### Test Coverage Needed
1. **Unit test for `findNodeAtCursor`** with multi-specifier imports
2. **Integration test** for hover provider with multi-specifier imports
3. **Snapshot test** for IMPORT nodes to verify `endColumn` is populated

## 9. Next Steps (for Joel/Dijkstra)

1. **Add `getEndColumn()` helper** to `/packages/core/src/plugins/analysis/ast/utils/location.ts`
2. **Update ImportExportVisitor** to capture per-specifier column ranges
3. **Update ModuleRuntimeBuilder** to pass column ranges to ImportNode.create()
4. **Update ImportNode schema** to include optional `endColumn`
5. **Update `findNodeAtCursor`** to use column range matching
6. **Write tests** for multi-specifier import matching

---

**Summary:** The bug is caused by IMPORT nodes storing the column of the `import` keyword instead of each specifier's column range. The fix is to capture `spec.loc` from Babel AST and use it for range-based matching in `findNodeAtCursor`.
