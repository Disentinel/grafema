# Joel Spolsky - Technical Plan: REG-100

## Overview

REG-100 requires migrating all IMPORT node creation to use NodeFactory. The core infrastructure (ImportNode.ts, NodeFactory.createImport) is already complete. The remaining work is:

1. Fix one failing test (wrong expectation about `line=0`)
2. Migrate three worker files to use NodeFactory.createImport()
3. Remove the ImportNode interface from ASTWorker (it should use the canonical type)

## Changes Required

### 1. Fix Failing Test

**File:** `/Users/vadimr/grafema/test/unit/NodeFactoryImport.test.js`

**Current code (lines 361-365):**
```javascript
it('should throw when line is missing', () => {
  assert.throws(() => {
    NodeFactory.createImport('React', '/file.js', 0, 0, 'react');
  }, /line is required/);
});
```

**Problem:** Test expects `line=0` to throw, but `line=0` is a valid value. The check in ImportNode.ts is `line === undefined`, so `0` is accepted. This is consistent with FunctionNode and other node types.

**New code:**
```javascript
it('should throw when line is undefined', () => {
  assert.throws(() => {
    // @ts-ignore - intentionally passing undefined for test
    NodeFactory.createImport('React', '/file.js', undefined, 0, 'react');
  }, /line is required/);
});
```

---

### 2. Migrate AnalysisWorker.ts

**File:** `/Users/vadimr/grafema/packages/core/src/core/AnalysisWorker.ts`

**Add import at line ~22 (after ClassNode import):**
```typescript
import { ImportNode, type ImportNodeRecord } from './nodes/ImportNode.js';
```

**Current code (lines 161-168):**
```typescript
const importId = `IMPORT#${localName}#${filePath}#${node.loc!.start.line}`;
nodes.push({
  id: importId,
  type: 'IMPORT',
  name: localName,
  file: filePath,
  metadata: JSON.stringify({ importedName, source, line: node.loc!.start.line })
});
```

**New code:**
```typescript
const importNode = ImportNode.create(
  localName,      // name
  filePath,       // file
  node.loc!.start.line,  // line
  0,              // column (not available in this worker)
  source,         // source
  { imported: importedName, local: localName }
);
nodes.push({
  id: importNode.id,
  type: importNode.type,
  name: importNode.name,
  file: importNode.file,
  metadata: JSON.stringify({
    importedName: importNode.imported,
    source: importNode.source,
    line: importNode.line,
    importType: importNode.importType,
    importBinding: importNode.importBinding
  })
});
```

**Field mapping:**
| Old | New |
|-----|-----|
| `importId` (hash-based) | `importNode.id` (semantic: `file:IMPORT:source:name`) |
| `metadata.importedName` | `importNode.imported` |
| `metadata.source` | `importNode.source` |
| `metadata.line` | `importNode.line` |
| (missing) | `importNode.importType` (auto-detected) |
| (missing) | `importNode.importBinding` (default: 'value') |

---

### 3. Migrate QueueWorker.ts

**File:** `/Users/vadimr/grafema/packages/core/src/core/QueueWorker.ts`

**Add import at line ~21 (after ClassNode import):**
```typescript
import { ImportNode, type ImportNodeRecord } from './nodes/ImportNode.js';
```

**Current code (lines 234-243):**
```typescript
const importId = `IMPORT#${localName}#${filePath}#${node.loc?.start.line || 0}`;
nodes.push({
  id: importId,
  type: 'IMPORT',
  name: localName,
  file: filePath,
  line: node.loc?.start.line || 0,
  importedName,
  source,
});
```

**New code:**
```typescript
const importNode = ImportNode.create(
  localName,      // name
  filePath,       // file
  node.loc?.start.line || 1,  // line (use 1 as fallback, not 0)
  0,              // column
  source,         // source
  { imported: importedName, local: localName }
);
nodes.push({
  id: importNode.id,
  type: importNode.type,
  name: importNode.name,
  file: importNode.file,
  line: importNode.line,
  importedName: importNode.imported,
  source: importNode.source,
} as WireNode);
```

**Note:** The fallback value changed from `0` to `1` because `node.loc?.start.line || 0` would return `0` for missing line info, but `1` is a more sensible default for line numbers (1-indexed).

**Field mapping:**
| Old | New |
|-----|-----|
| `importId` (hash-based) | `importNode.id` (semantic) |
| `importedName` | `importNode.imported` |
| `source` | `importNode.source` |
| `line` | `importNode.line` |

---

### 4. Migrate ASTWorker.ts

**File:** `/Users/vadimr/grafema/packages/core/src/core/ASTWorker.ts`

**Add import at line ~14 (after ClassNode import):**
```typescript
import { ImportNode, type ImportNodeRecord } from './nodes/ImportNode.js';
```

**Remove local ImportNode interface (lines 42-50):**
```typescript
// DELETE THIS:
/**
 * Import node structure
 */
interface ImportNode {
  id: string;
  type: 'IMPORT';
  name: string;
  importedName: string;
  source: string;
  file: string;
  line: number;
}
```

**Update collections type to use ImportNodeRecord:**
Find where `collections.imports` is typed and update to use `ImportNodeRecord[]`.

**Current code (lines 274-282):**
```typescript
collections.imports.push({
  id: `IMPORT#${localName}#${filePath}#${node.loc!.start.line}`,
  type: 'IMPORT',
  name: localName,
  importedName,
  source,
  file: filePath,
  line: node.loc!.start.line
});
```

**New code:**
```typescript
const importNode = ImportNode.create(
  localName,      // name
  filePath,       // file
  node.loc!.start.line,  // line
  0,              // column
  source,         // source
  { imported: importedName, local: localName }
);
collections.imports.push(importNode);
```

**Field mapping:**
| Old | New |
|-----|-----|
| `id` (hash-based) | `importNode.id` (semantic) |
| `importedName` | `importNode.imported` |
| `source` | `importNode.source` |
| `line` | `importNode.line` |
| (missing) | `importNode.column` |
| (missing) | `importNode.importType` |
| (missing) | `importNode.importBinding` |
| (missing) | `importNode.local` |

---

## Verification Steps

1. **Run specific tests:**
   ```bash
   node --test test/unit/NodeFactoryImport.test.js
   ```

2. **Verify no inline IMPORT literals remain:**
   ```bash
   grep -r "type:\s*['\"]IMPORT['\"]" packages/core/src --include="*.ts" | grep -v "nodes/ImportNode.ts" | grep -v ".d.ts"
   ```
   Expected result: No matches (or only type definitions)

3. **Run full test suite:**
   ```bash
   npm test
   ```

4. **Check for old ID format:**
   ```bash
   grep -r "IMPORT#" packages/core/src --include="*.ts"
   ```
   Expected result: No matches

---

## Implementation Order

1. **First:** Fix the failing test in `NodeFactoryImport.test.js`
   - Quick fix, unblocks test runs
   - Low risk

2. **Second:** Migrate `ASTWorker.ts`
   - Most self-contained (returns data, doesn't write to RFDB directly)
   - Removes duplicate ImportNode interface

3. **Third:** Migrate `QueueWorker.ts`
   - Similar pattern to ASTWorker
   - Writes to RFDB but has clear node structure

4. **Fourth:** Migrate `AnalysisWorker.ts`
   - Uses metadata JSON pattern
   - May need extra field mapping

5. **Finally:** Run verification steps

---

## Risk Assessment

### Breaking Change: ID Format

**Old format:** `IMPORT#localName#filePath#line`
**New format:** `filePath:IMPORT:source:localName`

This is intentionally different:
- Old format includes line number (unstable across edits)
- New format is semantic (stable identity)

**Impact:** Any existing graph data using old IDs will not match. This is expected and correct - the semantic ID is the target state.

### Backward Compatibility

If there is existing data with old ID format:
- Queries using old IDs will not find nodes
- This should be handled by re-analysis (fresh graph)

### Type Compatibility

The `ImportNodeRecord` type has more fields than the old inline type. Workers that consume these nodes may need updates if they expect specific fields. However, since we're adding fields (not removing), this should be safe.

---

## Estimated Time

| Task | Time |
|------|------|
| Fix test | 5 min |
| Migrate ASTWorker | 15 min |
| Migrate QueueWorker | 15 min |
| Migrate AnalysisWorker | 15 min |
| Verification | 10 min |
| **Total** | **60 min** |
