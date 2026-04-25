# Joel Spolsky - Technical Implementation Plan for REG-268

## Overview

Implement dynamic import tracking by extending the existing import analysis flow.

## Data Flow Understanding

```
ImportExportVisitor (AST)
    ↓
imports[] (local ImportInfo in visitor)
    ↓
GraphBuilder.bufferImportNodes()
    ↓
ImportNode.create()
    ↓
RFDB Graph
```

**Key insight**: The `ImportInfo` type in ImportExportVisitor.ts (lines 47-52) is LOCAL to that file and different from the one in types.ts. GraphBuilder consumes the visitor's local type directly.

## Implementation Steps

### Step 1: Extend ImportNode Contract

**File**: `packages/core/src/core/nodes/ImportNode.ts`

Add new fields to `ImportNodeRecord`:
```typescript
interface ImportNodeRecord extends BaseNodeRecord {
  type: 'IMPORT';
  column: number;
  source: string;
  importType: ImportType;
  importBinding: ImportBinding;
  imported: string;
  local: string;
  // NEW FIELDS:
  isDynamic?: boolean;       // true for import() expressions
  isResolvable?: boolean;    // false if path is variable/expression
  dynamicPath?: string;      // original expression for template literals
}
```

Add fields to `ImportNodeOptions`:
```typescript
interface ImportNodeOptions {
  importType?: ImportType;
  importBinding?: ImportBinding;
  imported?: string;
  local?: string;
  // NEW:
  isDynamic?: boolean;
  isResolvable?: boolean;
  dynamicPath?: string;
}
```

Update `create()` method to set these fields.

### Step 2: Extend Local ImportInfo in ImportExportVisitor

**File**: `packages/core/src/plugins/analysis/ast/visitors/ImportExportVisitor.ts`

Extend local `ImportInfo` interface (lines 47-52):
```typescript
interface ImportInfo {
  source: string;
  specifiers: ImportSpecifierInfo[];
  line: number;
  column?: number;
  // NEW FIELDS:
  isDynamic?: boolean;
  isResolvable?: boolean;
  dynamicPath?: string;
}
```

### Step 3: Add ImportExpression Handler

**File**: `packages/core/src/plugins/analysis/ast/visitors/ImportExportVisitor.ts`

Add new handler in `getImportHandlers()`:

```typescript
// Babel represents dynamic import() as CallExpression with callee.type === 'Import'
// In newer Babel, it's ImportExpression node type
CallExpression: (path: NodePath) => {
  const node = path.node as CallExpression;

  // Check if this is a dynamic import
  if (node.callee.type !== 'Import') return;

  const arg = node.arguments[0];
  let source: string;
  let isResolvable: boolean;
  let dynamicPath: string | undefined;

  if (arg.type === 'StringLiteral') {
    // import('./module.js') - fully resolvable
    source = arg.value;
    isResolvable = true;
  } else if (arg.type === 'TemplateLiteral') {
    // import(`./config/${env}.js`) - partially resolvable
    // Extract the static prefix before first interpolation
    const quasis = arg.quasis;
    source = quasis[0].value.raw;  // e.g., "./config/"
    isResolvable = false;
    dynamicPath = `\`${arg.quasis.map(q => q.value.raw).join('${...}')}\``;
  } else {
    // import(modulePath) - not resolvable
    source = '<dynamic>';
    isResolvable = false;
    if (arg.type === 'Identifier') {
      dynamicPath = arg.name;
    }
  }

  // Try to find the receiving variable name
  let localName = '*';  // default for namespace-like access
  const parent = path.parent;
  if (parent?.type === 'AwaitExpression') {
    const grandparent = path.parentPath?.parent;
    if (grandparent?.type === 'VariableDeclarator') {
      const id = grandparent.id;
      if (id.type === 'Identifier') {
        localName = id.name;
      }
    }
  } else if (parent?.type === 'VariableDeclarator') {
    const id = parent.id;
    if (id.type === 'Identifier') {
      localName = id.name;
    }
  }

  (imports as ImportInfo[]).push({
    source,
    specifiers: [{
      imported: '*',  // dynamic imports always return namespace
      local: localName
    }],
    line: getLine(node),
    column: getColumn(node),
    isDynamic: true,
    isResolvable,
    dynamicPath
  });
}
```

**Note**: Need to import `CallExpression` type from `@babel/types`.

### Step 4: Update GraphBuilder

**File**: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

Update `bufferImportNodes()` to pass new fields:

```typescript
private bufferImportNodes(module: ModuleNode, imports: ImportInfo[]): void {
  for (const imp of imports) {
    const { source, specifiers, line, column, isDynamic, isResolvable, dynamicPath } = imp;

    for (const spec of specifiers) {
      const importNode = ImportNode.create(
        spec.local,
        module.file,
        line,
        column || 0,
        source,
        {
          imported: spec.imported,
          local: spec.local,
          // NEW: pass dynamic import fields
          isDynamic,
          isResolvable,
          dynamicPath
        }
      );
      // ... rest unchanged
    }
  }
}
```

### Step 5: Tests (TDD)

**File**: `test/unit/plugins/analysis/ast/dynamic-imports.test.ts` (new file)

Test cases:
1. `import('./module.js')` - literal path, creates IMPORT node with isDynamic=true, isResolvable=true
2. `const mod = await import('./module.js')` - captures local name "mod"
3. `import(\`./config/\${env}.js\`)` - template literal, isDynamic=true, isResolvable=false, dynamicPath captured
4. `import(modulePath)` - variable path, isDynamic=true, isResolvable=false, source='<dynamic>'
5. Verify IMPORTS_FROM edge created for resolvable paths (via existing enrichment)
6. Verify no IMPORTS_FROM edge for unresolvable paths

## File Change Summary

| File | Change |
|------|--------|
| `ImportNode.ts` | Add isDynamic, isResolvable, dynamicPath fields |
| `ImportExportVisitor.ts` | Extend ImportInfo, add CallExpression handler |
| `GraphBuilder.ts` | Pass new fields to ImportNode.create() |
| `dynamic-imports.test.ts` | New test file |

## Semantic ID Design

For dynamic imports:
- `const mod = await import('./foo')` → `{file}:IMPORT:./foo:mod`
- `await import('./side-effect')` → `{file}:IMPORT:./side-effect:*`
- `import(path)` → `{file}:IMPORT:<dynamic>:*` (with line for disambiguation)

The `*` local name indicates namespace-like access (entire module object).

## Edge Cases

1. **Multiple unnamed imports to same source**: Semantic ID uses line number implicitly through graph storage, no collision since each is a distinct node instance.

2. **Destructured after import**: `const { foo } = await import('./x')` - we track the import, destructuring is separate assignment analysis.

3. **Re-assigned import**: `let x = await import('./a'); x = await import('./b')` - each creates separate IMPORT node.

## No Changes Needed

- **ImportExportLinker.ts**: Already handles relative vs external resolution. Will naturally create IMPORTS_FROM edges for resolvable dynamic imports.
- **types.ts ASTCollections ImportInfo**: This is a different type, not used in this flow.
