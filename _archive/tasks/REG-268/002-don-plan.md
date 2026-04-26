# Don Melton - High-Level Plan for REG-268

## Architectural Analysis

The core design questions need careful consideration to ensure we do this RIGHT.

### Design Question 1: Semantic ID for dynamic imports

Dynamic imports don't have named specifiers like `import { foo }`. The pattern is:
```javascript
const mod = await import('./dynamic.js');  // namespace-like
const { foo } = await import('./utils');   // destructured after
```

**Decision**: A dynamic import is semantically equivalent to `import * as X from Y` - it returns the module namespace. The semantic ID should use the **local variable name** that receives the import result:

- `const mod = await import('./foo')` → `{file}:IMPORT:{source}:mod`
- `await import('./side-effect')` → `{file}:IMPORT:{source}:*` (unnamed, no binding)

For multiple unnamed imports to same source, use line number as discriminator since we can't deduplicate by name.

### Design Question 2: Variable binding tracking

**Decision**: YES, track which variable receives the dynamic import. This aligns with graph-first vision - AI querying the graph should be able to follow data flow from `import()` to variable to usage.

The `local` field in ImportNode already serves this purpose for static imports.

### Design Question 3: Edge creation for unresolvable paths

**Decision**: For unresolvable paths (variables, complex expressions):
- Still create IMPORT node with `isDynamic: true`, `isResolvable: false`
- Do NOT create IMPORTS_FROM edges (can't know the target)
- Store the expression source in `dynamicPath` for transparency

ImportExportLinker will naturally skip unresolvable paths.

### Design Question 4: Multiple dynamic imports to same source

**Decision**: Use same semantic ID pattern. If multiple `import('./foo')` in same file:
- Named: `{file}:IMPORT:./foo:mod1`, `{file}:IMPORT:./foo:mod2`
- Unnamed: Use line number in semantic ID for disambiguation

## Alignment with Project Vision

This feature strongly aligns with Grafema's vision:
- **Graph-first**: Dynamic imports represent real dependencies that should be queryable
- **AI should query graph, not code**: Without this, AI must read code to find lazy-loaded modules
- **Legacy codebase support**: Many large codebases use dynamic imports for code splitting

## Implementation Strategy

**Phase 1: Type Extensions**
- Add `isDynamic`, `isResolvable`, `dynamicPath` to ImportNodeRecord
- Extend ImportInfo in types.ts

**Phase 2: AST Visitor**
- Handle `ImportExpression` AST node (Babel's representation of dynamic import)
- Detect path type: StringLiteral, TemplateLiteral, or Identifier/Expression
- Extract local variable name from VariableDeclarator parent if present

**Phase 3: GraphBuilder**
- Extend `bufferImportNodes()` to handle dynamic imports
- Use ImportNode.create() with new fields

**Phase 4: Tests**
- Cover all dynamic import patterns: literal, template, variable
- Cover named and unnamed bindings
- Cover edge creation for resolvable vs unresolvable

## Critical Files

1. `packages/core/src/plugins/analysis/ast/visitors/ImportExportVisitor.ts` - Add ImportExpression handler
2. `packages/core/src/core/nodes/ImportNode.ts` - Add isDynamic, isResolvable, dynamicPath fields
3. `packages/core/src/plugins/analysis/ast/types.ts` - Extend ImportInfo type
4. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Handle dynamic imports in bufferImportNodes

## Risk Assessment

- **Low risk**: This extends existing functionality without changing current behavior
- **Backward compatible**: All new fields are optional, existing imports unchanged
- **No architectural changes**: Uses existing 3-phase flow (Analysis → GraphBuilder → Enrichment)
