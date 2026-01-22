# Joel Spolsky - Technical Plan

## Summary

This plan implements `createImport` method in NodeFactory and migrates GraphBuilder to use it. The key challenge is resolving the architectural mismatch identified by Don: ImportNode uses `importKind` ('value'|'type'|'typeof') while GraphBuilder uses `importType` ('default'|'named'|'namespace'). Per user decision in 003-user-decision.md, we need both fields: rename `importKind` → `importBinding` and add new `importType` field to ImportNode contract.

## Dependencies

- `packages/core/src/core/nodes/ImportNode.ts` - contract definition
- `packages/core/src/core/NodeFactory.ts` - factory implementation
- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - consumer
- `packages/core/src/core/nodes/index.ts` - exports
- `packages/types/src/nodes.ts` - type definitions (if needed)

## Step 1: Update ImportNode Contract

**File:** `/Users/vadimr/grafema/packages/core/src/core/nodes/ImportNode.ts`

**Changes:**

1. Add `ImportType` type and update field names:

```typescript
// BEFORE (line 7):
type ImportKind = 'value' | 'type' | 'typeof';

// AFTER:
type ImportBinding = 'value' | 'type' | 'typeof';
type ImportType = 'default' | 'named' | 'namespace';
```

2. Update `ImportNodeRecord` interface (lines 9-16):

```typescript
// BEFORE:
interface ImportNodeRecord extends BaseNodeRecord {
  type: 'IMPORT';
  column: number;
  source: string;
  importKind: ImportKind;
  imported: string;
  local: string;
}

// AFTER:
interface ImportNodeRecord extends BaseNodeRecord {
  type: 'IMPORT';
  column: number;
  source: string;
  importType: ImportType;      // NEW: HOW it's imported (syntax)
  importBinding: ImportBinding; // RENAMED: WHAT is imported (TypeScript semantics)
  imported: string;
  local: string;
}
```

3. Update `ImportNodeOptions` interface (lines 18-22):

```typescript
// BEFORE:
interface ImportNodeOptions {
  importKind?: ImportKind;
  imported?: string;
  local?: string;
}

// AFTER:
interface ImportNodeOptions {
  importType?: ImportType;
  importBinding?: ImportBinding;
  imported?: string;
  local?: string;
}
```

4. Update `ImportNode.OPTIONAL` (line 28):

```typescript
// BEFORE:
static readonly OPTIONAL = ['column', 'importKind', 'imported', 'local'] as const;

// AFTER:
static readonly OPTIONAL = ['column', 'importType', 'importBinding', 'imported', 'local'] as const;
```

5. Update `ImportNode.create()` method signature and body (lines 30-55):

```typescript
// BEFORE:
static create(
  name: string,
  file: string,
  line: number,
  column: number,
  source: string,
  options: ImportNodeOptions = {}
): ImportNodeRecord {
  if (!name) throw new Error('ImportNode.create: name is required');
  if (!file) throw new Error('ImportNode.create: file is required');
  if (!line) throw new Error('ImportNode.create: line is required');
  if (!source) throw new Error('ImportNode.create: source is required');

  return {
    id: `${file}:IMPORT:${name}:${line}`,
    type: this.TYPE,
    name,
    file,
    line,
    column: column || 0,
    source,
    importKind: options.importKind || 'value',
    imported: options.imported || name,
    local: options.local || name
  };
}

// AFTER:
static create(
  name: string,
  file: string,
  line: number,
  column: number,
  source: string,
  options: ImportNodeOptions = {}
): ImportNodeRecord {
  if (!name) throw new Error('ImportNode.create: name is required');
  if (!file) throw new Error('ImportNode.create: file is required');
  if (!line) throw new Error('ImportNode.create: line is required');
  if (!source) throw new Error('ImportNode.create: source is required');

  // Determine importType from imported field if not explicitly provided
  let importType = options.importType;
  if (!importType && options.imported) {
    importType = options.imported === 'default' ? 'default' :
                 options.imported === '*' ? 'namespace' : 'named';
  }

  return {
    id: `${file}:IMPORT:${name}:${line}`,
    type: this.TYPE,
    name,
    file,
    line,
    column: column || 0,
    source,
    importType: importType || 'named',      // NEW field with default
    importBinding: options.importBinding || 'value',  // RENAMED field
    imported: options.imported || name,
    local: options.local || name
  };
}
```

6. Update exports (line 75):

```typescript
// BEFORE:
export type { ImportNodeRecord, ImportKind };

// AFTER:
export type { ImportNodeRecord, ImportBinding, ImportType };
```

**Rationale:** This resolves the architectural mismatch by supporting both concepts as separate fields. `importType` captures the syntax (how it's imported), `importBinding` captures TypeScript semantics (what is imported).

## Step 2: Update NodeFactory

**File:** `/Users/vadimr/grafema/packages/core/src/core/NodeFactory.ts`

**Changes:**

1. Add ImportNode import (after line 23, before line 34):

```typescript
import {
  ServiceNode,
  EntrypointNode,
  ModuleNode,
  FunctionNode,
  ScopeNode,
  CallSiteNode,
  MethodCallNode,
  VariableDeclarationNode,
  ConstantNode,
  LiteralNode,
  ObjectLiteralNode,
  ArrayLiteralNode,
  ExternalStdioNode,
  EventListenerNode,
  HttpRequestNode,
  DatabaseQueryNode,
  ImportNode,  // ADD THIS
  type EntrypointType,
  type EntrypointTrigger,
} from './nodes/index.js';
```

2. Add `ImportOptions` interface (after line 141, before export class):

```typescript
interface ImportOptions {
  importType?: 'default' | 'named' | 'namespace';
  importBinding?: 'value' | 'type' | 'typeof';
  imported?: string;
  local?: string;
}
```

3. Add `createImport` method (after line 265, before validate method):

```typescript
/**
 * Create IMPORT node
 */
static createImport(
  name: string,
  file: string,
  line: number,
  column: number,
  source: string,
  options: ImportOptions = {}
) {
  return ImportNode.create(name, file, line, column, source, options);
}
```

4. Update validators map in `validate()` method (after line 287):

```typescript
const validators: Record<string, NodeValidator> = {
  'SERVICE': ServiceNode,
  'ENTRYPOINT': EntrypointNode,
  'MODULE': ModuleNode,
  'FUNCTION': FunctionNode,
  'SCOPE': ScopeNode,
  'CALL_SITE': CallSiteNode,
  'METHOD_CALL': MethodCallNode,
  'VARIABLE_DECLARATION': VariableDeclarationNode,
  'CONSTANT': ConstantNode,
  'LITERAL': LiteralNode,
  'OBJECT_LITERAL': ObjectLiteralNode,
  'ARRAY_LITERAL': ArrayLiteralNode,
  'EXTERNAL_STDIO': ExternalStdioNode,
  'EVENT_LISTENER': EventListenerNode,
  'HTTP_REQUEST': HttpRequestNode,
  'DATABASE_QUERY': DatabaseQueryNode,
  'IMPORT': ImportNode  // ADD THIS
};
```

**Rationale:** Follows the existing NodeFactory pattern - delegates to ImportNode.create() and adds validation support.

## Step 3: Migrate GraphBuilder

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Changes:**

1. Add NodeFactory import at the top (after line 5):

```typescript
import { dirname, resolve } from 'path';
import { NodeFactory } from '../../core/NodeFactory.js';  // ADD THIS
import type { GraphBackend } from '@grafema/types';
```

2. Replace `bufferImportNodes` method body (lines 501-550):

**BEFORE:**
```typescript
private bufferImportNodes(module: ModuleNode, imports: ImportInfo[]): void {
  for (const imp of imports) {
    const { source, specifiers, line } = imp;

    for (const spec of specifiers) {
      const importType = spec.imported === 'default' ? 'default' :
                        spec.imported === '*' ? 'namespace' : 'named';

      const importId = `${module.file}:IMPORT:${source}:${spec.local}:${line}`;

      this._bufferNode({
        id: importId,
        type: 'IMPORT',
        source: source,
        importType: importType,
        imported: spec.imported,
        local: spec.local,
        file: module.file,
        line: line
      });

      // MODULE -> CONTAINS -> IMPORT
      this._bufferEdge({
        type: 'CONTAINS',
        src: module.id,
        dst: importId
      });

      // Create EXTERNAL_MODULE node for external modules
      const isRelative = source.startsWith('./') || source.startsWith('../');
      if (!isRelative) {
        const externalModuleId = `EXTERNAL_MODULE:${source}`;

        this._bufferNode({
          id: externalModuleId,
          type: 'EXTERNAL_MODULE',
          name: source,
          file: module.file,
          line: line
        });

        this._bufferEdge({
          type: 'IMPORTS',
          src: module.id,
          dst: externalModuleId
        });
      }
    }
  }
}
```

**AFTER:**
```typescript
private bufferImportNodes(module: ModuleNode, imports: ImportInfo[]): void {
  for (const imp of imports) {
    const { source, specifiers, line } = imp;

    for (const spec of specifiers) {
      // Determine importType from imported field
      const importType = spec.imported === 'default' ? 'default' :
                        spec.imported === '*' ? 'namespace' : 'named';

      // Create IMPORT node via NodeFactory
      const importNode = NodeFactory.createImport(
        spec.local,        // name (local binding)
        module.file,       // file
        line,              // line
        0,                 // column (not available in ImportInfo)
        source,            // source
        {
          importType: importType,
          importBinding: 'value',  // Default to 'value' - TypeScript analyzer can override later
          imported: spec.imported,
          local: spec.local
        }
      );

      this._bufferNode(importNode as unknown as GraphNode);

      // MODULE -> CONTAINS -> IMPORT
      this._bufferEdge({
        type: 'CONTAINS',
        src: module.id,
        dst: importNode.id
      });

      // Create EXTERNAL_MODULE node for external modules
      const isRelative = source.startsWith('./') || source.startsWith('../');
      if (!isRelative) {
        const externalModuleId = `EXTERNAL_MODULE:${source}`;

        this._bufferNode({
          id: externalModuleId,
          type: 'EXTERNAL_MODULE',
          name: source,
          file: module.file,
          line: line
        });

        this._bufferEdge({
          type: 'IMPORTS',
          src: module.id,
          dst: externalModuleId
        });
      }
    }
  }
}
```

**Key Changes:**
- Replace inline object creation with `NodeFactory.createImport()`
- Use `spec.local` as the `name` parameter (matches ImportNode's ID format)
- Default `column` to `0` since ImportInfo doesn't have this field
- Default `importBinding` to `'value'` (TypeScript analyzer will set 'type'/'typeof' for `import type` statements)
- Cast to `GraphNode` for buffer compatibility

**Important:** GraphBuilder's ID format will now match ImportNode's format: `${file}:IMPORT:${name}:${line}` instead of the old `${file}:IMPORT:${source}:${local}:${line}`. This is a **breaking change** for any code that constructs IMPORT IDs manually.

## Step 4: Update Exports (if needed)

**File:** `/Users/vadimr/grafema/packages/core/src/core/nodes/index.ts`

Verify ImportNode types are exported. Current line 25:

```typescript
export { ImportNode, type ImportNodeRecord, type ImportKind } from './ImportNode.js';
```

Should become:

```typescript
export { ImportNode, type ImportNodeRecord, type ImportBinding, type ImportType } from './ImportNode.js';
```

## Test Plan

### Unit Tests

Create `/Users/vadimr/grafema/test/unit/NodeFactoryImport.test.js`:

```javascript
/**
 * NodeFactory.createImport() Tests
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NodeFactory } from '@grafema/core';

describe('NodeFactory.createImport', () => {
  it('should create default import node', () => {
    const node = NodeFactory.createImport(
      'React',
      '/project/src/App.js',
      1,
      0,
      'react',
      { importType: 'default', imported: 'default', local: 'React' }
    );

    assert.strictEqual(node.type, 'IMPORT');
    assert.strictEqual(node.name, 'React');
    assert.strictEqual(node.source, 'react');
    assert.strictEqual(node.importType, 'default');
    assert.strictEqual(node.importBinding, 'value');
    assert.strictEqual(node.imported, 'default');
    assert.strictEqual(node.local, 'React');
    assert.strictEqual(node.id, '/project/src/App.js:IMPORT:React:1');
  });

  it('should create named import node', () => {
    const node = NodeFactory.createImport(
      'useState',
      '/project/src/App.js',
      2,
      0,
      'react',
      { importType: 'named', imported: 'useState', local: 'useState' }
    );

    assert.strictEqual(node.importType, 'named');
    assert.strictEqual(node.importBinding, 'value');
    assert.strictEqual(node.imported, 'useState');
  });

  it('should create namespace import node', () => {
    const node = NodeFactory.createImport(
      'React',
      '/project/src/App.js',
      3,
      0,
      'react',
      { importType: 'namespace', imported: '*', local: 'React' }
    );

    assert.strictEqual(node.importType, 'namespace');
    assert.strictEqual(node.imported, '*');
  });

  it('should create type import node', () => {
    const node = NodeFactory.createImport(
      'User',
      '/project/src/types.ts',
      1,
      0,
      './user',
      { importType: 'named', importBinding: 'type', imported: 'User', local: 'User' }
    );

    assert.strictEqual(node.importType, 'named');
    assert.strictEqual(node.importBinding, 'type');
  });

  it('should create typeof import node', () => {
    const node = NodeFactory.createImport(
      'config',
      '/project/src/app.ts',
      1,
      0,
      './config',
      { importType: 'named', importBinding: 'typeof', imported: 'config', local: 'config' }
    );

    assert.strictEqual(node.importBinding, 'typeof');
  });

  it('should auto-detect importType from imported field', () => {
    const defaultNode = NodeFactory.createImport(
      'React',
      '/project/src/App.js',
      1,
      0,
      'react',
      { imported: 'default', local: 'React' }
    );
    assert.strictEqual(defaultNode.importType, 'default');

    const namespaceNode = NodeFactory.createImport(
      'fs',
      '/project/src/App.js',
      2,
      0,
      'fs',
      { imported: '*', local: 'fs' }
    );
    assert.strictEqual(namespaceNode.importType, 'namespace');

    const namedNode = NodeFactory.createImport(
      'useState',
      '/project/src/App.js',
      3,
      0,
      'react',
      { imported: 'useState', local: 'useState' }
    );
    assert.strictEqual(namedNode.importType, 'named');
  });

  it('should use defaults for optional fields', () => {
    const node = NodeFactory.createImport(
      'React',
      '/project/src/App.js',
      1,
      0,
      'react',
      {}
    );

    assert.strictEqual(node.importType, 'named'); // default
    assert.strictEqual(node.importBinding, 'value'); // default
    assert.strictEqual(node.imported, 'React'); // defaults to name
    assert.strictEqual(node.local, 'React'); // defaults to name
  });

  it('should validate required fields', () => {
    assert.throws(() => {
      NodeFactory.createImport('', '/file.js', 1, 0, 'react');
    }, /name is required/);

    assert.throws(() => {
      NodeFactory.createImport('React', '', 1, 0, 'react');
    }, /file is required/);

    assert.throws(() => {
      NodeFactory.createImport('React', '/file.js', 0, 0, 'react');
    }, /line is required/);

    assert.throws(() => {
      NodeFactory.createImport('React', '/file.js', 1, 0, '');
    }, /source is required/);
  });

  it('should pass validation', () => {
    const node = NodeFactory.createImport(
      'React',
      '/project/src/App.js',
      1,
      0,
      'react',
      { importType: 'default' }
    );

    const errors = NodeFactory.validate(node);
    assert.strictEqual(errors.length, 0);
  });
});
```

### Integration Tests

Update existing integration test (if any) or add to `/Users/vadimr/grafema/test/unit/GraphBuilderImport.test.js`:

```javascript
/**
 * GraphBuilder IMPORT node creation via NodeFactory
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Orchestrator } from '@grafema/core';
import { RFDBServerBackend } from '@grafema/core';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('GraphBuilder Import Nodes', () => {
  let testCounter = 0;

  async function setupTest(files) {
    const testDir = join(tmpdir(), `grafema-test-import-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: `test-import-${testCounter}`, type: 'module' })
    );

    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(testDir, filename), content);
    }

    const graph = new RFDBServerBackend();
    const orchestrator = new Orchestrator(graph);
    await orchestrator.discover(testDir);

    return { graph, testDir, orchestrator };
  }

  it('should create IMPORT nodes with correct fields via NodeFactory', async () => {
    const { graph, orchestrator } = await setupTest({
      'index.js': `
        import React from 'react';
        import { useState } from 'react';
        import * as fs from 'fs';
      `
    });

    try {
      const imports = [];
      for await (const node of graph.queryNodes({ type: 'IMPORT' })) {
        imports.push(node);
      }

      assert.strictEqual(imports.length, 3);

      // Default import
      const reactDefault = imports.find(i => i.imported === 'default');
      assert.ok(reactDefault);
      assert.strictEqual(reactDefault.importType, 'default');
      assert.strictEqual(reactDefault.importBinding, 'value');
      assert.strictEqual(reactDefault.local, 'React');
      assert.strictEqual(reactDefault.source, 'react');

      // Named import
      const useState = imports.find(i => i.imported === 'useState');
      assert.ok(useState);
      assert.strictEqual(useState.importType, 'named');
      assert.strictEqual(useState.importBinding, 'value');
      assert.strictEqual(useState.local, 'useState');

      // Namespace import
      const fsNamespace = imports.find(i => i.imported === '*');
      assert.ok(fsNamespace);
      assert.strictEqual(fsNamespace.importType, 'namespace');
      assert.strictEqual(fsNamespace.local, 'fs');

      // Verify ID format matches ImportNode contract
      const idPattern = /^.*:IMPORT:.*:\d+$/;
      imports.forEach(imp => {
        assert.match(imp.id, idPattern, `ID should match pattern: ${imp.id}`);
      });
    } finally {
      await orchestrator.close();
    }
  });

  it('should create MODULE -> CONTAINS -> IMPORT edges', async () => {
    const { graph, orchestrator } = await setupTest({
      'index.js': `import React from 'react';`
    });

    try {
      const modules = [];
      for await (const node of graph.queryNodes({ type: 'MODULE' })) {
        modules.push(node);
      }
      const moduleId = modules[0].id;

      const edges = [];
      for await (const edge of graph.queryEdges({ type: 'CONTAINS', src: moduleId })) {
        edges.push(edge);
      }

      const containsImport = edges.find(e => e.dst.includes(':IMPORT:'));
      assert.ok(containsImport, 'Should have MODULE -> CONTAINS -> IMPORT edge');
    } finally {
      await orchestrator.close();
    }
  });
});
```

### Test Execution Order

1. Run unit tests first: `node --test test/unit/NodeFactoryImport.test.js`
2. Run integration test: `node --test test/unit/GraphBuilderImport.test.js`
3. Run full test suite to verify no regressions: `npm test`

### Expected Test Results

- Unit tests: All 10 tests pass
- Integration tests: Both tests pass
- Full suite: No regressions (all existing tests continue to pass)

**Risk:** ID format change may break existing tests that check IMPORT node IDs. Search for hardcoded ID patterns before running full suite.

## Rollback Plan

If tests fail or regressions occur:

1. Revert changes in reverse order:
   - GraphBuilder.ts (Step 3)
   - NodeFactory.ts (Step 2)
   - ImportNode.ts (Step 1)

2. Restore from git:
```bash
git checkout HEAD -- packages/core/src/core/nodes/ImportNode.ts
git checkout HEAD -- packages/core/src/core/NodeFactory.ts
git checkout HEAD -- packages/core/src/plugins/analysis/ast/GraphBuilder.ts
```

3. Remove test file if created:
```bash
rm test/unit/NodeFactoryImport.test.js
```

## Breaking Changes

### ID Format Change

**Old format (GraphBuilder inline):**
```
${file}:IMPORT:${source}:${local}:${line}
// Example: /project/src/App.js:IMPORT:react:React:1
```

**New format (ImportNode contract):**
```
${file}:IMPORT:${name}:${line}
// Example: /project/src/App.js:IMPORT:React:1
```

**Impact:**
- Queries that construct IMPORT IDs manually will break
- Tests that check specific ID values will fail
- External code that relies on ID format will need updates

**Mitigation:**
1. Search codebase for IMPORT ID construction patterns before migration
2. Update all hardcoded ID patterns
3. Document new ID format in CHANGELOG.md
4. Add ID format test to prevent future drift

### Field Rename

**Old field:** `importKind: 'value' | 'type' | 'typeof'`
**New field:** `importBinding: 'value' | 'type' | 'typeof'`

**Impact:**
- Queries that check `.importKind` will fail
- Serialized data with old field name won't match schema

**Mitigation:**
1. Search codebase for `importKind` references: `grep -r "importKind" packages/`
2. Update all references to `importBinding`
3. If serialized data exists, add migration script

## Post-Migration Verification

After migration, verify:

1. All IMPORT nodes have both `importType` and `importBinding` fields
2. No IMPORT nodes have old `importKind` field
3. All IMPORT node IDs follow new format (no `source` in ID)
4. GraphBuilder produces valid ImportNode records that pass validation

**Verification queries:**

```javascript
// Check field presence
for await (const node of graph.queryNodes({ type: 'IMPORT' })) {
  assert.ok(node.importType, 'importType is present');
  assert.ok(node.importBinding, 'importBinding is present');
  assert.strictEqual(node.importKind, undefined, 'old importKind should not exist');
}

// Check ID format
for await (const node of graph.queryNodes({ type: 'IMPORT' })) {
  const parts = node.id.split(':');
  assert.strictEqual(parts[1], 'IMPORT');
  assert.strictEqual(parts.length, 4); // file:IMPORT:name:line
}
```

## Timeline Estimate

- Step 1 (ImportNode): 15 minutes
- Step 2 (NodeFactory): 10 minutes
- Step 3 (GraphBuilder): 20 minutes
- Step 4 (Exports): 5 minutes
- Unit tests: 30 minutes
- Integration tests: 20 minutes
- Full test suite run: 5 minutes
- Verification: 10 minutes

**Total: ~2 hours**

## Success Criteria

✅ NodeFactory has `createImport` method
✅ GraphBuilder uses `NodeFactory.createImport()` instead of inline literals
✅ All new unit tests pass
✅ All existing tests pass
✅ ImportNode added to NodeFactory validator
✅ Both `importType` and `importBinding` fields present in IMPORT nodes
✅ No references to old `importKind` field in codebase
✅ ID format consistent across all IMPORT nodes

## Notes

- Column information is not available in current `ImportInfo` data structure. Defaulting to `0` for now. If precise column is needed, this requires changes to JSASTAnalyzer (separate issue).
- TypeScript analyzer should eventually set `importBinding: 'type'` for `import type` statements and `importBinding: 'typeof'` for `import typeof` statements. Current implementation defaults to `'value'`.
- This migration is part of REG-98. After completion, check REG-98 for next subtask.
