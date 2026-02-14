# Don Melton Plan: REG-304 — AST: Track Conditional Types

## Current State

### How TypeScript types are handled now

1. **TypeScriptVisitor** (`packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts`) handles three TS-specific declaration types:
   - `TSInterfaceDeclaration` -> `InterfaceDeclarationInfo` -> INTERFACE node
   - `TSTypeAliasDeclaration` -> `TypeAliasInfo` -> TYPE node
   - `TSEnumDeclaration` -> `EnumDeclarationInfo` -> ENUM node

2. **TypeAliasInfo** (`packages/core/src/plugins/analysis/ast/types.ts:369-382`) is minimal:
   - `name`, `file`, `line`, `column`, `semanticId`
   - `aliasOf?: string` — a **string representation** of the aliased type (via `typeNodeToString()`)

3. **TypeNode** (`packages/core/src/core/nodes/TypeNode.ts`) creates TYPE nodes with:
   - ID format: `{file}:TYPE:{name}:{line}`
   - Fields: `name`, `file`, `line`, `column`, `aliasOf`
   - No structural metadata about the type's shape

4. **`typeNodeToString()`** converts type AST nodes to string representation. Currently handles: keywords, references, arrays, unions, intersections, literals, functions, tuples, type literals. **Does NOT handle `TSConditionalType`** — falls through to `default: return 'unknown'`.

5. **GraphBuilder.bufferTypeAliasNodes()** (`GraphBuilder.ts:2024-2043`) creates TYPE node via `NodeFactory.createType()` and a `MODULE -> CONTAINS -> TYPE` edge. No additional metadata beyond `aliasOf`.

### What's missing

- `TSConditionalType` not recognized at all — produces `aliasOf: 'unknown'`
- No metadata to distinguish conditional types from simple aliases
- No tracking of check/extends/true/false branches
- No `TSInferType` support in `typeNodeToString()`

## Babel AST Structure: TSConditionalType

```typescript
// type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;
{
  type: 'TSConditionalType',
  checkType: { type: 'TSTypeReference', typeName: { name: 'T' } },
  extendsType: { type: 'TSTypeReference', typeName: { name: 'Promise' }, typeParameters: ... },
  trueType: { type: 'TSTypeReference', typeName: { name: 'U' } },
  falseType: { type: 'TSTypeReference', typeName: { name: 'T' } }
}
```

The `TSConditionalType` node has four children: `checkType`, `extendsType`, `trueType`, `falseType`. All four are type nodes that `typeNodeToString()` can recursively process.

`TSInferType` appears inside `extendsType` — `{ type: 'TSInferType', typeParameter: { type: 'TSTypeParameter', name: 'U' } }`.

## Proposed Changes

### Approach: Metadata on TYPE node (not sub-nodes or edges)

Conditional types are **structural metadata** of a type alias, not separate entities. Same pattern as `aliasOf`, `isConst` on enums, `extends` on interfaces. Store as metadata fields on the TYPE node itself.

This is correct because:
- A conditional type is ONE type alias with internal structure
- The branches aren't separate graph entities — they're properties of the type
- Querying "find all conditional types" = `type=TYPE AND conditionalType=true` (simple attribute query)
- No extra iteration over the graph — just richer metadata on nodes we already create

### 1. Extend `TypeAliasInfo` in `types.ts`

Add optional metadata fields:

```typescript
export interface TypeAliasInfo {
  // ... existing fields ...
  aliasOf?: string;
  // REG-304: Conditional type tracking
  conditionalType?: boolean;
  checkType?: string;      // string repr of check type (e.g., "T")
  extendsType?: string;    // string repr of extends type (e.g., "Promise")
  trueType?: string;       // string repr of true branch (e.g., "U")
  falseType?: string;      // string repr of false branch (e.g., "T")
}
```

### 2. Extend `TypeNode` in `nodes/TypeNode.ts`

Add the same fields to `TypeNodeRecord` and `TypeNodeOptions`:

```typescript
interface TypeNodeRecord extends BaseNodeRecord {
  type: 'TYPE';
  column: number;
  aliasOf?: string;
  // REG-304: Conditional type metadata
  conditionalType?: boolean;
  checkType?: string;
  extendsType?: string;
  trueType?: string;
  falseType?: string;
}

interface TypeNodeOptions {
  aliasOf?: string;
  conditionalType?: boolean;
  checkType?: string;
  extendsType?: string;
  trueType?: string;
  falseType?: string;
}
```

Update `OPTIONAL` array and `create()` to pass through new fields.

### 3. Update `TypeOptions` in `NodeFactory.ts`

Mirror the new optional fields so `NodeFactory.createType()` passes them through.

### 4. Update `typeNodeToString()` in `TypeScriptVisitor.ts`

Add two cases to the switch:

```typescript
case 'TSConditionalType':
  const check = typeNodeToString(typeNode.checkType);
  const ext = typeNodeToString(typeNode.extendsType);
  const trueT = typeNodeToString(typeNode.trueType);
  const falseT = typeNodeToString(typeNode.falseType);
  return `${check} extends ${ext} ? ${trueT} : ${falseT}`;

case 'TSInferType':
  const tp = typeNode.typeParameter as { name?: string };
  return `infer ${tp?.name || 'unknown'}`;
```

### 5. Update `TSTypeAliasDeclaration` handler in `TypeScriptVisitor.ts`

After computing `aliasOf`, detect if `node.typeAnnotation.type === 'TSConditionalType'` and extract structured metadata:

```typescript
TSTypeAliasDeclaration: (path: NodePath) => {
  // ... existing code ...
  const aliasOf = typeNodeToString(node.typeAnnotation);

  // REG-304: Detect conditional type and extract branches
  const typeAnnotation = node.typeAnnotation as { type: string; [key: string]: unknown };
  let conditionalMeta: Partial<TypeAliasInfo> = {};
  if (typeAnnotation.type === 'TSConditionalType') {
    conditionalMeta = {
      conditionalType: true,
      checkType: typeNodeToString(typeAnnotation.checkType),
      extendsType: typeNodeToString(typeAnnotation.extendsType),
      trueType: typeNodeToString(typeAnnotation.trueType),
      falseType: typeNodeToString(typeAnnotation.falseType),
    };
  }

  (typeAliases as TypeAliasInfo[]).push({
    ...conditionalMeta,
    semanticId: typeSemanticId,
    type: 'TYPE',
    name: typeName,
    file: module.file,
    line: getLine(node),
    column: getColumn(node),
    aliasOf
  });
};
```

### 6. Update `bufferTypeAliasNodes()` in `GraphBuilder.ts`

Pass the new metadata through to `NodeFactory.createType()`:

```typescript
const typeNode = NodeFactory.createType(
  typeAlias.name,
  typeAlias.file,
  typeAlias.line,
  typeAlias.column || 0,
  {
    aliasOf: typeAlias.aliasOf,
    conditionalType: typeAlias.conditionalType,
    checkType: typeAlias.checkType,
    extendsType: typeAlias.extendsType,
    trueType: typeAlias.trueType,
    falseType: typeAlias.falseType,
  }
);
```

## Files to Modify

| File | Change |
|------|--------|
| `packages/core/src/plugins/analysis/ast/types.ts` | Add 5 optional fields to `TypeAliasInfo` |
| `packages/core/src/core/nodes/TypeNode.ts` | Add fields to record/options, update `create()`, `OPTIONAL` |
| `packages/core/src/core/NodeFactory.ts` | Add fields to `TypeOptions` |
| `packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts` | Add `TSConditionalType`/`TSInferType` to `typeNodeToString()`, detect conditional in handler |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Pass new metadata in `bufferTypeAliasNodes()` |

## Test Plan

1. **Unit: TypeNode.create() with conditional metadata** — verify fields are stored and validated
2. **Unit: typeNodeToString() with TSConditionalType** — verify string representation
3. **Unit: typeNodeToString() with TSInferType** — verify `infer U` rendering
4. **Unit: typeNodeToString() with nested conditional** — `T extends A ? (B extends C ? D : E) : F`
5. **Integration: Full analysis of .ts file with conditional type** — verify TYPE node in graph has `conditionalType: true` and all four branch fields

Follow existing test patterns from `test/unit/TypeNodeMigration.test.js` for unit tests and `test/unit/InterfaceNodeMigration.test.js` for integration (analyze real .ts file).

## Complexity Assessment

**Small, well-scoped feature.** Estimated: 2-3 hours.

- No new node types
- No new edge types
- No new collection arrays
- No graph iteration changes
- Pure metadata addition on existing TYPE nodes
- Follows exact same pattern as `aliasOf` (just more fields)
- `typeNodeToString()` changes are two simple switch cases

**O(1) per type alias** — no additional graph scanning. Zero impact on performance.

## Risk Assessment

**LOW risk.**

- All changes are additive (new optional fields)
- Existing TYPE nodes unchanged — `conditionalType` defaults to `undefined`/absent
- No breaking changes to ID format or node structure
- `typeNodeToString()` currently returns `'unknown'` for conditional types, so any string output is an improvement
- Backward compatible — old code ignores new fields

**One edge case:** Nested conditional types (`T extends A ? (B extends C ? D : E) : F`). The recursive nature of `typeNodeToString()` handles this naturally — the `trueType`/`falseType` string representations will contain the nested conditional text. The structured `trueType`/`falseType` fields on the outer TYPE node will show the full string, not the nested structure. This is fine for the first iteration — if we need tree-structured conditional tracking later, it would be a separate ticket.
