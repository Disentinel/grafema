# Joel Spolsky - Revised Technical Plan

## Summary

This revised plan addresses Linus's concerns and user decisions:
1. **No type casts** - Fix GraphNode type definition to include new fields
2. **Semantic ID format** - Remove line number from ID to prevent drift
3. **Auto-detection in ONE place** - Move `importType` inference to ImportNode.create()

## User Decisions Applied

### Decision 1: No Type Casts
- Fix GraphNode interface in `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts`
- Add `importType` and `importBinding` fields to GraphNode
- Remove `as unknown as` cast from GraphBuilder

### Decision 2: Semantic ID Format
**Current problem:** Line numbers cause ID drift when code changes.

```javascript
// Before: adding empty line changes ID
import React from 'react';  // ID: file:IMPORT:react:React:1

// After adding empty line above:
                             // (empty line)
import React from 'react';  // ID: file:IMPORT:react:React:2  ← DIFFERENT ID!
```

**Solution:** Use semantic ID without line number:

```
OLD: ${file}:IMPORT:${source}:${local}:${line}
NEW: ${file}:IMPORT:${source}:${local}
```

**Why this works:**
- `file` - which file contains the import
- `source` - where it's imported from (e.g., 'react', './utils')
- `local` - local binding name (e.g., 'React', 'useState')

This creates unique ID for each import statement. Line/column stored as fields for debugging.

**Edge case check:**
```javascript
// Can we have duplicate IDs?
import React from 'react';           // file:IMPORT:react:React ✓
import { useState } from 'react';    // file:IMPORT:react:useState ✓
import * as fs from 'fs';            // file:IMPORT:fs:fs ✓

// Same binding from different sources:
import React from 'react';           // file:IMPORT:react:React ✓
import React from 'preact/compat';   // file:IMPORT:preact/compat:React ✓

// Re-exporting same binding (rare but legal):
export { foo } from 'lib-a';         // Not an IMPORT node - this is EXPORT
import { foo } from 'lib-a';         // file:IMPORT:lib-a:foo ✓
import { foo as foo2 } from 'lib-b'; // file:IMPORT:lib-b:foo2 ✓ (different local)
```

**Conclusion:** Semantic ID format works. No collisions possible.

### Decision 3: Auto-Detection in ImportNode.create()
GraphBuilder should NOT compute `importType`. ImportNode.create() infers it from `imported` field.

```typescript
// GraphBuilder just passes raw data:
NodeFactory.createImport(
  spec.local,
  module.file,
  line,
  0,
  source,
  {
    imported: spec.imported,  // 'default', '*', or 'useState'
    local: spec.local
  }
);

// ImportNode.create() infers importType:
const importType = options.imported === 'default' ? 'default' :
                   options.imported === '*' ? 'namespace' : 'named';
```

## Step-by-Step Implementation

### Step 1: Update GraphNode Type Definition

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts`

**Change:** Update GraphNode interface (lines 474-483) to include new IMPORT fields:

```typescript
// BEFORE:
export interface GraphNode {
  id: string;
  type: string;
  name?: string;
  file?: string;
  line?: number;
  column?: number;
  [key: string]: unknown;
}

// AFTER:
export interface GraphNode {
  id: string;
  type: string;
  name?: string;
  file?: string;
  line?: number;
  column?: number;
  // IMPORT node fields
  source?: string;
  importType?: 'default' | 'named' | 'namespace';
  importBinding?: 'value' | 'type' | 'typeof';
  imported?: string;
  local?: string;
  [key: string]: unknown;
}
```

**Rationale:** Adding these fields to GraphNode allows ImportNodeRecord to be used directly without type casts. All fields are optional since GraphNode is a union of all node types.

### Step 2: Update ImportNode Contract

**File:** `/Users/vadimr/grafema/packages/core/src/core/nodes/ImportNode.ts`

#### 2.1: Update type definitions (lines 7-16)

```typescript
// BEFORE:
type ImportKind = 'value' | 'type' | 'typeof';

interface ImportNodeRecord extends BaseNodeRecord {
  type: 'IMPORT';
  column: number;
  source: string;
  importKind: ImportKind;
  imported: string;
  local: string;
}

// AFTER:
type ImportBinding = 'value' | 'type' | 'typeof';
type ImportType = 'default' | 'named' | 'namespace';

interface ImportNodeRecord extends BaseNodeRecord {
  type: 'IMPORT';
  column: number;
  source: string;
  importType: ImportType;      // NEW: HOW it's imported (syntax)
  importBinding: ImportBinding; // RENAMED: WHAT is imported (semantics)
  imported: string;
  local: string;
}
```

#### 2.2: Update options interface (lines 18-22)

```typescript
// BEFORE:
interface ImportNodeOptions {
  importKind?: ImportKind;
  imported?: string;
  local?: string;
}

// AFTER:
interface ImportNodeOptions {
  importType?: ImportType;      // Optional - will be auto-detected if not provided
  importBinding?: ImportBinding;
  imported?: string;            // Used for auto-detection if importType not provided
  local?: string;
}
```

#### 2.3: Update OPTIONAL array (line 28)

```typescript
// BEFORE:
static readonly OPTIONAL = ['column', 'importKind', 'imported', 'local'] as const;

// AFTER:
static readonly OPTIONAL = ['column', 'importType', 'importBinding', 'imported', 'local'] as const;
```

#### 2.4: Update create() method (lines 30-55)

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
/**
 * Create IMPORT node
 *
 * @param name - The local binding name (what the import is called in this module)
 * @param file - Absolute file path
 * @param line - Line number (for debugging only, not part of ID)
 * @param column - Column position (pass 0 if unavailable - JSASTAnalyzer limitation)
 * @param source - Module source (e.g., 'react', './utils')
 * @param options - Optional fields
 * @returns ImportNodeRecord
 */
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

  // Auto-detect importType from imported field if not explicitly provided
  let importType = options.importType;
  if (!importType && options.imported) {
    importType = options.imported === 'default' ? 'default' :
                 options.imported === '*' ? 'namespace' : 'named';
  }

  return {
    id: `${file}:IMPORT:${source}:${name}`,  // ← SEMANTIC ID: no line number
    type: this.TYPE,
    name,
    file,
    line,      // ← Stored as field, not in ID
    column: column || 0,
    source,
    importType: importType || 'named',           // NEW field with auto-detection
    importBinding: options.importBinding || 'value',  // RENAMED field
    imported: options.imported || name,
    local: options.local || name
  };
}
```

**Key Changes:**
1. **Semantic ID:** `${file}:IMPORT:${source}:${name}` (no line)
2. **Auto-detection:** `importType` inferred from `imported` if not provided
3. **Documentation:** JSDoc explains `name`, `column` limitations
4. **Field rename:** `importKind` → `importBinding`

#### 2.5: Update exports (line 75)

```typescript
// BEFORE:
export type { ImportNodeRecord, ImportKind };

// AFTER:
export type { ImportNodeRecord, ImportBinding, ImportType };
```

### Step 3: Update NodeFactory

**File:** `/Users/vadimr/grafema/packages/core/src/core/NodeFactory.ts`

#### 3.1: Add ImportNode import (after line 23)

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

#### 3.2: Add ImportOptions interface (after line 141)

```typescript
interface ImportOptions {
  importType?: 'default' | 'named' | 'namespace';
  importBinding?: 'value' | 'type' | 'typeof';
  imported?: string;
  local?: string;
}
```

#### 3.3: Add createImport method (after line 265)

```typescript
/**
 * Create IMPORT node
 *
 * ImportNode automatically detects importType from imported field:
 * - imported === 'default' → importType: 'default'
 * - imported === '*' → importType: 'namespace'
 * - anything else → importType: 'named'
 *
 * @param name - Local binding name (how it's used in this file)
 * @param file - Absolute file path
 * @param line - Line number (for debugging, not part of ID)
 * @param column - Column position (0 if unavailable)
 * @param source - Source module (e.g., 'react', './utils')
 * @param options - Optional fields
 * @returns ImportNodeRecord
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

#### 3.4: Update validators map in validate() method (after line 287)

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

### Step 4: Update GraphBuilder

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

#### 4.1: Add NodeFactory import (after line 5)

```typescript
import { dirname, resolve } from 'path';
import { NodeFactory } from '../../core/NodeFactory.js';  // ADD THIS
import type { GraphBackend } from '@grafema/types';
```

#### 4.2: Replace bufferImportNodes method (lines 501-550)

```typescript
// BEFORE:
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

// AFTER:
private bufferImportNodes(module: ModuleNode, imports: ImportInfo[]): void {
  for (const imp of imports) {
    const { source, specifiers, line } = imp;

    for (const spec of specifiers) {
      // Create IMPORT node via NodeFactory
      // ImportNode.create() will auto-detect importType from imported field
      const importNode = NodeFactory.createImport(
        spec.local,        // name (local binding)
        module.file,       // file
        line,              // line (not in ID, stored as field)
        0,                 // column (not available in ImportInfo)
        source,            // source
        {
          imported: spec.imported,  // ImportNode will infer importType from this
          local: spec.local,
          importBinding: 'value'    // Default - TypeScript analyzer will override for 'import type'
        }
      );

      // No cast needed - GraphNode now includes IMPORT fields
      this._bufferNode(importNode);

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
1. **Removed importType computation** - ImportNode.create() handles it
2. **Removed cast** - GraphNode now compatible with ImportNodeRecord
3. **Pass raw data** - GraphBuilder doesn't interpret, just passes to factory

### Step 5: Update Exports

**File:** `/Users/vadimr/grafema/packages/core/src/core/nodes/index.ts`

```typescript
// BEFORE (line 25):
export { ImportNode, type ImportNodeRecord, type ImportKind } from './ImportNode.js';

// AFTER:
export { ImportNode, type ImportNodeRecord, type ImportBinding, type ImportType } from './ImportNode.js';
```

## Test Plan

### Unit Tests

**File:** `/Users/vadimr/grafema/test/unit/NodeFactoryImport.test.js`

```javascript
/**
 * NodeFactory.createImport() Tests
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NodeFactory } from '@grafema/core';

describe('NodeFactory.createImport', () => {
  it('should create default import with semantic ID', () => {
    const node = NodeFactory.createImport(
      'React',
      '/project/src/App.js',
      1,
      0,
      'react',
      { imported: 'default', local: 'React' }
    );

    assert.strictEqual(node.type, 'IMPORT');
    assert.strictEqual(node.name, 'React');
    assert.strictEqual(node.source, 'react');
    assert.strictEqual(node.importType, 'default');
    assert.strictEqual(node.importBinding, 'value');
    assert.strictEqual(node.imported, 'default');
    assert.strictEqual(node.local, 'React');
    // SEMANTIC ID: no line number
    assert.strictEqual(node.id, '/project/src/App.js:IMPORT:react:React');
    // Line stored as field
    assert.strictEqual(node.line, 1);
  });

  it('should create named import with semantic ID', () => {
    const node = NodeFactory.createImport(
      'useState',
      '/project/src/App.js',
      2,
      0,
      'react',
      { imported: 'useState', local: 'useState' }
    );

    assert.strictEqual(node.importType, 'named');
    assert.strictEqual(node.id, '/project/src/App.js:IMPORT:react:useState');
  });

  it('should create namespace import with semantic ID', () => {
    const node = NodeFactory.createImport(
      'fs',
      '/project/src/App.js',
      3,
      0,
      'fs',
      { imported: '*', local: 'fs' }
    );

    assert.strictEqual(node.importType, 'namespace');
    assert.strictEqual(node.imported, '*');
    assert.strictEqual(node.id, '/project/src/App.js:IMPORT:fs:fs');
  });

  it('should auto-detect importType from imported field', () => {
    // Default
    const defaultNode = NodeFactory.createImport(
      'React',
      '/project/src/App.js',
      1,
      0,
      'react',
      { imported: 'default' }
    );
    assert.strictEqual(defaultNode.importType, 'default');

    // Namespace
    const nsNode = NodeFactory.createImport(
      'fs',
      '/project/src/App.js',
      2,
      0,
      'fs',
      { imported: '*' }
    );
    assert.strictEqual(nsNode.importType, 'namespace');

    // Named
    const namedNode = NodeFactory.createImport(
      'useState',
      '/project/src/App.js',
      3,
      0,
      'react',
      { imported: 'useState' }
    );
    assert.strictEqual(namedNode.importType, 'named');
  });

  it('should create stable IDs (same binding, different lines)', () => {
    const node1 = NodeFactory.createImport(
      'React',
      '/project/src/App.js',
      1,
      0,
      'react',
      { imported: 'default' }
    );

    // Add empty line, import moves to line 2
    const node2 = NodeFactory.createImport(
      'React',
      '/project/src/App.js',
      2,  // ← Different line
      0,
      'react',
      { imported: 'default' }
    );

    // IDs should be SAME - semantic identity
    assert.strictEqual(node1.id, node2.id);
    assert.strictEqual(node1.id, '/project/src/App.js:IMPORT:react:React');

    // But line fields are different
    assert.strictEqual(node1.line, 1);
    assert.strictEqual(node2.line, 2);
  });

  it('should handle same binding from different sources', () => {
    const reactNode = NodeFactory.createImport(
      'React',
      '/project/src/App.js',
      1,
      0,
      'react',
      { imported: 'default' }
    );

    const preactNode = NodeFactory.createImport(
      'React',
      '/project/src/App.js',
      2,
      0,
      'preact/compat',
      { imported: 'default' }
    );

    // Different sources → different IDs
    assert.notStrictEqual(reactNode.id, preactNode.id);
    assert.strictEqual(reactNode.id, '/project/src/App.js:IMPORT:react:React');
    assert.strictEqual(preactNode.id, '/project/src/App.js:IMPORT:preact/compat:React');
  });

  it('should create type import node', () => {
    const node = NodeFactory.createImport(
      'User',
      '/project/src/types.ts',
      1,
      0,
      './user',
      { imported: 'User', importBinding: 'type' }
    );

    assert.strictEqual(node.importType, 'named');
    assert.strictEqual(node.importBinding, 'type');
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
      { imported: 'default' }
    );

    const errors = NodeFactory.validate(node);
    assert.strictEqual(errors.length, 0);
  });
});
```

### Integration Tests

**File:** `/Users/vadimr/grafema/test/unit/GraphBuilderImport.test.js`

```javascript
/**
 * GraphBuilder IMPORT node creation via NodeFactory
 */
import { describe, it } from 'node:test';
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

  it('should create IMPORT nodes with semantic IDs', async () => {
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

      // Check semantic ID format (no line numbers)
      const idPattern = /^.*:IMPORT:.*:.*$/;  // file:IMPORT:source:local
      imports.forEach(imp => {
        assert.match(imp.id, idPattern, `ID should match semantic pattern: ${imp.id}`);
        // Verify no line number in ID by checking parts
        const parts = imp.id.split(':');
        assert.strictEqual(parts[1], 'IMPORT');
        assert.strictEqual(parts.length, 4); // file, IMPORT, source, local
      });

      // Verify fields
      const reactDefault = imports.find(i => i.imported === 'default');
      assert.ok(reactDefault);
      assert.strictEqual(reactDefault.importType, 'default');
      assert.strictEqual(reactDefault.importBinding, 'value');
      assert.strictEqual(reactDefault.local, 'React');
      assert.strictEqual(reactDefault.source, 'react');
      assert.ok(reactDefault.line, 'Line should be stored as field');

      const useState = imports.find(i => i.imported === 'useState');
      assert.ok(useState);
      assert.strictEqual(useState.importType, 'named');

      const fsNamespace = imports.find(i => i.imported === '*');
      assert.ok(fsNamespace);
      assert.strictEqual(fsNamespace.importType, 'namespace');
    } finally {
      await orchestrator.close();
    }
  });

  it('should create stable IDs across code changes', async () => {
    // First analysis
    const { graph: graph1, orchestrator: orchestrator1 } = await setupTest({
      'index.js': `import React from 'react';`
    });

    let id1;
    try {
      for await (const node of graph1.queryNodes({ type: 'IMPORT' })) {
        id1 = node.id;
      }
    } finally {
      await orchestrator1.close();
    }

    // Second analysis - added empty line
    const { graph: graph2, orchestrator: orchestrator2 } = await setupTest({
      'index.js': `
import React from 'react';`  // ← Empty line added above
    });

    let id2;
    try {
      for await (const node of graph2.queryNodes({ type: 'IMPORT' })) {
        id2 = node.id;
      }
    } finally {
      await orchestrator2.close();
    }

    // IDs should be same despite line number change
    assert.strictEqual(id1, id2, 'Semantic IDs should not change when line numbers change');
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

1. **Unit tests first:** `node --test test/unit/NodeFactoryImport.test.js`
2. **Integration test:** `node --test test/unit/GraphBuilderImport.test.js`
3. **Full suite:** `npm test` (verify no regressions)

## Breaking Changes

### 1. ID Format Change

**OLD FORMAT:**
```
${file}:IMPORT:${source}:${local}:${line}
/project/src/App.js:IMPORT:react:React:1
```

**NEW FORMAT:**
```
${file}:IMPORT:${source}:${local}
/project/src/App.js:IMPORT:react:React
```

**Impact:**
- Queries that construct IMPORT IDs manually will break
- Tests with hardcoded ID patterns will fail
- Existing graph data has old IDs

**Migration Strategy:**
1. Search for hardcoded ID patterns: `grep -r "IMPORT:.*:.*:.*:" packages/`
2. Update tests before running full suite
3. **No automatic migration** - new IDs only apply to new analysis
4. Old graph data remains valid but IDs won't match new format

### 2. Field Rename

**OLD:** `importKind: 'value' | 'type' | 'typeof'`
**NEW:** `importBinding: 'value' | 'type' | 'typeof'`

**Impact:**
- Queries checking `.importKind` will fail
- Serialized data with old field won't match

**Migration Strategy:**
1. Search: `grep -r "importKind" packages/`
2. Update all references to `importBinding`

### 3. New Field Added

**NEW:** `importType: 'default' | 'named' | 'namespace'`

**Impact:**
- Old IMPORT nodes don't have this field
- Queries filtering by `importType` won't find old nodes

**Migration Strategy:**
- New field only in new analyses
- Old data remains queryable by other fields

## Rollback Plan

If tests fail:

```bash
# Revert in reverse order
git checkout HEAD -- packages/core/src/plugins/analysis/ast/GraphBuilder.ts
git checkout HEAD -- packages/core/src/core/NodeFactory.ts
git checkout HEAD -- packages/core/src/core/nodes/ImportNode.ts
git checkout HEAD -- packages/core/src/plugins/analysis/ast/types.ts
git checkout HEAD -- packages/core/src/core/nodes/index.ts

# Remove test file
rm test/unit/NodeFactoryImport.test.js
rm test/unit/GraphBuilderImport.test.js
```

## Post-Migration Verification

```javascript
// Verify all IMPORT nodes have new fields
for await (const node of graph.queryNodes({ type: 'IMPORT' })) {
  assert.ok(node.importType, 'importType is present');
  assert.ok(node.importBinding, 'importBinding is present');
  assert.strictEqual(node.importKind, undefined, 'old importKind removed');

  // Verify semantic ID format (no line number at end)
  const parts = node.id.split(':');
  assert.strictEqual(parts[1], 'IMPORT');
  assert.strictEqual(parts.length, 4); // file:IMPORT:source:local
}
```

## Timeline Estimate

- Step 1 (GraphNode type): 5 minutes
- Step 2 (ImportNode): 20 minutes
- Step 3 (NodeFactory): 10 minutes
- Step 4 (GraphBuilder): 15 minutes
- Step 5 (Exports): 5 minutes
- Unit tests: 30 minutes
- Integration tests: 20 minutes
- Full test suite: 5 minutes
- Verification: 10 minutes

**Total: ~2 hours**

## Success Criteria

✅ No type casts in production code
✅ Semantic IDs don't include line numbers
✅ Adding empty lines doesn't change IMPORT node IDs
✅ Auto-detection logic only in ImportNode.create()
✅ GraphBuilder just passes raw data to factory
✅ All unit tests pass
✅ All integration tests pass
✅ No regressions in existing tests
✅ GraphNode type includes IMPORT fields

## Architectural Notes

### Why Semantic IDs Are Better

**Problem with positional IDs:**
```javascript
// Version 1:
import React from 'react';  // Line 1, ID: file:IMPORT:react:React:1

// Version 2 (added comment):
// This is React
import React from 'react';  // Line 2, ID: file:IMPORT:react:React:2
```

Graph sees this as: "React import was deleted on line 1 and new one added on line 2"

**Solution with semantic IDs:**
```javascript
// Both versions:
import React from 'react';  // ID: file:IMPORT:react:React
```

Graph sees this as: "Same React import, line field updated from 1 to 2"

### Identity vs Location

- **Identity** = what the node represents (file + source + binding)
- **Location** = where it is in code (line + column)

**ID should capture identity, not location.** Location stored as fields for debugging.

### Why This Works

An IMPORT node represents: "In THIS file, we import THIS binding from THIS source"

- Same file + same source + same binding = same import (even if line changes)
- Different source = different import (even if same binding name)
- Different local binding = different import (aliasing)

## Questions Answered

### Q: Can we have ID collisions without line numbers?

**A:** No. The combination of `file:source:local` is always unique:
- Same file, same source, different locals → different IDs (e.g., `import {a, b}`)
- Same file, different sources, same local → different IDs (source differs)
- Same source, same local, different files → different IDs (file differs)

### Q: What if we import the same binding twice from the same source?

```javascript
import React from 'react';
import React from 'react';  // Syntax error!
```

**A:** JavaScript doesn't allow this. Parser will fail before we create nodes.

### Q: What about dynamic imports?

```javascript
const React = await import('react');
```

**A:** Dynamic imports aren't IMPORT nodes - they're CALL nodes. Different type entirely.

## Next Steps

After implementation:
1. Run all tests
2. Verify no `importKind` references remain
3. Verify no hardcoded ID patterns remain
4. Update CHANGELOG.md with breaking changes
5. Mark task complete in Linear
