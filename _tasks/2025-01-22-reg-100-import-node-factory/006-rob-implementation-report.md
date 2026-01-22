# Rob Pike - Implementation Report: REG-100

## Changes Made

### 1. ASTWorker.ts

**File:** `/Users/vadimr/grafema/packages/core/src/core/ASTWorker.ts`

**Changes:**

1. Added import for ImportNode factory:
```typescript
import { ImportNode, type ImportNodeRecord } from './nodes/ImportNode.js';
```

2. Removed local ImportNode interface (was lines 42-50):
```typescript
// REMOVED:
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

3. Updated ASTCollections interface to use canonical type:
```typescript
// Changed from: imports: ImportNode[];
imports: ImportNodeRecord[];
```

4. Updated import creation to use factory method:
```typescript
// OLD:
collections.imports.push({
  id: `IMPORT#${localName}#${filePath}#${node.loc!.start.line}`,
  type: 'IMPORT',
  name: localName,
  importedName,
  source,
  file: filePath,
  line: node.loc!.start.line
});

// NEW:
const importNode = ImportNode.create(
  localName,      // name
  filePath,       // file
  node.loc!.start.line,  // line
  0,              // column (not available in this worker)
  source,         // source
  { imported: importedName, local: localName }
);
collections.imports.push(importNode);
```

### 2. QueueWorker.ts

**File:** `/Users/vadimr/grafema/packages/core/src/core/QueueWorker.ts`

**Changes:**

1. Added import for ImportNode factory:
```typescript
import { ImportNode } from './nodes/ImportNode.js';
```

2. Updated import creation to use factory method:
```typescript
// OLD:
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
edges.push({ src: moduleId, dst: importId, type: 'CONTAINS' });

// NEW:
const importNode = ImportNode.create(
  localName,      // name
  filePath,       // file
  node.loc?.start.line || 1,  // line - fallback to line 1 if location unavailable
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
});
edges.push({ src: moduleId, dst: importNode.id, type: 'CONTAINS' });
```

**Note:** Changed fallback from `0` to `1` because line numbers are 1-indexed.

### 3. AnalysisWorker.ts

**File:** `/Users/vadimr/grafema/packages/core/src/core/AnalysisWorker.ts`

**Changes:**

1. Added import for ImportNode factory:
```typescript
import { ImportNode } from './nodes/ImportNode.js';
```

2. Updated import creation to use factory method with enhanced metadata:
```typescript
// OLD:
const importId = `IMPORT#${localName}#${filePath}#${node.loc!.start.line}`;
nodes.push({
  id: importId,
  type: 'IMPORT',
  name: localName,
  file: filePath,
  metadata: JSON.stringify({ importedName, source, line: node.loc!.start.line })
});
edges.push({ src: moduleId, dst: importId, type: 'CONTAINS' });

// NEW:
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
edges.push({ src: moduleId, dst: importNode.id, type: 'CONTAINS' });
```

**Note:** Metadata now includes additional fields `importType` and `importBinding` from the new factory.

## ID Format Change

All three workers now use semantic IDs instead of line-based IDs:

| Old Format | New Format |
|------------|------------|
| `IMPORT#localName#filePath#line` | `filePath:IMPORT:source:localName` |

This is intentional - semantic IDs are stable across edits.

## Build Results

```
> grafema@0.1.0 build
> pnpm -r build

Scope: 5 of 6 workspace projects
packages/types build$ tsc
packages/types build: Done
packages/rfdb build$ tsc
packages/rfdb build: Done
packages/core build$ tsc
packages/core build: Done
packages/cli build$ tsc
packages/mcp build$ tsc
packages/cli build: Done
packages/mcp build: Done
```

## Status: PASS

All three worker files have been migrated to use `ImportNode.create()` factory method. The build completes successfully with no type errors.
