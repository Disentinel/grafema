# REG-305: Don Melton Plan -- Track Mapped Types in TypeScript

## Current State Analysis

### How TYPE nodes work today

Grafema handles TypeScript type aliases through a 3-layer pipeline:

1. **TypeScriptVisitor** (`packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts`)
   - Handles `TSTypeAliasDeclaration` AST nodes
   - Extracts type name, file, line, column
   - Calls `typeNodeToString(node.typeAnnotation)` to get a string representation of the aliased type
   - Pushes a `TypeAliasInfo` into the `typeAliases` collection

2. **GraphBuilder** (`packages/core/src/plugins/analysis/ast/GraphBuilder.ts`, line ~2024)
   - `bufferTypeAliasNodes()` iterates over collected `typeAliases`
   - Creates TYPE nodes via `NodeFactory.createType(name, file, line, column, { aliasOf })`
   - Creates `MODULE --CONTAINS--> TYPE` edge

3. **TypeNode** (`packages/core/src/core/nodes/TypeNode.ts`)
   - Factory class that creates `TypeNodeRecord`
   - ID format: `{file}:TYPE:{name}:{line}`
   - Fields: `id`, `type`, `name`, `file`, `line`, `column`, `aliasOf`
   - `aliasOf` is the ONLY metadata field (a string like `"string"`, `"string | number"`, etc.)

### The gap

When Babel parses a mapped type:
```typescript
type Readonly<T> = { readonly [K in keyof T]: T[K] };
```

The `TSTypeAliasDeclaration` node has `typeAnnotation` of type `TSMappedType`. Currently, `typeNodeToString()` hits the `default` case and returns `'unknown'`. So the TYPE node gets created with `aliasOf: 'unknown'` -- losing all mapped type information.

### Babel's TSMappedType AST structure

```
TSMappedType {
  typeParameter: TSTypeParameter {    // K in keyof T
    name: string,                      // "K"
    constraint: TSTypeOperator {       // keyof T
      operator: "keyof",
      typeAnnotation: TSTypeReference   // T
    }
  },
  nameType: TSType | null,            // for `as` clause: [K in T as NewKey]
  typeAnnotation: TSType | null,      // T[K] -- the value type
  readonly: true | false | "+" | "-" | null,
  optional: true | false | "+" | "-" | null
}
```

### Existing patterns to follow

Looking at InterfaceNode and EnumNode as precedents:
- **InterfaceNode**: has `extends: string[]`, `properties: InterfacePropertyRecord[]`, `isExternal?: boolean`
- **EnumNode**: has `isConst: boolean`, `members: EnumMemberRecord[]`
- **TypeNode**: has only `aliasOf?: string` -- minimal metadata

The pattern is: node factories take structured options, create nodes with typed fields. The TypeScriptVisitor extracts data, GraphBuilder calls factories.

## Implementation Approach

### What to add

Per acceptance criteria:
1. **`mappedType: true`** on TYPE nodes that are mapped types
2. **Track key constraint** -- the `[K in keyof T]` part
3. **Track value type** -- the `T[K]` part

### Specific changes

#### 1. TypeNode factory (`packages/core/src/core/nodes/TypeNode.ts`)

Add optional fields to `TypeNodeRecord` and `TypeNodeOptions`:

```typescript
interface TypeNodeRecord extends BaseNodeRecord {
  type: 'TYPE';
  column: number;
  aliasOf?: string;
  // NEW: mapped type metadata
  mappedType?: boolean;
  keyName?: string;              // "K" -- the type parameter name
  keyConstraint?: string;        // "keyof T" -- string representation of constraint
  valueType?: string;            // "T[K]" -- string representation of value type
  mappedReadonly?: boolean | '+' | '-';   // readonly modifier
  mappedOptional?: boolean | '+' | '-';   // optional modifier
  nameType?: string;             // "as" clause remapping (e.g., [K in T as Uppercase<K>])
}
```

Update `TypeNodeOptions` and `TypeNode.create()` to accept and pass through these fields.
Update `TypeNode.OPTIONAL` array.

#### 2. TypeAliasInfo (`packages/core/src/plugins/analysis/ast/types.ts`)

Add same optional fields to `TypeAliasInfo` so the visitor can pass data to GraphBuilder:

```typescript
interface TypeAliasInfo {
  // ... existing fields ...
  // NEW: mapped type metadata
  mappedType?: boolean;
  keyName?: string;
  keyConstraint?: string;
  valueType?: string;
  mappedReadonly?: boolean | '+' | '-';
  mappedOptional?: boolean | '+' | '-';
  nameType?: string;
}
```

#### 3. TypeScriptVisitor (`packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts`)

In the `TSTypeAliasDeclaration` handler, detect when `node.typeAnnotation.type === 'TSMappedType'` and extract:
- `typeParameter.name` -> `keyName`
- `typeNodeToString(typeParameter.constraint)` -> `keyConstraint`
- `typeNodeToString(typeAnnotation)` -> `valueType`
- `readonly` -> `mappedReadonly`
- `optional` -> `mappedOptional`
- `typeNodeToString(nameType)` -> `nameType` (if present)

Also add `'TSMappedType'` case to `typeNodeToString()` so it returns a meaningful string (e.g., `"{ readonly [K in keyof T]: T[K] }"`) for `aliasOf`.

Also add `'TSTypeOperator'` case to `typeNodeToString()` (currently returns `'unknown'` for `keyof T`) so constraints are properly stringified.

Also add `'TSIndexedAccessType'` case (for `T[K]` patterns) to `typeNodeToString()`.

#### 4. GraphBuilder (`packages/core/src/plugins/analysis/ast/GraphBuilder.ts`)

In `bufferTypeAliasNodes()`, pass the new fields through to `NodeFactory.createType()`:

```typescript
const typeNode = NodeFactory.createType(
  typeAlias.name,
  typeAlias.file,
  typeAlias.line,
  typeAlias.column || 0,
  {
    aliasOf: typeAlias.aliasOf,
    // NEW: pass mapped type metadata if present
    ...(typeAlias.mappedType && {
      mappedType: true,
      keyName: typeAlias.keyName,
      keyConstraint: typeAlias.keyConstraint,
      valueType: typeAlias.valueType,
      mappedReadonly: typeAlias.mappedReadonly,
      mappedOptional: typeAlias.mappedOptional,
      nameType: typeAlias.nameType,
    })
  }
);
```

#### 5. NodeFactory (`packages/core/src/core/NodeFactory.ts`)

Update `TypeOptions` interface to include the new fields. The `createType` method already delegates to `TypeNode.create()`, so no logic change needed -- just the type definition.

### Files to modify (summary)

| File | Change |
|------|--------|
| `packages/core/src/core/nodes/TypeNode.ts` | Add mapped type fields to record, options, create(), OPTIONAL |
| `packages/core/src/plugins/analysis/ast/types.ts` | Add mapped type fields to TypeAliasInfo |
| `packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts` | Detect TSMappedType, extract metadata, add typeNodeToString cases |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Pass mapped type fields in bufferTypeAliasNodes() |
| `packages/core/src/core/NodeFactory.ts` | Update TypeOptions interface |

### Test files to create/modify

| File | Purpose |
|------|---------|
| `test/unit/TypeNodeMigration.test.js` | Add tests for new mapped type fields on TypeNode.create() |
| New: `test/unit/MappedType.test.js` | Integration test: parse TS with mapped types, verify TYPE node metadata |

## Risk Assessment

**Risk: LOW**

- **Scope is small** -- adding optional fields to an existing node type. No new node types, no new edge types.
- **Backward compatible** -- all new fields are optional. Existing TYPE nodes without mapped type info are unaffected.
- **No iteration-space concern** -- not scanning all nodes. The visitor already iterates over `TSTypeAliasDeclaration` AST nodes (forward registration pattern). We're just extracting more data from nodes we already visit.
- **No architectural change** -- follows the exact same pattern as EnumNode's `isConst`/`members` or InterfaceNode's `extends`/`properties`.
- **typeNodeToString improvements** -- adding TSMappedType, TSTypeOperator, TSIndexedAccessType cases to `typeNodeToString()` also improves `aliasOf` string quality for non-mapped-type cases (e.g., `type Keys = keyof Foo` currently gets `aliasOf: 'unknown'`, will now get `aliasOf: 'keyof Foo'`).

**One consideration:** The `readonly` and `optional` modifiers on mapped types use `true | false | '+' | '-'` (not just boolean). The `+` means "add modifier", `-` means "remove modifier" (e.g., `{ -readonly [K in keyof T]: T[K] }` removes readonly). We must preserve this distinction -- it's semantically important.

## Estimated effort

- TypeNode factory + NodeFactory: ~30 min
- TypeAliasInfo types: ~10 min
- TypeScriptVisitor (detection + typeNodeToString): ~45 min
- GraphBuilder passthrough: ~15 min
- Tests: ~60 min
- Total: ~2.5 hours

## Implementation order

1. Tests first (TDD): TypeNode.create() with mapped type options
2. TypeNode + NodeFactory type changes
3. TypeAliasInfo type changes
4. TypeScriptVisitor: typeNodeToString improvements (TSTypeOperator, TSIndexedAccessType, TSMappedType)
5. TypeScriptVisitor: TSTypeAliasDeclaration mapped type detection
6. GraphBuilder passthrough
7. Integration test: full pipeline from TS source to graph node with mapped type metadata
