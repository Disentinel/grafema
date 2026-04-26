# Joel Spolsky: REG-218 Technical Specification

## Summary

Based on Don's analysis, I've expanded the plan into specific implementation steps. The goal is to create semantic bindings for Node.js built-in modules, enabling Grafema to answer queries like "what files does this code read?" or "find all child_process.exec calls."

---

## 1. Data Model

### 1.1 Builtin Function Definition Schema

```typescript
// File: packages/core/src/data/builtins/types.ts

/**
 * Definition for a single built-in function/method
 */
interface BuiltinFunctionDef {
  /** Module name (fs, path, crypto, etc.) */
  module: string;

  /** Function/method name (readFile, join, etc.) */
  name: string;

  /** Is this a pure function (no side effects)? */
  pure: boolean;

  /** Is this async (returns Promise)? */
  async: boolean;

  /** Security classification */
  security: 'none' | 'file-io' | 'exec' | 'network' | 'crypto';

  /** Optional: parameter info for data flow */
  signature?: {
    params: Array<{ name: string; type?: string }>;
    returns?: string;
  };

  /** Submodule (e.g., 'promises' for fs.promises.readFile) */
  submodule?: string;

  /** Alternative names/aliases (e.g., readFileSync for readFile) */
  variants?: string[];
}

/**
 * Module definition with all its exported functions
 */
interface BuiltinModuleDef {
  module: string;
  functions: BuiltinFunctionDef[];
}
```

### 1.2 JSON Definition Files

Location: `packages/core/src/data/builtins/`

Example `fs.json`:
```json
{
  "module": "fs",
  "functions": [
    {
      "name": "readFile",
      "pure": false,
      "async": true,
      "security": "file-io",
      "variants": ["readFileSync"],
      "signature": {
        "params": [
          { "name": "path", "type": "string" },
          { "name": "options", "type": "object" }
        ],
        "returns": "Buffer | string"
      }
    },
    {
      "name": "writeFile",
      "pure": false,
      "async": true,
      "security": "file-io",
      "variants": ["writeFileSync"]
    },
    {
      "name": "stat",
      "pure": false,
      "async": true,
      "security": "file-io",
      "variants": ["statSync"]
    },
    {
      "name": "existsSync",
      "pure": false,
      "async": false,
      "security": "file-io"
    },
    {
      "name": "rm",
      "pure": false,
      "async": true,
      "security": "file-io",
      "variants": ["rmSync"]
    }
  ]
}
```

---

## 2. Node Types

### 2.1 New Node Type: `BUILTIN_FUNCTION`

**ID Format:** `BUILTIN_FUNCTION:{module}.{name}`

**Examples:**
- `BUILTIN_FUNCTION:fs.readFile`
- `BUILTIN_FUNCTION:path.join`
- `BUILTIN_FUNCTION:crypto.createHash`
- `BUILTIN_FUNCTION:child_process.exec`

**Node Record:**
```typescript
interface BuiltinFunctionNodeRecord extends BaseNodeRecord {
  type: 'BUILTIN_FUNCTION';
  name: string;           // "readFile"
  module: string;         // "fs"
  pure: boolean;          // false
  async: boolean;         // true
  security: string;       // "file-io"
  submodule?: string;     // "promises" for fs/promises
  file: '__builtin__';    // Standard builtin marker
  line: 0;
}
```

### 2.2 Graph Structure

```
EXTERNAL_MODULE:fs
    │
    ├── CONTAINS ──> BUILTIN_FUNCTION:fs.readFile
    ├── CONTAINS ──> BUILTIN_FUNCTION:fs.writeFile
    └── CONTAINS ──> BUILTIN_FUNCTION:fs.stat

/app/service.js:CALL:readFile:15:2
    │
    └── CALLS ──> BUILTIN_FUNCTION:fs.readFile
```

---

## 3. Implementation Steps

### Step 1: Create BuiltinFunctionNode Contract [TDD]

**Test first:** `test/unit/core/nodes/BuiltinFunctionNode.test.ts`
```typescript
describe('BuiltinFunctionNode', () => {
  it('creates node with correct ID format', () => {
    const node = BuiltinFunctionNode.create('fs', 'readFile', {
      pure: false, async: true, security: 'file-io'
    });
    assert.equal(node.id, 'BUILTIN_FUNCTION:fs.readFile');
    assert.equal(node.type, 'BUILTIN_FUNCTION');
  });

  it('validates required fields', () => {
    const errors = BuiltinFunctionNode.validate({ id: 'bad', type: 'BUILTIN_FUNCTION' });
    assert.ok(errors.includes('Missing required field: module'));
  });

  it('handles submodule correctly', () => {
    const node = BuiltinFunctionNode.create('fs', 'readFile', {
      submodule: 'promises', pure: false, async: true, security: 'file-io'
    });
    assert.equal(node.submodule, 'promises');
  });
});
```

**Implementation:** `packages/core/src/core/nodes/BuiltinFunctionNode.ts`

```typescript
interface BuiltinFunctionOptions {
  pure: boolean;
  async: boolean;
  security: 'none' | 'file-io' | 'exec' | 'network' | 'crypto';
  submodule?: string;
  variants?: string[];
}

export class BuiltinFunctionNode {
  static readonly TYPE = 'BUILTIN_FUNCTION' as const;

  static create(module: string, name: string, options: BuiltinFunctionOptions): BuiltinFunctionNodeRecord {
    // Singleton ID pattern (like ExternalModuleNode)
    const id = `BUILTIN_FUNCTION:${module}.${name}`;

    return {
      id,
      type: this.TYPE,
      name,
      module,
      pure: options.pure,
      async: options.async,
      security: options.security,
      submodule: options.submodule,
      file: '__builtin__',
      line: 0
    };
  }

  static validate(node: BaseNodeRecord): string[] {
    // Validation logic
  }
}
```

**Files to modify:**
- Create: `packages/core/src/core/nodes/BuiltinFunctionNode.ts`
- Modify: `packages/core/src/core/nodes/index.ts` (add export)
- Modify: `packages/core/src/core/NodeFactory.ts` (add factory method)
- Modify: `packages/core/src/index.ts` (add public export)

---

### Step 2: Create Builtin Definitions Loader [TDD]

**Test first:** `test/unit/data/builtins/BuiltinRegistry.test.ts`
```typescript
describe('BuiltinRegistry', () => {
  it('loads fs module definitions', () => {
    const registry = new BuiltinRegistry();
    const fs = registry.getModule('fs');
    assert.ok(fs);
    assert.ok(fs.functions.find(f => f.name === 'readFile'));
  });

  it('looks up function by module.name', () => {
    const registry = new BuiltinRegistry();
    const fn = registry.getFunction('fs', 'readFile');
    assert.equal(fn?.name, 'readFile');
    assert.equal(fn?.security, 'file-io');
  });

  it('handles fs/promises syntax', () => {
    const registry = new BuiltinRegistry();
    const fn = registry.resolveFunctionFromImport('fs/promises', 'readFile');
    assert.equal(fn?.module, 'fs');
    assert.equal(fn?.submodule, 'promises');
  });
});
```

**Implementation:** `packages/core/src/data/builtins/BuiltinRegistry.ts`

```typescript
export class BuiltinRegistry {
  private modules: Map<string, BuiltinModuleDef>;

  constructor() {
    this.modules = this.loadAllDefinitions();
  }

  private loadAllDefinitions(): Map<string, BuiltinModuleDef> {
    // Load from JSON files in same directory
  }

  getModule(name: string): BuiltinModuleDef | undefined;
  getFunction(module: string, name: string): BuiltinFunctionDef | undefined;
  resolveFunctionFromImport(source: string, name: string): BuiltinFunctionDef | undefined;
  isBuiltinModule(source: string): boolean;
}
```

**Files to create:**
- `packages/core/src/data/builtins/BuiltinRegistry.ts`
- `packages/core/src/data/builtins/types.ts`
- `packages/core/src/data/builtins/index.ts`
- `packages/core/src/data/builtins/fs.json`
- `packages/core/src/data/builtins/path.json`
- `packages/core/src/data/builtins/crypto.json`
- `packages/core/src/data/builtins/http.json`
- `packages/core/src/data/builtins/child_process.json`

---

### Step 3: Create NodeJSBuiltinsPlugin [TDD]

**Test first:** `test/scenarios/nodejs-builtins.test.js`

**Fixture:** `test/fixtures/nodejs-builtins/`
```javascript
// index.js
import { readFile } from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { exec } from 'child_process';

export async function processFile(filePath) {
  const content = await readFile(filePath, 'utf-8');
  const hash = createHash('sha256').update(content).digest('hex');
  const name = path.basename(filePath);
  return { name, hash };
}

export function runCommand(cmd) {
  return exec(cmd);
}
```

**Test cases:**
```javascript
describe('Node.js Builtins', () => {
  it('creates EXTERNAL_MODULE nodes for builtin imports', async () => {
    await orchestrator.run(FIXTURE_PATH);

    (await assertGraph(backend))
      .hasNode('EXTERNAL_MODULE', 'fs')
      .hasNode('EXTERNAL_MODULE', 'path')
      .hasNode('EXTERNAL_MODULE', 'crypto')
      .hasNode('EXTERNAL_MODULE', 'child_process');
  });

  it('creates BUILTIN_FUNCTION nodes for imported functions', async () => {
    await orchestrator.run(FIXTURE_PATH);

    (await assertGraph(backend))
      .hasNode('BUILTIN_FUNCTION', 'fs.readFile')
      .hasNode('BUILTIN_FUNCTION', 'path.basename')
      .hasNode('BUILTIN_FUNCTION', 'crypto.createHash')
      .hasNode('BUILTIN_FUNCTION', 'child_process.exec');
  });

  it('links CALLS from call sites to BUILTIN_FUNCTION', async () => {
    await orchestrator.run(FIXTURE_PATH);

    (await assertGraph(backend))
      .hasEdge('CALLS', { srcName: 'readFile', dstId: 'BUILTIN_FUNCTION:fs.readFile' })
      .hasEdge('CALLS', { srcName: 'exec', dstId: 'BUILTIN_FUNCTION:child_process.exec' });
  });

  it('marks security-sensitive functions correctly', async () => {
    await orchestrator.run(FIXTURE_PATH);

    const allNodes = await backend.getAllNodes();
    const execNode = allNodes.find(n => n.id === 'BUILTIN_FUNCTION:child_process.exec');
    assert.equal(execNode.security, 'exec');
  });

  it('identifies pure vs impure functions', async () => {
    await orchestrator.run(FIXTURE_PATH);

    const allNodes = await backend.getAllNodes();
    const pathBasename = allNodes.find(n => n.id === 'BUILTIN_FUNCTION:path.basename');
    const fsReadFile = allNodes.find(n => n.id === 'BUILTIN_FUNCTION:fs.readFile');

    assert.equal(pathBasename.pure, true);
    assert.equal(fsReadFile.pure, false);
  });
});
```

**Implementation:** `packages/core/src/plugins/analysis/NodeJSBuiltinsPlugin.ts`

```typescript
export class NodeJSBuiltinsPlugin extends Plugin {
  private registry: BuiltinRegistry;
  private createdNodes: Set<string> = new Set();

  constructor() {
    super();
    this.registry = new BuiltinRegistry();
  }

  get metadata(): PluginMetadata {
    return {
      name: 'NodeJSBuiltinsPlugin',
      phase: 'ANALYSIS',
      priority: 85, // Before MethodCallResolver (ENRICHMENT:50), after JSASTAnalyzer (80)
      creates: {
        nodes: ['BUILTIN_FUNCTION'],
        edges: ['CONTAINS']
      },
      dependencies: ['JSASTAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    // 1. Find all IMPORT nodes with source matching builtin modules
    // 2. For each builtin import, create BUILTIN_FUNCTION node if not exists
    // 3. Create CONTAINS edge from EXTERNAL_MODULE to BUILTIN_FUNCTION
  }
}
```

**Files to create:**
- `packages/core/src/plugins/analysis/NodeJSBuiltinsPlugin.ts`
- Modify: `packages/core/src/index.ts` (export)

---

### Step 4: Extend MethodCallResolver for Builtins [TDD]

**Key Change:** Remove builtin modules from `isExternalMethod()` exclusion list and add builtin resolution logic.

**Current code (MethodCallResolver.ts:328-337):**
```typescript
private isExternalMethod(object: string, method: string): boolean {
  const externalObjects = new Set([
    'console', 'Math', 'JSON', ...
    'fs', 'path', 'http', 'https', 'crypto', 'os', 'url', 'util'  // <-- REMOVE THESE
  ]);
  return externalObjects.has(object);
}
```

**New approach:**
```typescript
private isExternalMethod(object: string, method: string): boolean {
  // Keep only browser/runtime globals that we don't want to track
  const externalObjects = new Set([
    'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
    'Boolean', 'Date', 'RegExp', 'Error', 'Promise', 'Set', 'Map',
    'WeakSet', 'WeakMap', 'Symbol', 'Proxy', 'Reflect', 'Intl',
    'process', 'global', 'window', 'document', 'Buffer'
    // REMOVED: 'fs', 'path', 'http', 'https', 'crypto', 'os', 'url', 'util'
  ]);
  return externalObjects.has(object);
}
```

**Add builtin resolution:**
```typescript
private async resolveMethodCall(...): Promise<BaseNodeRecord | null> {
  // ... existing logic ...

  // NEW: Check if this is a builtin module call
  const builtinNode = await this.resolveBuiltinCall(object, method, graph);
  if (builtinNode) {
    return builtinNode;
  }

  return null;
}

private async resolveBuiltinCall(
  object: string,
  method: string,
  graph: PluginContext['graph']
): Promise<BaseNodeRecord | null> {
  // Look up BUILTIN_FUNCTION:{object}.{method}
  const builtinId = `BUILTIN_FUNCTION:${object}.${method}`;
  return graph.getNode(builtinId);
}
```

---

### Step 5: Handle Import Aliasing [TDD]

**Problem:** When user writes:
```javascript
const fs = require('fs');
fs.readFile('file.txt');  // object = 'fs', but 'fs' is a variable
```

**Solution:** ValueDomainAnalyzer already tracks variable origins. We need to:

1. In MethodCallResolver, check if `object` variable traces back to a builtin import
2. If yes, resolve the call to the appropriate BUILTIN_FUNCTION

**Test:**
```javascript
// test/fixtures/nodejs-builtins/require-alias.js
const myFs = require('fs');
const customPath = require('path');

myFs.readFile('test.txt');  // Should link to BUILTIN_FUNCTION:fs.readFile
customPath.join('a', 'b');  // Should link to BUILTIN_FUNCTION:path.join
```

This is handled naturally if:
1. ImportExportVisitor creates IMPORT nodes for require() calls with `source: 'fs'`
2. AliasTracker links the variable to the import
3. MethodCallResolver traces the alias back

**Files to modify:**
- `packages/core/src/plugins/enrichment/MethodCallResolver.ts`

---

## 4. Test Plan

### 4.1 Unit Tests

| File | Tests |
|------|-------|
| `test/unit/core/nodes/BuiltinFunctionNode.test.ts` | Node creation, validation, ID format |
| `test/unit/data/builtins/BuiltinRegistry.test.ts` | Loading, lookup, fs/promises handling |

### 4.2 Integration Tests

| Fixture | Tests |
|---------|-------|
| `test/fixtures/nodejs-builtins/` | Main scenario - all Tier 1 modules |
| `test/fixtures/nodejs-builtins/require-alias.js` | CommonJS require aliasing |
| `test/fixtures/nodejs-builtins/es-import.js` | ESM named imports |
| `test/fixtures/nodejs-builtins/fs-promises.js` | fs/promises special case |

### 4.3 Test Scenarios

**Scenario file:** `test/scenarios/nodejs-builtins.test.js`

```javascript
describe('Node.js Builtins', () => {
  describe('Node Creation', () => {
    it('creates BUILTIN_FUNCTION nodes for imported functions');
    it('creates EXTERNAL_MODULE nodes for builtin modules');
    it('links EXTERNAL_MODULE --CONTAINS--> BUILTIN_FUNCTION');
  });

  describe('Call Resolution', () => {
    it('links CALL --CALLS--> BUILTIN_FUNCTION for direct calls');
    it('links CALL --CALLS--> BUILTIN_FUNCTION for aliased calls');
    it('handles method chaining (crypto.createHash().update())');
  });

  describe('Metadata', () => {
    it('marks file-io functions correctly');
    it('marks exec functions as security-sensitive');
    it('identifies pure functions (path.join, path.basename)');
    it('identifies async functions');
  });

  describe('Edge Cases', () => {
    it('handles fs/promises imports');
    it('handles node: prefix (node:fs)');
    it('handles destructured imports');
    it('handles namespace imports (import * as fs)');
  });
});
```

---

## 5. Integration Points

### 5.1 Where to Hook

| Component | Integration Point |
|-----------|------------------|
| `NodeFactory.ts` | Add `createBuiltinFunction()` method |
| `index.ts` | Export `BuiltinFunctionNode`, `NodeJSBuiltinsPlugin`, `BuiltinRegistry` |
| `MethodCallResolver.ts` | Modify `isExternalMethod()`, add `resolveBuiltinCall()` |
| `NodeKind.ts` | Add `'BUILTIN_FUNCTION'` to node type constants |
| `createTestOrchestrator.js` | Add `NodeJSBuiltinsPlugin` to default plugins |

### 5.2 Plugin Execution Order

```
ANALYSIS Phase:
1. JSASTAnalyzer (priority: 80) - Creates IMPORT, CALL nodes
2. NodeJSBuiltinsPlugin (priority: 85) - Creates BUILTIN_FUNCTION nodes

ENRICHMENT Phase:
3. ImportExportLinker (priority: 90) - Links imports to exports
4. MethodCallResolver (priority: 50) - Links CALL to BUILTIN_FUNCTION
5. ValueDomainAnalyzer (priority: 40) - Traces aliases
```

---

## 6. File Structure Summary

```
packages/core/src/
├── core/
│   └── nodes/
│       ├── BuiltinFunctionNode.ts        [NEW]
│       └── index.ts                       [MODIFY - add export]
├── data/
│   └── builtins/
│       ├── types.ts                       [NEW]
│       ├── BuiltinRegistry.ts             [NEW]
│       ├── index.ts                       [NEW]
│       ├── fs.json                        [NEW]
│       ├── path.json                      [NEW]
│       ├── crypto.json                    [NEW]
│       ├── http.json                      [NEW]
│       └── child_process.json             [NEW]
├── plugins/
│   ├── analysis/
│   │   └── NodeJSBuiltinsPlugin.ts        [NEW]
│   └── enrichment/
│       └── MethodCallResolver.ts          [MODIFY]
├── NodeFactory.ts                         [MODIFY]
└── index.ts                               [MODIFY]

test/
├── fixtures/
│   └── nodejs-builtins/
│       ├── package.json                   [NEW]
│       ├── index.js                       [NEW]
│       ├── require-alias.js               [NEW]
│       ├── es-import.js                   [NEW]
│       └── fs-promises.js                 [NEW]
├── scenarios/
│   └── nodejs-builtins.test.js            [NEW]
└── unit/
    ├── core/nodes/
    │   └── BuiltinFunctionNode.test.ts    [NEW]
    └── data/builtins/
        └── BuiltinRegistry.test.ts        [NEW]
```

---

## 7. Tier 1 Builtin Definitions

### fs (5 functions)
| Function | Pure | Async | Security |
|----------|------|-------|----------|
| readFile | false | true | file-io |
| writeFile | false | true | file-io |
| stat | false | true | file-io |
| existsSync | false | false | file-io |
| rm | false | true | file-io |

### path (5 functions)
| Function | Pure | Async | Security |
|----------|------|-------|----------|
| join | true | false | none |
| resolve | true | false | none |
| basename | true | false | none |
| dirname | true | false | none |
| extname | true | false | none |

### http (3 functions)
| Function | Pure | Async | Security |
|----------|------|-------|----------|
| createServer | false | false | network |
| request | false | true | network |
| get | false | true | network |

### crypto (4 functions)
| Function | Pure | Async | Security |
|----------|------|-------|----------|
| createHash | true | false | crypto |
| randomBytes | false | true | crypto |
| pbkdf2 | false | true | crypto |
| sign | false | true | crypto |

### child_process (3 functions)
| Function | Pure | Async | Security |
|----------|------|-------|----------|
| exec | false | true | exec |
| spawn | false | false | exec |
| fork | false | false | exec |

**Total: 20 functions**

---

## 8. Commit Plan

| # | Commit | Files |
|---|--------|-------|
| 1 | `feat(types): add BuiltinFunctionNode contract` | BuiltinFunctionNode.ts, nodes/index.ts |
| 2 | `feat(data): add builtin registry and Tier 1 definitions` | builtins/*.ts, builtins/*.json |
| 3 | `feat(core): add NodeFactory.createBuiltinFunction` | NodeFactory.ts |
| 4 | `feat(plugins): add NodeJSBuiltinsPlugin` | NodeJSBuiltinsPlugin.ts |
| 5 | `feat(enrichment): extend MethodCallResolver for builtins` | MethodCallResolver.ts |
| 6 | `test: add nodejs-builtins fixture and scenario` | test/fixtures/*, test/scenarios/* |
| 7 | `feat(core): export new builtin types` | index.ts |

---

## Critical Files for Implementation

- `packages/core/src/core/nodes/ExternalModuleNode.ts` - Pattern to follow for singleton node creation
- `packages/core/src/plugins/enrichment/MethodCallResolver.ts` - Must modify to resolve builtin calls instead of skipping them
- `packages/core/src/plugins/analysis/FetchAnalyzer.ts` - Pattern to follow for ANALYSIS phase plugin
- `packages/core/src/core/NodeFactory.ts` - Add factory method for new node type
- `test/scenarios/07-http-requests.test.js` - Pattern to follow for integration tests
