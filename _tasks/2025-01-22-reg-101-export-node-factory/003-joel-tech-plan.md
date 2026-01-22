# Joel Spolsky - Technical Implementation Plan: REG-101

## Task
Migrate 5 inline EXPORT node creations in ASTWorker.ts to use ExportNode.create()

**File to modify:** `/Users/vadimr/grafema/packages/core/src/core/ASTWorker.ts`

---

## Change Summary

1. Add ExportNode import (line 14-16 area)
2. Remove duplicate ExportNode interface (lines 44-53)
3. Update exports array type annotation
4. Replace 5 inline EXPORT creations with ExportNode.create() calls

---

## Step 1: Add Import

**Location:** After ClassNode and ImportNode imports

**BEFORE:**
```typescript
import { ClassNode, type ClassNodeRecord } from './nodes/ClassNode.js';
import { ImportNode, type ImportNodeRecord } from './nodes/ImportNode.js';
```

**AFTER:**
```typescript
import { ClassNode, type ClassNodeRecord } from './nodes/ClassNode.js';
import { ImportNode, type ImportNodeRecord } from './nodes/ImportNode.js';
import { ExportNode, type ExportNodeRecord } from './nodes/ExportNode.js';
```

---

## Step 2: Remove Duplicate Interface

**Location:** Lines 44-53

**REMOVE:**
```typescript
/**
 * Export node structure
 */
interface ExportNode {
  id: string;
  type: 'EXPORT';
  name: string;
  exportType?: string;
  localName?: string;
  isDefault?: boolean;
  file: string;
  line: number;
}
```

---

## Step 3: Update Type Annotation

**Location:** In ASTCollections interface

**BEFORE:** `exports: ExportNode[];`
**AFTER:** `exports: ExportNodeRecord[];`

---

## Step 4: Migrate FunctionDeclaration Exports (lines 284-291)

**BEFORE:**
```typescript
collections.exports.push({
  id: `EXPORT#${node.declaration.id.name}#${filePath}#${node.loc!.start.line}`,
  type: 'EXPORT',
  name: node.declaration.id.name,
  exportType: 'function',
  file: filePath,
  line: node.loc!.start.line
});
```

**AFTER:**
```typescript
const exportNode = ExportNode.create(
  node.declaration.id.name,
  filePath,
  node.loc!.start.line,
  0,
  { exportType: 'named' }
);
collections.exports.push(exportNode);
```

---

## Step 5: Migrate ClassDeclaration Exports (lines 293-300)

Same pattern as Step 4.

---

## Step 6: Migrate VariableDeclaration Exports (lines 304-311)

**BEFORE:**
```typescript
collections.exports.push({
  id: `EXPORT#${decl.id.name}#${filePath}#${node.loc!.start.line}`,
  type: 'EXPORT',
  name: decl.id.name,
  exportType: 'variable',
  file: filePath,
  line: node.loc!.start.line
});
```

**AFTER:**
```typescript
const exportNode = ExportNode.create(
  decl.id.name,
  filePath,
  node.loc!.start.line,
  0,
  { exportType: 'named' }
);
collections.exports.push(exportNode);
```

---

## Step 7: Migrate Named Specifier Exports (lines 321-328)

**BEFORE:**
```typescript
collections.exports.push({
  id: `EXPORT#${exportedName}#${filePath}#${node.loc!.start.line}`,
  type: 'EXPORT',
  name: exportedName,
  localName: (spec as ExportSpecifier).local.name,
  file: filePath,
  line: node.loc!.start.line
});
```

**AFTER:**
```typescript
const exportNode = ExportNode.create(
  exportedName,
  filePath,
  node.loc!.start.line,
  0,
  {
    local: (spec as ExportSpecifier).local.name,
    exportType: 'named'
  }
);
collections.exports.push(exportNode);
```

---

## Step 8: Migrate Default Exports (lines 343-351)

**BEFORE:**
```typescript
collections.exports.push({
  id: `EXPORT#default#${filePath}#${node.loc!.start.line}`,
  type: 'EXPORT',
  name: 'default',
  localName: name,
  isDefault: true,
  file: filePath,
  line: node.loc!.start.line
});
```

**AFTER:**
```typescript
const exportNode = ExportNode.create(
  'default',
  filePath,
  node.loc!.start.line,
  0,
  {
    local: localName,
    default: true,
    exportType: 'default'
  }
);
collections.exports.push(exportNode);
```

**Note:** Rename local variable `name` → `localName` for clarity.

---

## Field Mapping Reference

| ASTWorker (old) | ExportNode.create() | Notes |
|-----------------|---------------------|-------|
| `exportType: 'function'/'class'/'variable'` | *dropped* | Not used by GraphBuilder |
| `localName` | `local` (option) | Correct field name |
| `isDefault` | `default` (option) | Correct field name |
| *none* | `exportType: 'named'/'default'` | NEW: proper export syntax type |

---

## ID Format Change

**OLD:** `EXPORT#name#file#line`
**NEW:** `file:EXPORT:name:line`

Consistent with NodeFactory system.

---

## Risk Assessment

**LOW RISK** - Straightforward factory migration:
- ExportNode.create() already tested and working
- GraphBuilder already uses it successfully
- No behavioral changes, just cleaner creation
