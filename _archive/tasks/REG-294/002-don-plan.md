# Don Melton Analysis: Dynamic import() Tracking (REG-294)

## Executive Summary

**Good news:** Dynamic imports are **already partially implemented**. The infrastructure is in place; what's needed is to ensure it works end-to-end and add test coverage.

- `isDynamic`, `isResolvable`, and `dynamicPath` fields exist in ImportInfo type and ImportNode
- ImportExportVisitor has a CallExpression handler that detects `import()` calls
- GraphBuilder passes these fields through to IMPORT nodes

**What needs verification/completion:** Make sure dynamic imports are being detected and test coverage is added.

## 1. How Static Imports Are Currently Handled

**Files involved:**
- `packages/core/src/plugins/analysis/ast/visitors/ImportExportVisitor.ts` (detection)
- `packages/core/src/plugins/analysis/ast/types.ts` (types)
- `packages/core/src/core/nodes/ImportNode.ts` (node factory)
- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` (graph creation)

**Flow:**
1. **JSASTAnalyzer** instantiates ImportExportVisitor with module info and collections
2. **ImportExportVisitor.getImportHandlers()** traverses AST looking for:
   - `ImportDeclaration` nodes → static imports
   - `CallExpression` with `callee.type === 'Import'` → dynamic imports
3. Collected imports go into `collections.imports: ImportInfo[]`
4. **GraphBuilder.bufferImportNodes()** converts ImportInfo to ImportNode records
5. ImportNode includes `isDynamic`, `isResolvable`, `dynamicPath` fields

## 2. Where Dynamic import() Calls Are Detected

**Location:** ImportExportVisitor.ts, CallExpression handler

**Detection logic:**
```typescript
if (node.callee.type !== 'Import') {
  return;  // Skip non-import calls
}
```

The handler checks three patterns:

| Pattern | Type | isResolvable | source | dynamicPath |
|---------|------|--------------|--------|-------------|
| `import('./module.js')` | StringLiteral | true | './module.js' | undefined |
| `import(\`./config/${env}.js\`)` | TemplateLiteral | false | './config/' (prefix) | template string |
| `import(modulePath)` | Identifier | false | '<dynamic>' | 'modulePath' |

**Key insight:** Template literals extract the static prefix before first `${}` expression. If no prefix exists, source becomes `'<dynamic>'`.

## 3. IMPORT Node Type Status

**Current ImportNode fields exist:**

```typescript
interface ImportNodeRecord extends BaseNodeRecord {
  isDynamic?: boolean;          // ✓ Already exists
  isResolvable?: boolean;        // ✓ Already exists
  dynamicPath?: string;          // ✓ Already exists
}
```

**Status:** All three dynamic import fields are already defined. ✓

## 4. Test Coverage Gap

**Found fixture:** `test/fixtures/dynamic-imports/dynamic-import-patterns.js`

This fixture has test patterns but **no test file** consumes it.

**Missing tests should verify:**
1. `isDynamic: true` for `import()` calls (not set for static imports)
2. `isResolvable: true` for literal paths only
3. `isResolvable: false` for template/variable paths
4. `dynamicPath` populated correctly for templates and variables
5. Local binding captured correctly (await, no await, side-effect)
6. IMPORT nodes appear in graph with correct metadata

## 5. Implementation Checklist

**To complete REG-294:**

1. **Create test file** consuming the fixture
   - Verify each pattern produces correct IMPORT nodes
   - Check all fields: isDynamic, isResolvable, dynamicPath

2. **Verify end-to-end flow**
   - Run JSASTAnalyzer on dynamic-import-patterns.js
   - Check ImportExportVisitor.CallExpression handler fires
   - Verify GraphBuilder creates IMPORT nodes with all fields

3. **Add edge cases**
   - Multiple imports in one function
   - Dynamic imports in different scopes
   - Mix of static and dynamic imports in same file

## Key Files

| File | Purpose |
|------|---------|
| ImportExportVisitor.ts | Detection logic (mostly done, verify works) |
| types.ts | ImportInfo definition (complete) |
| ImportNode.ts | Node factory (complete) |
| GraphBuilder.ts | bufferImportNodes() passes fields through (complete) |
| Test file | **CREATE** - no tests exist for dynamic imports |

## Conclusion

**Status:** ~80% done. The architecture is correct; missing piece is test coverage to verify the end-to-end flow works as expected.
