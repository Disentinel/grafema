# REG-325: Implementation Report

## Problem

Node names displayed raw JSON metadata instead of human-readable names.

Example:
```
grafema get 'http:route#GET:/invitations/received#...#346'

[http:route] {"originalId":"LITERAL#return#...","value":true,"valueType":"boolean","line":108}
```

Expected:
```
[http:route] GET /invitations/received
```

## Root Cause

Two issues combined to cause this problem:

### 1. Storage Layer: Metadata Spread Overwrites Standard Fields

In `RFDBServerBackend._parseNode()`, the metadata object was spread AFTER setting standard fields:

```typescript
return {
  id: humanId,
  type: wireNode.nodeType,
  name: wireNode.name,        // Line 438
  file: wireNode.file,
  exported: wireNode.exported,
  ...metadata,                // Line 441 - overwrites name!
};
```

If metadata contained a `name` field (from another node type like LITERAL), it would overwrite `wireNode.name`.

### 2. Display Layer: No Type-Specific Formatting

The CLI's `formatNodeDisplay()` always used `node.name` for display, regardless of node type. HTTP nodes (http:route, http:request) don't have meaningful `name` fields - they should display `method + path` instead.

## Solution

### 1. Fix Storage Layer (Root Cause)

Modified `RFDBServerBackend._parseNode()` to exclude standard fields from metadata spread:

```typescript
// Exclude standard fields from metadata to prevent overwriting wireNode values
const {
  id: _id,
  type: _type,
  name: _name,
  file: _file,
  exported: _exported,
  nodeType: _nodeType,
  originalId: _originalId,
  ...safeMetadata
} = metadata;

return {
  id: humanId,
  type: wireNode.nodeType,
  name: wireNode.name,
  file: wireNode.file,
  exported: wireNode.exported,
  ...safeMetadata,  // Only safe fields spread
};
```

### 2. Add Type-Specific Display Formatting

Added `getNodeDisplayName()` function in `formatNode.ts`:

```typescript
export function getNodeDisplayName(node: DisplayableNode): string {
  switch (node.type) {
    case 'http:route':
      if (node.method && node.path) {
        return `${node.method} ${node.path}`;  // "GET /api/users"
      }
      break;
    case 'http:request':
      if (node.method && node.url) {
        return `${node.method} ${node.url}`;  // "POST /api/data"
      }
      break;
  }
  // Default: use name, but guard against JSON metadata corruption
  if (node.name && !node.name.startsWith('{')) {
    return node.name;
  }
  // Fallback: extract from semantic ID
  const parts = node.id.split('#');
  if (parts.length > 1) {
    return parts[1];
  }
  return node.id;
}
```

### 3. Pass HTTP Fields Through CLI Commands

Updated `get.ts` to pass `method`, `path`, `url` fields to display functions and excluded them from metadata display.

## Changes

### `packages/core/src/storage/backends/RFDBServerBackend.ts`
- Modified `_parseNode()` to exclude standard fields from metadata spread

### `packages/cli/src/utils/formatNode.ts`
- Added `method`, `path`, `url` to `DisplayableNode` interface
- Added `getNodeDisplayName()` function for type-specific display
- Updated `formatNodeDisplay()` to use `getNodeDisplayName()`

### `packages/cli/src/commands/get.ts`
- Added `method`, `path`, `url` to `NodeInfo` interface
- Updated `outputText()` to pass these fields to display
- Updated `getMetadataFields()` to exclude display fields

## Tests Added

New test file: `packages/cli/test/formatNode.test.ts`

Test cases:
1. `getNodeDisplayName` - shows METHOD PATH for http:route
2. `getNodeDisplayName` - shows METHOD URL for http:request
3. `getNodeDisplayName` - uses name for regular nodes
4. `getNodeDisplayName` - fallback when name is corrupted JSON
5. `getNodeDisplayName` - fallback to semantic ID extraction
6. `formatNodeDisplay` - formats http:route correctly
7. `formatNodeDisplay` - no corrupted JSON in output
8. `formatNodeInline` - returns semantic ID

All tests pass.

## Verification

Before fix:
```
[http:route] {"originalId":"LITERAL#return#...","value":true,"valueType":"boolean","line":108}
```

After fix:
```
[http:route] GET /invitations/received
```
