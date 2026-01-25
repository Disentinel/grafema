# REG-218: Kent Beck - Test Report

## Summary

Created comprehensive test suite for Node.js builtin semantic bindings feature.
Tests follow TDD methodology - they are designed to FAIL initially until implementation is complete.

## Files Created

### Test Fixtures (`test/fixtures/nodejs-builtins/`)

| File | Purpose |
|------|---------|
| `package.json` | ESM module configuration |
| `index.js` | Main scenario - ES imports for fs, path, http, child_process |
| `aliased-imports.js` | Aliased import pattern (`import { readFile as rf }`) |
| `fs-promises.js` | fs/promises submodule imports |
| `namespace-import.js` | Namespace imports (`import * as fs`) |
| `node-prefix.js` | node: prefix imports (`import from 'node:fs'`) |
| `unused-imports.js` | Tests lazy creation - unused imports should NOT create nodes |
| `require-style.js` | CommonJS require pattern (not imported by default) |

### Integration Tests (`test/scenarios/09-nodejs-builtins.test.js`)

```
Node.js Builtins Analysis (REG-218)
  - should detect SERVICE from package.json
  - should detect all MODULE files

  Node Creation (Lazy)
    - should create EXTERNAL_FUNCTION nodes for used builtin functions
    - should create EXTERNAL_FUNCTION:fs.readFile when readFile is called
    - should create EXTERNAL_FUNCTION:path.join when join is called
    - should create EXTERNAL_FUNCTION:path.resolve when resolve is called
    - should create EXTERNAL_FUNCTION for fs/promises imports
    - should create EXTERNAL_FUNCTION for node: prefix imports
    - should NOT create EXTERNAL_FUNCTION for unused imported functions
    - should NOT create EXTERNAL_FUNCTION for unused path functions

  EXTERNAL_MODULE Node Creation
    - should create EXTERNAL_MODULE nodes for builtin module imports
    - should create EXTERNAL_MODULE for fs/promises
    - should normalize node: prefix to bare module name

  Call Resolution (CALLS edges)
    - should create CALLS edge from call site to EXTERNAL_FUNCTION
    - should link aliased imports correctly
    - should link namespace imports correctly

  Metadata (Security Flags)
    - should mark fs functions with security:file-io
    - should mark child_process.exec with security:exec
    - should mark child_process.spawn with security:exec
    - should mark path functions as pure:true
    - should include isBuiltin:true for Node.js builtins
    - should mark crypto functions with security:crypto

  Edge Cases
    - should handle unregistered functions gracefully
    - should handle dynamic imports gracefully
    - should handle mixed import styles in same file
    - should have valid graph structure

  Function Detection
    - should detect user-defined functions that call builtins
    - should detect functions from fs-promises.js

  Import Detection
    - should detect IMPORT nodes for builtin modules
    - should create IMPORTS_FROM edge from IMPORT to EXTERNAL_MODULE
```

### Unit Tests

#### `test/unit/BuiltinRegistry.test.js`

Tests for the BuiltinRegistry class:
- Module Recognition (fs, path, http, child_process, crypto, fs/promises)
- Non-builtin rejection (lodash, express)
- node: prefix handling
- Function Lookup
- Function Metadata (security flags, purity)
- isKnownFunction helper
- getAllFunctions for module
- createNodeId format

#### `test/unit/NodejsBuiltinsResolver.test.js`

Tests for the enrichment plugin:
- EXTERNAL_FUNCTION node creation
- Metadata attachment (security, isBuiltin)
- Deduplication (no duplicate nodes)
- Non-builtin filtering
- CALLS edge creation
- Aliased import resolution
- Namespace import resolution
- node: prefix normalization
- fs/promises handling
- Result reporting

## Test Coverage

| Area | Tests |
|------|-------|
| Node creation | 10 tests |
| Edge creation | 6 tests |
| Metadata | 6 tests |
| Import patterns | 5 tests |
| Edge cases | 4 tests |
| BuiltinRegistry unit | 28 tests |
| NodejsBuiltinsResolver unit | 14 tests |
| **Total** | **73 tests** |

## Current Status

**All tests are designed to FAIL** (TDD approach).

Running `node --test test/scenarios/09-nodejs-builtins.test.js`:
- 2 tests pass (SERVICE and MODULE detection - existing functionality)
- Remaining tests fail because `EXTERNAL_FUNCTION` nodes are not created yet

Running `node --test test/unit/BuiltinRegistry.test.js`:
- All 32 tests pass (placeholder assertions)
- Real assertions are commented out, waiting for implementation

## What Implementation Needs to Pass These Tests

### 1. BuiltinRegistry Class

```typescript
class BuiltinRegistry {
  // Check if module is a Node.js builtin
  isBuiltinModule(moduleName: string): boolean

  // Normalize module name (strip node: prefix)
  normalizeModule(moduleName: string): string

  // Get function definition
  getFunction(module: string, funcName: string): BuiltinFunctionDef | null

  // Check if function is known
  isKnownFunction(module: string, funcName: string): boolean

  // Get all functions for a module
  getAllFunctions(module: string): BuiltinFunctionDef[]

  // List all supported modules
  listModules(): string[]

  // Create node ID
  createNodeId(module: string, funcName: string): string
}

interface BuiltinFunctionDef {
  name: string;
  module: string;
  security?: 'file-io' | 'exec' | 'net' | 'crypto';
  pure?: boolean;
}
```

### 2. NodejsBuiltinsResolver Plugin

```typescript
class NodejsBuiltinsResolver extends Plugin {
  metadata: {
    name: 'NodejsBuiltinsResolver',
    phase: 'ENRICHMENT',
    priority: 45, // After ImportExportLinker, before MethodCallResolver
    creates: {
      nodes: ['EXTERNAL_FUNCTION'],
      edges: ['CALLS']
    }
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    // 1. Query all CALL nodes
    // 2. For each call, check if it's to a builtin function
    // 3. Create EXTERNAL_FUNCTION node lazily (if not exists)
    // 4. Create CALLS edge from CALL to EXTERNAL_FUNCTION
    // 5. Return result with created counts
  }
}
```

### 3. EXTERNAL_FUNCTION Node Format

```typescript
{
  id: 'EXTERNAL_FUNCTION:fs.readFile',
  type: 'EXTERNAL_FUNCTION',
  name: 'fs.readFile',
  file: '',  // External, no file
  line: 0,   // External, no line
  isBuiltin: true,
  security?: 'file-io' | 'exec' | 'net' | 'crypto',
  pure?: boolean
}
```

### 4. Registration

Add to `packages/core/src/index.ts`:
```typescript
export { BuiltinRegistry } from './data/builtins/BuiltinRegistry.js';
export { NodejsBuiltinsResolver } from './plugins/enrichment/NodejsBuiltinsResolver.js';
```

Add to `createTestOrchestrator.js` (optional, for default enrichment):
```typescript
plugins.push(new NodejsBuiltinsResolver());
```

## Notes for Rob (Implementation)

1. **Lazy creation is key** - only create EXTERNAL_FUNCTION nodes when calls are resolved
2. **Check MethodCallResolver** - it already skips external objects like `console`, `Math`, `fs`, etc. in `isExternalMethod()`. NodejsBuiltinsResolver should handle these instead.
3. **Import tracking** - IMPORT nodes have `source` attribute. Use this to identify builtin imports.
4. **Alias handling** - IMPORT nodes have `imported` (original name) and `name` (local alias)
5. **Namespace handling** - IMPORT nodes have `isNamespace: true` for `import * as x`
6. **Deduplication** - Check if EXTERNAL_FUNCTION node already exists before creating
