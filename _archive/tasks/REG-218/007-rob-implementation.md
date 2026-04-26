# REG-218 Implementation Report

## Summary

Implemented Node.js builtin semantic bindings for Grafema. The implementation creates `EXTERNAL_FUNCTION` nodes for Node.js builtin function calls and links them with `CALLS` edges from the call sites.

## Implemented Components

### 1. BuiltinRegistry (`packages/core/src/data/builtins/`)

**Files created:**
- `types.ts` - Type definitions for builtin functions and modules
- `definitions.ts` - Tier 1 and Tier 2 Node.js builtin definitions
- `BuiltinRegistry.ts` - Registry class for builtin lookup
- `index.ts` - Exports

**Tier 1 Modules (fully defined):**
- `fs` - Filesystem operations (36 functions)
- `fs/promises` - Async filesystem operations (16 functions)
- `path` - Path manipulation (12 functions, marked `pure:true`)
- `http` / `https` - HTTP server/client (3 functions each)
- `crypto` - Cryptographic operations (17 functions)
- `child_process` - Process execution (7 functions, marked `security:exec`)

**Tier 2 Modules:**
- `url`, `util`, `os`, `events`, `stream`, `buffer`, `worker_threads`

**Metadata:**
- `security` - Categories: `file-io`, `exec`, `net`, `crypto`
- `pure` - Boolean flag for pure functions (e.g., path.*)

### 2. NodejsBuiltinsResolver (`packages/core/src/plugins/enrichment/`)

**Plugin metadata:**
- Phase: ENRICHMENT
- Priority: 45 (after ImportExportLinker, before MethodCallResolver)
- Creates: `EXTERNAL_FUNCTION`, `EXTERNAL_MODULE` nodes
- Creates: `CALLS`, `IMPORTS_FROM` edges

**Algorithm:**
1. Build import index (local name -> module source mapping)
2. Create `EXTERNAL_MODULE` nodes for builtin imports
3. Create `IMPORTS_FROM` edges from `IMPORT` to `EXTERNAL_MODULE`
4. Process all `CALL` nodes:
   - Resolve module and function name
   - Create `EXTERNAL_FUNCTION` node (if not exists)
   - Create `CALLS` edge to `EXTERNAL_FUNCTION`

**Resolution handles:**
- Named imports: `import { readFile } from 'fs'`
- Aliased imports: `import { readFile as rf } from 'fs'`
- Namespace imports: `import * as fs from 'fs'`
- node: prefix: `import { readFile } from 'node:fs'`
- Submodules: `import { readFile } from 'fs/promises'`

### 3. ExternalModuleNode Update

Modified `ExternalModuleNode.create()` to normalize `node:` prefix:
- `node:fs` -> `fs`
- `node:path` -> `path`

This ensures consistent IDs regardless of import style.

### 4. Test Orchestrator Integration

Added `NodejsBuiltinsResolver` to the test orchestrator so it runs in test scenarios.

## Node ID Format

```
EXTERNAL_FUNCTION:fs.readFile
EXTERNAL_FUNCTION:path.join
EXTERNAL_FUNCTION:child_process.exec
EXTERNAL_FUNCTION:fs/promises.readFile
```

## Edge Examples

```
CALL:test.js->handler->CALL->readFile#0 --CALLS--> EXTERNAL_FUNCTION:fs.readFile
IMPORT:test.js:fs:readFile --IMPORTS_FROM--> EXTERNAL_MODULE:fs
```

## Test Results

**Unit Tests (`test/unit/BuiltinRegistry.test.js`):**
- 33 tests passing
- Module recognition, function lookup, metadata, createNodeId

**Unit Tests (`test/unit/NodejsBuiltinsResolver.test.js`):**
- 12 tests passing
- EXTERNAL_FUNCTION creation, CALLS edges, aliases, namespaces, node: prefix

**Integration Tests (`test/scenarios/09-nodejs-builtins.test.js`):**
- 22 tests passing (9 suites)
- Full analysis pipeline with test fixtures

## Files Modified

1. `packages/core/src/data/builtins/types.ts` - NEW
2. `packages/core/src/data/builtins/definitions.ts` - NEW
3. `packages/core/src/data/builtins/BuiltinRegistry.ts` - NEW
4. `packages/core/src/data/builtins/index.ts` - NEW
5. `packages/core/src/plugins/enrichment/NodejsBuiltinsResolver.ts` - NEW
6. `packages/core/src/core/nodes/ExternalModuleNode.ts` - MODIFIED (node: normalization)
7. `packages/core/src/index.ts` - MODIFIED (exports)
8. `test/helpers/createTestOrchestrator.js` - MODIFIED (plugin registration)
9. `test/unit/BuiltinRegistry.test.js` - UPDATED
10. `test/unit/NodejsBuiltinsResolver.test.js` - UPDATED

## Notes

- Lazy creation: EXTERNAL_FUNCTION nodes are only created when calls are detected
- Deduplication: Both nodes and edges are deduplicated
- Idempotent: Running the plugin multiple times produces same result
- The fix to ExternalModuleNode also benefits the GraphBuilder which was creating nodes with `node:` prefix
