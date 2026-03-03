---
name: grafema-metadata-flattening
description: |
  Fix undefined metadata fields in Grafema when accessing route.metadata.handlerStart or
  similar nested properties. Use when: (1) node.metadata?.someField is undefined despite
  data being stored, (2) enrichment plugins can't find metadata they expect, (3) data
  was stored with nested metadata object like {metadata: {field: value}}. Root cause:
  RFDB serialization flattens nested metadata to top level. Solution: read from node.field
  directly, not node.metadata.field.
author: Claude Code
version: 1.0.0
date: 2026-02-05
---

# Grafema Metadata Flattening During Serialization

## Problem

When storing node data with a nested `metadata` object in Grafema, the fields become
inaccessible via `node.metadata.fieldName` after retrieval. This causes enrichment
plugins to fail silently when they expect nested metadata structure.

## Context / Trigger Conditions

- Enrichment plugin reports `noHandlerInfo` or similar "not found" counts
- `node.metadata?.fieldName` returns `undefined`
- Data was stored with structure like `{...data, metadata: {handlerStart: 93}}`
- The field IS in the database (visible in raw wire format as JSON string)
- Works in analysis phase (before serialization) but fails in enrichment phase (after)

## Solution

**Key insight**: RFDB's serialization/deserialization flattens all metadata to the node's
top level.

### The Flow

1. **Analyzer stores**: `{id, type, file, metadata: {handlerStart: 93}}`

2. **client.addNodes serializes**:
   ```javascript
   const { id, type, name, file, exported, metadata, ...rest } = node;
   // metadata = {handlerStart: 93}, rest = {}
   // combinedMeta = {...metadata, ...rest} = {handlerStart: 93}
   wireNode.metadata = JSON.stringify(combinedMeta);
   // Result: '{"handlerStart":93}'
   ```

3. **_parseNode deserializes**:
   ```javascript
   const metadata = JSON.parse(wireNode.metadata);
   // metadata = {handlerStart: 93}
   const {...safeMetadata} = metadata;
   return {...standardFields, ...safeMetadata};
   // Result: {id, type, name, file, exported, handlerStart: 93}
   ```

4. **After retrieval**: `handlerStart` is at TOP LEVEL, not nested!

### Fix Pattern

**Wrong** (will be undefined):
```typescript
const handlerStart = route.metadata?.handlerStart;
const handlerName = route.metadata?.handlerName;
```

**Correct** (reads from top level):
```typescript
const handlerStart = route.handlerStart;
const handlerName = route.handlerName;
```

### Interface Definition

When defining TypeScript interfaces for nodes with custom fields:

```typescript
// WRONG: Don't nest under metadata
interface HttpRouteNode extends BaseNodeRecord {
  type: 'http:route';
  metadata?: {
    handlerStart?: number;
  };
}

// CORRECT: Fields are at top level after parsing
interface HttpRouteNode extends BaseNodeRecord {
  type: 'http:route';
  handlerStart?: number;  // Top level!
  handlerName?: string;   // Top level!
}
```

## Verification

1. Add debug logging: `console.log('Route:', JSON.stringify(route, null, 2))`
2. Verify the field exists at top level, not nested under `metadata`
3. Check enricher logs show `noHandlerInfo: 0` instead of counting failures

## Example

ExpressHandlerLinker was failing to create HANDLED_BY edges because:

```typescript
// Before (broken):
const handlerStart = route.metadata?.handlerStart;
// handlerStart = undefined (metadata is not an object!)

// After (working):
const handlerStart = route.handlerStart;
// handlerStart = 93 (correct!)
```

## Notes

- This applies to ALL custom fields stored on nodes, not just metadata
- The `metadata` property on parsed nodes may exist but will be a flattened remnant
- When storing, you CAN use `{metadata: {...}}` structure - it gets flattened automatically
- TestDatabaseBackend and RFDBServerBackend both have this behavior via `_parseNode`
- If you need truly nested data, store it as a JSON string that doesn't get auto-parsed
