# REG-303: AST — Track Type Parameter Constraints

## Don Melton — Tech Lead Plan

---

## 1. Current State Analysis

### What exists

**Node types:**
- `TYPE` node exists (`TypeNode.ts`) -- represents type alias declarations (`type Foo = ...`)
- `INTERFACE` node exists (`InterfaceNode.ts`) -- has `extends` and `properties` fields
- `PARAMETER` node exists -- represents function parameters (value params, not type params)
- **No `TYPE_PARAMETER` node exists anywhere in the codebase**

**Edge types:**
- `EXTENDS` edge exists in `EDGE_TYPE` (edges.ts line 41) -- currently used for:
  - Interface extends interface (`bufferInterfaceNodes` in GraphBuilder)
  - Class extends class uses `DERIVES_FROM` instead (interesting divergence)
- `IMPLEMENTS` edge exists -- class implements interface

**Current type handling in visitors:**
- `TypeScriptVisitor.ts` handles: `TSInterfaceDeclaration`, `TSTypeAliasDeclaration`, `TSEnumDeclaration`
- `FunctionVisitor.ts` extracts `paramTypes` and `returnType` as **strings** (via `typeNodeToString()`)
- `typeNodeToString()` converts type AST nodes to string representations but **completely ignores type parameters** -- e.g., `Promise<string>` becomes just `Promise`, `Array<T>` becomes just `Array`
- `InterfaceSchemaExtractor.ts` has a `typeParameters?: string[]` field on its internal `InterfaceNodeRecord`, suggesting some awareness of type params exists in the schema layer, but the data is never populated from the analyzer

**What's NOT tracked:**
- Type parameters on functions: `function foo<T>(x: T): T {}`
- Type parameters on classes: `class Box<T> {}`
- Type parameters on interfaces: `interface Container<T> {}`
- Type parameters on type aliases: `type Pair<A, B> = [A, B]`
- Constraints: `<T extends Serializable>`
- Defaults: `<T = string>`

### Babel AST representation

Per [Babel docs](https://babeljs.io/docs/babel-types) and [Babel types source](https://github.com/babel/babel/issues/10317):

```
TSTypeParameterDeclaration {
  params: TSTypeParameter[]
}

TSTypeParameter {
  name: string          // (Babel 7: string, Babel 8: Identifier)
  constraint?: TSType   // e.g., TSTypeReference for "extends Serializable"
  default?: TSType      // e.g., TSStringKeyword for "= string"
  in?: boolean          // variance: `in T`
  out?: boolean         // variance: `out T`
}
```

Where `TSTypeParameterDeclaration` appears on:
- `FunctionDeclaration.typeParameters`
- `ArrowFunctionExpression.typeParameters`
- `ClassDeclaration.typeParameters`
- `TSInterfaceDeclaration.typeParameters`
- `TSTypeAliasDeclaration.typeParameters`
- `ClassMethod.typeParameters`

---

## 2. What Needs to Be Added/Changed

### New node type: `TYPE_PARAMETER`

A new base node type representing a generic type parameter.

```
TYPE_PARAMETER {
  name: string           // "T", "K", "V"
  constraint?: string    // String representation of constraint type: "Serializable", "string"
  default?: string       // String representation of default type: "string", "unknown"
  variance?: 'in' | 'out' | 'in out'  // TypeScript variance annotations
}
```

**ID format:** `{parentId}:TYPE_PARAMETER:{name}` -- scoped to parent (function, class, interface, type alias).

### New edge: `EXTENDS` (reuse existing)

The `EXTENDS` edge type already exists. We reuse it for:
- `TYPE_PARAMETER --EXTENDS--> constraint type node` (when constraint is a known INTERFACE/CLASS/TYPE in the graph)

### New edge: `HAS_TYPE_PARAMETER` (new)

Need a containment edge to connect owner to its type parameters:
- `FUNCTION --HAS_TYPE_PARAMETER--> TYPE_PARAMETER`
- `CLASS --HAS_TYPE_PARAMETER--> TYPE_PARAMETER`
- `INTERFACE --HAS_TYPE_PARAMETER--> TYPE_PARAMETER`
- `TYPE --HAS_TYPE_PARAMETER--> TYPE_PARAMETER`

Could also use `CONTAINS` but `HAS_TYPE_PARAMETER` is more semantic and queryable.

### Collection type: `TypeParameterInfo`

```typescript
interface TypeParameterInfo {
  name: string;              // "T"
  constraintType?: string;   // "Serializable" (string repr)
  defaultType?: string;      // "string" (string repr)
  variance?: 'in' | 'out' | 'in out';
  parentId: string;          // ID of owning function/class/interface/type
  parentType: 'FUNCTION' | 'CLASS' | 'INTERFACE' | 'TYPE';
  file: string;
  line: number;
  column: number;
}
```

---

## 3. Files That Need Modification

| File | Change |
|------|--------|
| `packages/types/src/nodes.ts` | Add `TYPE_PARAMETER` to `NODE_TYPE` const |
| `packages/types/src/edges.ts` | Add `HAS_TYPE_PARAMETER` to `EDGE_TYPE` const |
| `packages/core/src/core/nodes/NodeKind.ts` | Add `TYPE_PARAMETER` to `NODE_TYPE` |
| `packages/core/src/plugins/analysis/ast/types.ts` | Add `TypeParameterInfo` interface, add `typeParameters?: TypeParameterInfo[]` to `ASTCollections` |
| `packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts` | Extract type params from `TSInterfaceDeclaration` and `TSTypeAliasDeclaration` |
| `packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts` | Extract type params from `FunctionDeclaration` and `ArrowFunctionExpression` |
| `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` | Extract type params from `ClassDeclaration` and `ClassMethod` |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | New `bufferTypeParameterNodes()` method; call it from `build()` |
| **New file:** `packages/core/src/core/nodes/TypeParameterNode.ts` | Node contract for TYPE_PARAMETER |
| `packages/core/src/core/nodes/index.ts` | Export TypeParameterNode |
| `packages/core/src/core/NodeFactory.ts` | Add `createTypeParameter()` factory method |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Add `HAS_TYPE_PARAMETER` to plugin metadata edge list |

---

## 4. Risks and Edge Cases

### Multiple constraints: `T extends A & B`

Babel represents `<T extends A & B>` as:
```
TSTypeParameter.constraint = TSIntersectionType {
  types: [TSTypeReference(A), TSTypeReference(B)]
}
```

**Approach:** Store constraint as string `"A & B"` in `TYPE_PARAMETER.constraint` metadata (using existing `typeNodeToString()`). Create EXTENDS edges to **each** type that resolves to a known node. This is the pattern the codebase already uses for interface extends.

### Default type params: `T = string`

Babel represents `<T = string>` as:
```
TSTypeParameter.default = TSStringKeyword
```

**Approach:** Store in `TYPE_PARAMETER.default` as string via `typeNodeToString()`. No edge needed -- this is metadata, not a graph relationship.

### Nested generics: `T extends Map<string, V>`

The constraint type itself may have type arguments. `typeNodeToString()` currently turns `TSTypeReference` into just the type name (e.g., `"Map"`, dropping `<string, V>`).

**Risk level:** LOW for MVP. The constraint string will be incomplete (`"Map"` instead of `"Map<string, V>"`) but the EXTENDS edge to `Map` is still correct. Improving `typeNodeToString()` to handle `TSTypeReference.typeParameters` is a separate enhancement (not needed for this task).

### Variance annotations: `in T`, `out T`

TypeScript 4.7+ supports variance annotations on type parameters. Babel exposes these as `TSTypeParameter.in` and `TSTypeParameter.out` booleans.

**Approach:** Store as `variance` field on TYPE_PARAMETER node. Low priority -- most codebases don't use variance annotations.

### Type parameters on methods

Class methods can have their own type parameters: `class Foo { bar<U>(x: U): U {} }`. The `ClassMethod` AST node has `typeParameters`. This needs to be handled in ClassVisitor alongside function-level type parameters.

### Type parameter ID uniqueness

Using `{parentId}:TYPE_PARAMETER:{name}` ensures uniqueness since type parameter names are unique within their declaration scope (you can't have `<T, T>`).

### Cross-file constraint resolution

When `<T extends Serializable>` refers to an interface defined in another file, we won't be able to create the EXTENDS edge during single-file analysis. This matches existing behavior for interface extends and class implements -- dangling edges are expected and resolved during enrichment.

---

## 5. Recommended Approach

### Strategy: Extend existing visitor + GraphBuilder pattern

This follows the established pattern exactly:
1. **Visitors** extract data into collection arrays (like `InterfaceDeclarationInfo[]`)
2. **GraphBuilder** converts collections into nodes + edges (like `bufferInterfaceNodes()`)

### Implementation order

1. **Types first** -- Add `TYPE_PARAMETER` node type, `HAS_TYPE_PARAMETER` edge type, `TypeParameterInfo` interface
2. **Node contract** -- Create `TypeParameterNode.ts` following exact pattern of `TypeNode.ts`/`InterfaceNode.ts`
3. **Extraction** -- Add type parameter extraction to TypeScriptVisitor, FunctionVisitor, ClassVisitor
4. **Graph building** -- Add `bufferTypeParameterNodes()` to GraphBuilder
5. **Tests** -- Test all declaration contexts (function, arrow, class, interface, type alias, method)

### What we're NOT doing (scope boundaries)

- NOT enhancing `typeNodeToString()` to include generic arguments (separate task)
- NOT tracking type parameter usage sites (where T is used as a type annotation in params/returns)
- NOT tracking type argument instantiation (`foo<string>()` -- that's a different feature)
- NOT changing the existing `paramTypes`/`returnType` string representation

### Complexity assessment

This is a **local addition** -- no architectural changes, no iteration space concerns:
- Visitors already traverse the exact AST nodes we need
- We're adding extraction of `.typeParameters` property that's already accessible
- GraphBuilder pattern is copy-paste from `bufferInterfaceNodes()`/`bufferTypeAliasNodes()`
- O(k) per declaration where k = number of type params (typically 1-3)

**Estimated effort:** Small task. Single agent (Rob) sufficient.

---

## Sources

- [Babel Types documentation](https://babeljs.io/docs/babel-types)
- [Babel TSTypeParameter issue #10317](https://github.com/babel/babel/issues/10317)
