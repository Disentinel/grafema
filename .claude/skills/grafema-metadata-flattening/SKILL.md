---
name: rfdb-metadata-gotchas
description: |
  Fix silent metadata issues in RFDB node storage. Covers two traps:
  (1) metadata flattening — nested metadata fields become top-level after
  serialization, so node.metadata.field is undefined but node.field works.
  (2) reserved keys — fields named "type", "id", "name", "file", "exported"
  are silently stripped from metadata by _parseNode() to prevent overwriting
  top-level node fields.
author: Claude Code
version: 2.0.0
date: 2026-05-03
---

# RFDB Metadata Gotchas

## Trap 1: Metadata Flattening

RFDB serialization flattens nested metadata to the node's top level.

**What happens:**
1. Analyzer stores: `{id, type, file, metadata: {handlerStart: 93}}`
2. `client.addNodes` serializes metadata as JSON string
3. `_parseNode` deserializes and spreads onto top level
4. After retrieval: `handlerStart` is at TOP LEVEL, not nested

**Wrong:**
```typescript
const handlerStart = route.metadata?.handlerStart;  // undefined!
```

**Correct:**
```typescript
const handlerStart = route.handlerStart;  // 93
```

**TypeScript interfaces** — define custom fields at top level:
```typescript
interface HttpRouteNode extends BaseNodeRecord {
  type: 'http:route';
  handlerStart?: number;  // top level, not nested under metadata
}
```

## Trap 2: Reserved Keys (Silent Data Loss)

`_parseNode()` strips these keys from metadata to prevent overwriting top-level node fields:

| Key | Why reserved |
|-----|-------------|
| `type` | Would overwrite node type (VARIABLE, FUNCTION, etc.) |
| `id` | Would overwrite semantic ID |
| `name` | Would overwrite display name |
| `file` | Would overwrite file path |
| `exported` | Would overwrite export flag |
| `nodeType` | Internal RFDB wire field |
| `originalId` | Internal legacy field |
| `semanticId` | Internal field |

**Use non-colliding names:**

| Don't use | Use instead |
|-----------|-------------|
| `metadata.type` | `metadata.tsType` |
| `metadata.name` | `metadata.displayName` |
| `metadata.id` | `metadata.externalId` |

## Detection

1. `console.log(JSON.stringify(node, null, 2))` — check if field is at top level
2. Raw wire format: `backend._client.getAllNodes()` returns `WireNode` with metadata as JSON string
3. If field appears in raw wire but not in parsed node → reserved key stripping

## Notes

- Applies to ALL custom fields on nodes, not just metadata
- Both TestDatabaseBackend and RFDBServerBackend have this behavior
- If you need truly nested data, store it as a JSON string that doesn't get auto-parsed
