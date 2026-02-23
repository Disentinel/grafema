---
name: grafema-metadata-reserved-keys
description: |
  Fix silent metadata data loss when storing custom fields on Grafema graph nodes.
  Use when: (1) metadata field value disappears after analysis — stored during
  indexing but not readable from query results, (2) node metadata field is always
  undefined despite being set in ClassVisitor/FunctionVisitor/GraphBuilder,
  (3) you named a metadata field "type", "id", "name", "file", or another reserved
  key. Root cause: RFDBServerBackend._parseNode() strips reserved keys from
  metadata to prevent them from overwriting top-level node fields via spread.
author: Claude Code
version: 1.0.0
date: 2026-02-22
---

# Grafema: Metadata Reserved Keys (Silent Data Loss)

## Problem

When adding custom metadata to a graph node (e.g., `metadata.type = 'GraphBackend'`),
the value is stored correctly in RFDB during analysis but disappears when reading
the node back from the graph. Tests fail with `undefined` even though the indexing
code runs correctly.

## Root Cause

`RFDBServerBackend._parseNode()` (`packages/core/src/storage/backends/RFDBServerBackend.ts`
around line 449) strips a set of **reserved keys** from `metadata` before spreading
it onto the returned node object:

```typescript
const {
  id: _id,
  type: _type,       // ← RESERVED — strips "type" from metadata
  name: _name,
  file: _file,
  exported: _exported,
  nodeType: _nodeType,
  originalId: _originalId,
  semanticId: _semanticId,
  ...safeMetadata    // ← only safeMetadata is spread onto the node
} = metadata;
```

These keys are stripped to prevent metadata values from overwriting top-level node
fields (the REG-325 fix). So `metadata.type` is silently discarded, and your custom
value never reaches consumers.

## Reserved Keys (Never Use These for Custom Metadata)

| Key | Why reserved |
|-----|-------------|
| `type` | Would overwrite node type ('VARIABLE', 'FUNCTION', etc.) |
| `id` | Would overwrite the node's semantic ID |
| `name` | Would overwrite the node's display name |
| `file` | Would overwrite the file path |
| `exported` | Would overwrite export flag |
| `nodeType` | Internal RFDB wire field |
| `originalId` | Internal v2 legacy field |
| `semanticId` | Internal v3 field |

## Solution

Use non-colliding metadata key names. Common renames:

| Intended name | Safe alternative |
|--------------|-----------------|
| `metadata.type` | `metadata.tsType` (TypeScript type annotation) |
| `metadata.type` | `metadata.nodeKind` (semantic classification) |
| `metadata.name` | `metadata.displayName` or `metadata.aliasName` |
| `metadata.id` | `metadata.externalId` or `metadata.referenceId` |

## Where to Fix

If the field is set in `GraphBuilder.ts` via the metadata-stripping loop pattern
(e.g., for VARIABLE nodes added in REG-552), update the key name there:

```typescript
// WRONG — 'type' will be stripped by _parseNode
if (_tsType) (node.metadata as Record<string, unknown>).type = _tsType;

// CORRECT — 'tsType' is not a reserved key
if (_tsType) (node.metadata as Record<string, unknown>).tsType = _tsType;
```

If the field is set directly via `FunctionInfo`, `VariableDeclarationInfo`, or similar
collector interfaces, ensure the metadata key written in `GraphBuilder` uses a
non-reserved name.

## How to Check for the Bug

1. Add a field to node metadata during indexing
2. After analysis, query `backend.getAllNodes()` and inspect the node
3. If the field is missing but you KNOW it was set, check `_parseNode` reserved keys
4. Verify by checking raw wire format: `backend._client.getAllNodes()` returns
   `WireNode` with `metadata` as a JSON string — parse it and look for your key there

If the key appears in raw wire metadata but NOT in the parsed node, it's being stripped
by `_parseNode`.

## Notes

- This is a silent failure — no error thrown, field just disappears
- The stripping was introduced to fix REG-325 (metadata spread was overwriting `name`)
- The list of stripped keys is hardcoded in `_parseNode` — if new reserved fields are
  added to `WireNode`, the list must be updated
- `metadata.accessibility`, `metadata.readonly`, `metadata.tsType` are safe (confirmed
  in REG-552)
