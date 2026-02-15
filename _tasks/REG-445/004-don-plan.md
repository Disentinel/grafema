# Don Plan: REG-445 — Fix CLI query layer for RFDB v3

**Date:** 2026-02-15
**Config:** Mini-MLA

## Root Cause Analysis

The investigation revealed **three distinct bugs**, all in the CLI/core query layer:

### Bug 1: Semantic ID format mismatch (CRITICAL — breaks ALL queries)

**What happens:**
1. JavaScript code creates nodes with v1 semantic IDs: `file->scope->TYPE->name`
2. These are sent to RFDB server via `wire.semanticId`
3. RFDB v3 server rewrites them to its own format: `TYPE:name@file`
4. `_parseNode()` uses `wireNode.semanticId` (v3 format) as the node's `id`
5. CLI's `matchesScope()` → `parseSemanticIdV2()` → `parseSemanticId()` all fail to parse v3 format
6. **Result:** `matchesScope()` returns `false` for ALL nodes → ALL queries return "No results"

**Evidence:**
```
[DBG-SCOPE] id=FUNCTION:resolveSourceEntrypoint@packages/core/src/plugins/discovery/resolveSourceEntrypoint.ts file=null scopes=[] scopeMatch=false
```
Even with no constraints (file=null, scopes=[]), scope matching fails because neither parser can parse the v3 ID format.

**Key insight:** The original v1 semantic ID IS preserved in the RFDB metadata:
```json
"metadata": "{\"semanticId\":\"packages/cli/src/utils/pathUtils.ts->global->MODULE->module\"}"
```

### Bug 2: File path mismatch (breaks `file` command)

**What happens:**
1. `file` command resolves path to absolute: `/Users/vadim/.../packages/types/src/index.ts`
2. Passes absolute path to `FileOverview.getOverview(absoluteFilePath)`
3. `findModuleNode()` queries `{ file: absoluteFilePath, type: 'MODULE' }`
4. MODULE nodes have `file: "packages/types/src/index.ts"` (relative)
5. **Result:** No match → shows NOT_ANALYZED for ALL files

### Bug 3: Missing type search types (breaks type queries)

**What happens:**
- `findNodes()` only searches: FUNCTION, CLASS, MODULE, VARIABLE, CONSTANT, http:route, http:request, socketio:*, PROPERTY_ACCESS
- **Missing:** INTERFACE, TYPE, ENUM
- Even if bugs 1 & 2 are fixed, TypeScript type nodes won't be found by `query` command

## Fix Plan

### Fix 1: Use original semantic ID in `_parseNode()` (RFDBServerBackend)

**File:** `packages/core/src/storage/backends/RFDBServerBackend.ts`
**Method:** `_parseNode()` (line 450)

**Change:** Prefer the original semantic ID from metadata over the server-rewritten one:

```typescript
// Current (broken):
const humanId = wireNode.semanticId || (metadata.originalId as string) || wireNode.id;

// Fixed:
const humanId = (metadata.semanticId as string) || wireNode.semanticId || (metadata.originalId as string) || wireNode.id;
```

Also add `semanticId` to the metadata exclusion list to prevent it from appearing as a separate property:
```typescript
const {
  id: _id,
  type: _type,
  name: _name,
  file: _file,
  exported: _exported,
  nodeType: _nodeType,
  originalId: _originalId,
  semanticId: _semanticId,  // NEW: exclude from safeMetadata
  ...safeMetadata
} = metadata;
```

**Risk:** LOW — this only changes the `id` field on returned nodes. The original v1 format is what all existing code expects.

### Fix 2: Use relative file path in `FileOverview.findModuleNode()`

**File:** `packages/core/src/core/FileOverview.ts`
**Method:** `findModuleNode()` (line 175)

**Change:** Convert absolute path to relative before querying, or query by type only and filter:

```typescript
private async findModuleNode(filePath: string): Promise<BaseNodeRecord | null> {
  // Try both absolute and relative paths
  const relativePath = filePath.includes('/') && !filePath.startsWith('.')
    ? filePath  // Already might be relative
    : filePath;

  const filter: NodeFilter = { type: 'MODULE' };
  for await (const node of this.graph.queryNodes(filter)) {
    // Match either absolute or relative path
    if (node.file === filePath || filePath.endsWith('/' + node.file) || node.file === filePath) {
      return node;
    }
  }
  return null;
}
```

Actually, better: accept a `projectPath` parameter and normalize:

```typescript
private async findModuleNode(filePath: string): Promise<BaseNodeRecord | null> {
  // Normalize: strip projectPath prefix if present
  let normalizedPath = filePath;
  if (this.projectPath && filePath.startsWith(this.projectPath)) {
    normalizedPath = filePath.slice(this.projectPath.length + 1); // +1 for trailing /
  }

  const filter: NodeFilter = { file: normalizedPath, type: 'MODULE' };
  for await (const node of this.graph.queryNodes(filter)) {
    if (node.type === 'MODULE') return node;
  }
  return null;
}
```

**BUT:** FileOverview doesn't have `projectPath`. Need to either pass it or resolve differently.

**Simplest fix:** In the CLI `file` command, pass `relativeFilePath` to `getOverview()` instead of `absoluteFilePath`.

**File:** `packages/cli/src/commands/file.ts` line 90
```typescript
// Current (broken):
const result = await overview.getOverview(absoluteFilePath, { ... });

// Fixed:
const result = await overview.getOverview(relativeFilePath, { ... });
```

**Risk:** LOW — the `result.file` is already overwritten with `relativeFilePath` at line 94.

Also check the `explain` command — it likely has the same bug.

### Fix 3: Add INTERFACE, TYPE, ENUM to query search types

**File:** `packages/cli/src/commands/query.ts`
**Function:** `findNodes()` (line 601)

**Change:** Add TypeScript type nodes to default search types:

```typescript
const searchTypes = query.type
  ? [query.type]
  : [
      'FUNCTION',
      'CLASS',
      'INTERFACE',  // NEW
      'TYPE',       // NEW
      'ENUM',       // NEW
      'MODULE',
      'VARIABLE',
      'CONSTANT',
      'http:route',
      'http:request',
      'socketio:event',
      'socketio:emit',
      'socketio:on',
      'PROPERTY_ACCESS'
    ];
```

Also add type aliases to `parsePattern()`:
```typescript
const typeMap: Record<string, string> = {
  // existing...
  interface: 'INTERFACE',
  type: 'TYPE',
  enum: 'ENUM',
};
```

**Risk:** LOW — additive change, no existing behavior modified.

### Fix 4: Same fix for MCP `find_nodes` handler

**File:** `packages/mcp/src/handlers.ts`

Check if the MCP handler has the same missing types issue. If so, add INTERFACE, TYPE, ENUM there too.

## Implementation Order

1. **Fix 1** (semantic ID) — highest priority, unblocks ALL queries
2. **Fix 3** (search types) — quick, additive
3. **Fix 2** (file path) — fixes `file` command
4. **Fix 4** (MCP) — if applicable

## Testing Strategy

1. Unit tests for `_parseNode()` with v3 format semantic IDs
2. Unit tests for `matchesScope()` with the fixed IDs
3. Integration test: `grafema query "resolveSourceEntrypoint"` returns results
4. Integration test: `grafema file "packages/types/src/index.ts"` shows ANALYZED
5. Integration test: `grafema query "interface GraphBackend"` finds INTERFACE node

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/storage/backends/RFDBServerBackend.ts` | `_parseNode()` — prefer metadata.semanticId |
| `packages/cli/src/commands/query.ts` | Add INTERFACE/TYPE/ENUM types + aliases |
| `packages/cli/src/commands/file.ts` | Pass relative path to getOverview |
| `packages/cli/src/commands/explain.ts` | Same fix as file.ts (if applicable) |
| `packages/mcp/src/handlers.ts` | Add INTERFACE/TYPE/ENUM if needed |
