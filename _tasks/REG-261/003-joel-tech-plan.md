# Joel Spolsky - Technical Specification: REG-261 BrokenImportValidator

## Overview

This document provides a detailed implementation plan for `BrokenImportValidator`, a new VALIDATION-phase plugin that detects broken imports (references to non-existent exports) and undefined symbols in JavaScript/TypeScript codebases.

The implementation follows existing validator patterns (DataFlowValidator, CallResolverValidator, GraphConnectivityValidator) and integrates with the existing diagnostic category system in `grafema check`.

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `packages/core/src/plugins/validation/BrokenImportValidator.ts` | **CREATE** | New validator plugin |
| `packages/core/src/data/globals/index.ts` | **CREATE** | Global symbols registry |
| `packages/core/src/data/globals/definitions.ts` | **CREATE** | Global symbol definitions |
| `packages/core/src/index.ts` | **MODIFY** | Export new validator and globals |
| `packages/cli/src/commands/check.ts` | **MODIFY** | Add 'imports' category |
| `test/unit/core/BrokenImportValidator.test.ts` | **CREATE** | Unit tests |

---

## Implementation Steps

### Step 1: Create Global Symbols Registry

**File:** `packages/core/src/data/globals/definitions.ts`

```typescript
/**
 * Global Symbol Definitions
 *
 * JavaScript/TypeScript globals that should not be reported as undefined.
 * Organized by environment and category.
 */

/**
 * ECMAScript standard globals (available in all JS environments)
 */
export const ECMASCRIPT_GLOBALS: string[] = [
  // Value properties
  'globalThis', 'Infinity', 'NaN', 'undefined',

  // Function properties
  'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'decodeURI',
  'decodeURIComponent', 'encodeURI', 'encodeURIComponent',

  // Fundamental objects
  'Object', 'Function', 'Boolean', 'Symbol',

  // Error objects
  'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError',
  'SyntaxError', 'TypeError', 'URIError',

  // Numbers and dates
  'Number', 'BigInt', 'Math', 'Date',

  // Text processing
  'String', 'RegExp',

  // Collections
  'Array', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
  'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'Map', 'Set', 'WeakMap', 'WeakSet',

  // Structured data
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'JSON',

  // Control abstraction
  'Promise', 'Generator', 'GeneratorFunction', 'AsyncFunction',
  'AsyncGenerator', 'AsyncGeneratorFunction',

  // Reflection
  'Reflect', 'Proxy',

  // Internationalization
  'Intl',
];

/**
 * Node.js-specific globals
 */
export const NODEJS_GLOBALS: string[] = [
  // Core globals
  'console', 'process', 'global', 'Buffer',

  // Timers
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate',

  // Module system
  'require', 'module', 'exports', '__dirname', '__filename',

  // URL/fetch (Node 18+)
  'fetch', 'URL', 'URLSearchParams', 'Request', 'Response', 'Headers',

  // Blob/File (Node 18+)
  'Blob', 'File', 'FormData',

  // Streams
  'ReadableStream', 'WritableStream', 'TransformStream',

  // Crypto
  'crypto', 'Crypto', 'CryptoKey', 'SubtleCrypto',

  // Text encoding
  'TextEncoder', 'TextDecoder',

  // Events
  'Event', 'EventTarget', 'AbortController', 'AbortSignal',

  // Performance
  'performance', 'PerformanceEntry', 'PerformanceObserver',

  // Queuing
  'queueMicrotask',

  // MessageChannel
  'MessageChannel', 'MessagePort', 'BroadcastChannel',

  // Structured clone
  'structuredClone',
];

/**
 * Browser-specific globals (commonly used, may appear in isomorphic code)
 */
export const BROWSER_GLOBALS: string[] = [
  // DOM
  'window', 'document', 'navigator', 'location', 'history',

  // Elements
  'HTMLElement', 'Element', 'Node', 'NodeList', 'DocumentFragment',

  // Events
  'addEventListener', 'removeEventListener', 'CustomEvent',

  // Storage
  'localStorage', 'sessionStorage', 'indexedDB',

  // Workers
  'Worker', 'SharedWorker', 'ServiceWorker',

  // Animation
  'requestAnimationFrame', 'cancelAnimationFrame',

  // Alerts
  'alert', 'confirm', 'prompt',

  // Screen/viewport
  'screen', 'innerWidth', 'innerHeight', 'scrollX', 'scrollY',

  // Image/media
  'Image', 'Audio', 'Video',

  // Observers
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
];

/**
 * Test framework globals (common testing environments)
 */
export const TEST_GLOBALS: string[] = [
  // Node.js test runner
  'describe', 'it', 'test', 'before', 'after', 'beforeEach', 'afterEach',

  // Jest
  'expect', 'jest', 'mock', 'spyOn', 'fn',

  // Mocha/Chai
  'assert', 'should',

  // Vitest
  'vi',
];

/**
 * All default globals combined
 */
export const ALL_GLOBALS: Set<string> = new Set([
  ...ECMASCRIPT_GLOBALS,
  ...NODEJS_GLOBALS,
  ...BROWSER_GLOBALS,
  ...TEST_GLOBALS,
]);
```

**File:** `packages/core/src/data/globals/index.ts`

```typescript
/**
 * Global Symbols Registry
 *
 * Provides lookup for JavaScript/TypeScript global symbols.
 * Used by BrokenImportValidator to avoid false positives on globals.
 */

export {
  ECMASCRIPT_GLOBALS,
  NODEJS_GLOBALS,
  BROWSER_GLOBALS,
  TEST_GLOBALS,
  ALL_GLOBALS,
} from './definitions.js';

/**
 * GlobalsRegistry class for extensible globals management.
 *
 * Usage:
 *   const registry = new GlobalsRegistry();
 *   if (registry.isGlobal('console')) { ... }
 *   registry.addCustomGlobals(['myGlobal']);
 */
export class GlobalsRegistry {
  private globals: Set<string>;

  constructor(includeDefaults: boolean = true) {
    this.globals = includeDefaults
      ? new Set(ALL_GLOBALS)
      : new Set();
  }

  /**
   * Check if a symbol name is a known global.
   */
  isGlobal(name: string): boolean {
    return this.globals.has(name);
  }

  /**
   * Add custom globals (e.g., from project config).
   */
  addCustomGlobals(names: string[]): void {
    for (const name of names) {
      this.globals.add(name);
    }
  }

  /**
   * Remove globals from the set (e.g., if project doesn't use browser env).
   */
  removeGlobals(names: string[]): void {
    for (const name of names) {
      this.globals.delete(name);
    }
  }

  /**
   * Get all registered globals.
   */
  getAllGlobals(): string[] {
    return Array.from(this.globals);
  }
}
```

---

### Step 2: Create BrokenImportValidator Plugin

**File:** `packages/core/src/plugins/validation/BrokenImportValidator.ts`

```typescript
/**
 * BrokenImportValidator - detects broken imports and undefined symbols (REG-261)
 *
 * This VALIDATION plugin queries the graph (built by ANALYSIS and ENRICHMENT phases)
 * to detect:
 *
 * 1. ERR_BROKEN_IMPORT: Named/default import references non-existent export
 *    - IMPORT node with relative source but no IMPORTS_FROM edge
 *    - Skips: external (npm) imports, namespace imports, type-only imports
 *
 * 2. ERR_UNDEFINED_SYMBOL: Symbol used but not defined, imported, or global
 *    - CALL node without CALLS edge
 *    - Not a method call (no `object` property)
 *    - Not a local definition (FUNCTION/CLASS/VARIABLE in same file)
 *    - Not an import (IMPORT with matching local name)
 *    - Not a known global (console, setTimeout, etc.)
 *
 * Architecture follows existing validator patterns:
 * - Phase: VALIDATION
 * - Priority: 85 (after enrichment, before general validators)
 * - Returns: ValidationError[] collected via DiagnosticCollector
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';
import { ValidationError } from '../../errors/GrafemaError.js';
import { GlobalsRegistry } from '../../data/globals/index.js';

// === INTERFACES ===

interface ImportNode extends BaseNodeRecord {
  source?: string;
  importType?: string; // 'default' | 'named' | 'namespace'
  imported?: string;   // Original name in source module
  local?: string;      // Local binding name in this file
  importBinding?: string; // 'value' | 'type' (TypeScript)
}

interface CallNode extends BaseNodeRecord {
  object?: string; // If present, this is a method call
}

interface DefinitionNode extends BaseNodeRecord {
  // Common fields: name, file, line
}

// === CONSTANTS ===

const ERROR_CODES = {
  BROKEN_IMPORT: 'ERR_BROKEN_IMPORT',
  UNDEFINED_SYMBOL: 'ERR_UNDEFINED_SYMBOL',
} as const;

// Types that represent local definitions
const DEFINITION_TYPES = new Set([
  'FUNCTION',
  'CLASS',
  'VARIABLE_DECLARATION',
  'CONSTANT',
  'PARAMETER',
]);

// === PLUGIN CLASS ===

export class BrokenImportValidator extends Plugin {
  private globalsRegistry: GlobalsRegistry;

  constructor(config: Record<string, unknown> = {}) {
    super(config);
    this.globalsRegistry = new GlobalsRegistry();

    // Allow custom globals from config
    const customGlobals = config.customGlobals as string[] | undefined;
    if (customGlobals) {
      this.globalsRegistry.addCustomGlobals(customGlobals);
    }
  }

  get metadata(): PluginMetadata {
    return {
      name: 'BrokenImportValidator',
      phase: 'VALIDATION',
      priority: 85, // After enrichment plugins, before general validators
      creates: {
        nodes: [],
        edges: []
      },
      dependencies: ['ImportExportLinker', 'FunctionCallResolver']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    logger.info('Starting broken import validation');
    const startTime = Date.now();

    const errors: ValidationError[] = [];
    const stats = {
      importsChecked: 0,
      brokenImports: 0,
      callsChecked: 0,
      undefinedSymbols: 0,
      skipped: {
        externalImports: 0,
        namespaceImports: 0,
        typeOnlyImports: 0,
        methodCalls: 0,
        alreadyResolved: 0,
        localDefinitions: 0,
        imports: 0,
        globals: 0,
      },
    };

    // === Step 1: Build indexes ===

    // Index: file -> Set<name> for local definitions
    const definitionsByFile = new Map<string, Set<string>>();
    for await (const node of graph.queryNodes({})) {
      if (!DEFINITION_TYPES.has(node.type)) continue;
      if (!node.file || !node.name) continue;

      if (!definitionsByFile.has(node.file)) {
        definitionsByFile.set(node.file, new Set());
      }
      definitionsByFile.get(node.file)!.add(node.name);
    }
    logger.debug('Indexed definitions', { files: definitionsByFile.size });

    // Index: file:local -> ImportNode
    const importsByFile = new Map<string, Map<string, ImportNode>>();
    const allImports: ImportNode[] = [];

    for await (const node of graph.queryNodes({ nodeType: 'IMPORT' })) {
      const imp = node as ImportNode;
      if (!imp.file) continue;

      allImports.push(imp);

      // Index by local name for undefined symbol checking
      const localName = imp.local || imp.name;
      if (localName) {
        if (!importsByFile.has(imp.file)) {
          importsByFile.set(imp.file, new Map());
        }
        importsByFile.get(imp.file)!.set(localName, imp);
      }
    }
    logger.debug('Indexed imports', { count: allImports.length });

    // === Step 2: Check for broken imports ===

    for (const imp of allImports) {
      stats.importsChecked++;

      // Progress reporting
      if (onProgress && stats.importsChecked % 100 === 0) {
        onProgress({
          phase: 'validation',
          currentPlugin: 'BrokenImportValidator',
          message: `Checking imports ${stats.importsChecked}/${allImports.length}`,
          totalFiles: allImports.length,
          processedFiles: stats.importsChecked
        });
      }

      // Skip external (npm) imports - only check relative imports
      const isRelative = imp.source &&
        (imp.source.startsWith('./') || imp.source.startsWith('../'));
      if (!isRelative) {
        stats.skipped.externalImports++;
        continue;
      }

      // Skip namespace imports - they link to MODULE, not EXPORT
      if (imp.importType === 'namespace') {
        stats.skipped.namespaceImports++;
        continue;
      }

      // Skip type-only imports (TypeScript) - erased at compile time
      if (imp.importBinding === 'type') {
        stats.skipped.typeOnlyImports++;
        continue;
      }

      // Check for IMPORTS_FROM edge
      const importsFromEdges = await graph.getOutgoingEdges(imp.id, ['IMPORTS_FROM']);

      if (importsFromEdges.length === 0) {
        // No IMPORTS_FROM edge = broken import
        const importedName = imp.imported || imp.local || imp.name;

        errors.push(new ValidationError(
          `Import "${importedName}" from "${imp.source}" - export doesn't exist`,
          ERROR_CODES.BROKEN_IMPORT,
          {
            filePath: imp.file,
            lineNumber: imp.line as number | undefined,
            phase: 'VALIDATION',
            plugin: 'BrokenImportValidator',
            importedName,
            source: imp.source,
            importType: imp.importType,
          },
          `Check if "${importedName}" is exported from "${imp.source}"`,
          'error'
        ));

        stats.brokenImports++;
      }
    }

    logger.debug('Broken imports found', { count: stats.brokenImports });

    // === Step 3: Check for undefined symbols ===

    const callsToCheck: CallNode[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      const call = node as CallNode;

      // Skip method calls (have object attribute)
      if (call.object) {
        stats.skipped.methodCalls++;
        continue;
      }

      // Skip if already has CALLS edge (resolved)
      const callsEdges = await graph.getOutgoingEdges(call.id, ['CALLS']);
      if (callsEdges.length > 0) {
        stats.skipped.alreadyResolved++;
        continue;
      }

      callsToCheck.push(call);
    }

    logger.debug('Unresolved calls to check', { count: callsToCheck.length });

    for (const call of callsToCheck) {
      stats.callsChecked++;

      const calledName = call.name;
      const file = call.file;

      if (!calledName || !file) continue;

      // Check 1: Is it a local definition?
      const fileDefinitions = definitionsByFile.get(file);
      if (fileDefinitions?.has(calledName)) {
        stats.skipped.localDefinitions++;
        continue;
      }

      // Check 2: Is it imported? (even if broken, that's a different error)
      const fileImports = importsByFile.get(file);
      if (fileImports?.has(calledName)) {
        stats.skipped.imports++;
        continue;
      }

      // Check 3: Is it a global?
      if (this.globalsRegistry.isGlobal(calledName)) {
        stats.skipped.globals++;
        continue;
      }

      // Symbol is undefined
      errors.push(new ValidationError(
        `"${calledName}" is used but not defined or imported`,
        ERROR_CODES.UNDEFINED_SYMBOL,
        {
          filePath: file,
          lineNumber: call.line as number | undefined,
          phase: 'VALIDATION',
          plugin: 'BrokenImportValidator',
          symbol: calledName,
        },
        `Add an import for "${calledName}" or define it locally`,
        'warning' // Warning severity - might be a false positive
      ));

      stats.undefinedSymbols++;
    }

    // === Step 4: Summary ===

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    const summary = {
      importsChecked: stats.importsChecked,
      brokenImports: stats.brokenImports,
      callsChecked: stats.callsChecked,
      undefinedSymbols: stats.undefinedSymbols,
      skipped: stats.skipped,
      totalIssues: stats.brokenImports + stats.undefinedSymbols,
      time: `${totalTime}s`,
    };

    logger.info('Validation complete', summary);

    if (errors.length > 0) {
      logger.warn('Issues found', {
        brokenImports: stats.brokenImports,
        undefinedSymbols: stats.undefinedSymbols,
      });

      // Log first few errors for visibility
      for (const error of errors.slice(0, 5)) {
        if (error.code === ERROR_CODES.BROKEN_IMPORT) {
          logger.error(`[${error.code}] ${error.message}`);
        } else {
          logger.warn(`[${error.code}] ${error.message}`);
        }
      }
      if (errors.length > 5) {
        logger.debug(`... and ${errors.length - 5} more issues`);
      }
    }

    return createSuccessResult(
      { nodes: 0, edges: 0 },
      { summary },
      errors
    );
  }
}
```

---

### Step 3: Update Core Exports

**File:** `packages/core/src/index.ts` (add to existing exports)

Add these lines near the other validation plugin exports (around line 210):

```typescript
// After existing validators
export { BrokenImportValidator } from './plugins/validation/BrokenImportValidator.js';

// After existing data exports (around line 200)
export { GlobalsRegistry, ALL_GLOBALS } from './data/globals/index.js';
```

---

### Step 4: Add Diagnostic Category

**File:** `packages/cli/src/commands/check.ts`

Modify the `CHECK_CATEGORIES` constant (around line 49):

```typescript
// Available diagnostic categories
export const CHECK_CATEGORIES: Record<string, DiagnosticCheckCategory> = {
  'connectivity': {
    name: 'Graph Connectivity',
    description: 'Check for disconnected nodes in the graph',
    codes: ['ERR_DISCONNECTED_NODES', 'ERR_DISCONNECTED_NODE'],
  },
  'calls': {
    name: 'Call Resolution',
    description: 'Check for unresolved function calls',
    codes: ['ERR_UNRESOLVED_CALL'],
  },
  'dataflow': {
    name: 'Data Flow',
    description: 'Check for missing assignments and broken references',
    codes: ['ERR_MISSING_ASSIGNMENT', 'ERR_BROKEN_REFERENCE', 'ERR_NO_LEAF_NODE'],
  },
  'imports': {
    name: 'Import Validation',
    description: 'Check for broken imports and undefined symbols',
    codes: ['ERR_BROKEN_IMPORT', 'ERR_UNDEFINED_SYMBOL'],
  },
};
```

---

### Step 5: Unit Tests

**File:** `test/unit/core/BrokenImportValidator.test.ts`

```typescript
/**
 * Tests for BrokenImportValidator (REG-261)
 *
 * Tests cover:
 * - ERR_BROKEN_IMPORT: Named/default import with no matching export
 * - ERR_UNDEFINED_SYMBOL: Call to undefined symbol
 * - False positive prevention (globals, local definitions, etc.)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { BrokenImportValidator } from '@grafema/core';

// =============================================================================
// Mock Graph Implementation
// =============================================================================

interface MockNode {
  id: string;
  type: string;
  name?: string;
  file?: string;
  line?: number;
  source?: string;
  importType?: string;
  imported?: string;
  local?: string;
  importBinding?: string;
  object?: string;
  [key: string]: unknown;
}

interface MockEdge {
  type: string;
  src: string;
  dst: string;
}

class MockGraph {
  private nodes: Map<string, MockNode> = new Map();
  private edges: MockEdge[] = [];

  addNode(node: MockNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(edge: MockEdge): void {
    this.edges.push(edge);
  }

  async *queryNodes(filter: { nodeType?: string }): AsyncIterableIterator<MockNode> {
    for (const node of this.nodes.values()) {
      if (!filter.nodeType || node.type === filter.nodeType) {
        yield node;
      }
    }
  }

  async getNode(id: string): Promise<MockNode | null> {
    return this.nodes.get(id) || null;
  }

  async getOutgoingEdges(nodeId: string, edgeTypes: string[]): Promise<MockEdge[]> {
    return this.edges.filter(
      e => e.src === nodeId && edgeTypes.includes(e.type)
    );
  }

  async getAllNodes(): Promise<MockNode[]> {
    return Array.from(this.nodes.values());
  }

  async getAllEdges(): Promise<MockEdge[]> {
    return this.edges;
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

function createContext(graph: MockGraph) {
  return {
    graph: graph as any,
    manifest: {},
    projectPath: '/test/project',
    logger: {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
    },
  };
}

// =============================================================================
// TESTS: ERR_BROKEN_IMPORT
// =============================================================================

describe('BrokenImportValidator - ERR_BROKEN_IMPORT', () => {
  let graph: MockGraph;
  let validator: BrokenImportValidator;

  beforeEach(() => {
    graph = new MockGraph();
    validator = new BrokenImportValidator();
  });

  it('should detect broken named import (no IMPORTS_FROM edge)', async () => {
    // Setup: IMPORT node without IMPORTS_FROM edge
    graph.addNode({
      id: 'import-1',
      type: 'IMPORT',
      name: 'nonExistent',
      file: '/test/file.js',
      line: 3,
      source: './utils',
      importType: 'named',
      imported: 'nonExistent',
      local: 'nonExistent',
    });

    const result = await validator.execute(createContext(graph));

    assert.strictEqual(result.errors?.length, 1);
    assert.strictEqual(result.errors?.[0].code, 'ERR_BROKEN_IMPORT');
    assert.ok(result.errors?.[0].message.includes('nonExistent'));
    assert.ok(result.errors?.[0].message.includes('./utils'));
  });

  it('should detect broken default import (no IMPORTS_FROM edge)', async () => {
    graph.addNode({
      id: 'import-1',
      type: 'IMPORT',
      name: 'myDefault',
      file: '/test/file.js',
      line: 1,
      source: './missing',
      importType: 'default',
      local: 'myDefault',
    });

    const result = await validator.execute(createContext(graph));

    assert.strictEqual(result.errors?.length, 1);
    assert.strictEqual(result.errors?.[0].code, 'ERR_BROKEN_IMPORT');
  });

  it('should NOT report error for valid import (has IMPORTS_FROM edge)', async () => {
    graph.addNode({
      id: 'import-1',
      type: 'IMPORT',
      name: 'validFunc',
      file: '/test/file.js',
      line: 1,
      source: './utils',
      importType: 'named',
      imported: 'validFunc',
      local: 'validFunc',
    });
    graph.addNode({
      id: 'export-1',
      type: 'EXPORT',
      name: 'validFunc',
      file: '/test/utils.js',
    });
    graph.addEdge({
      type: 'IMPORTS_FROM',
      src: 'import-1',
      dst: 'export-1',
    });

    const result = await validator.execute(createContext(graph));

    const brokenImportErrors = result.errors?.filter(e => e.code === 'ERR_BROKEN_IMPORT') || [];
    assert.strictEqual(brokenImportErrors.length, 0);
  });

  it('should skip external (npm) imports', async () => {
    graph.addNode({
      id: 'import-1',
      type: 'IMPORT',
      name: 'lodash',
      file: '/test/file.js',
      line: 1,
      source: 'lodash', // No ./ or ../
      importType: 'namespace',
    });

    const result = await validator.execute(createContext(graph));

    const brokenImportErrors = result.errors?.filter(e => e.code === 'ERR_BROKEN_IMPORT') || [];
    assert.strictEqual(brokenImportErrors.length, 0);
  });

  it('should skip namespace imports', async () => {
    graph.addNode({
      id: 'import-1',
      type: 'IMPORT',
      name: 'utils',
      file: '/test/file.js',
      line: 1,
      source: './utils',
      importType: 'namespace', // import * as utils
    });

    const result = await validator.execute(createContext(graph));

    const brokenImportErrors = result.errors?.filter(e => e.code === 'ERR_BROKEN_IMPORT') || [];
    assert.strictEqual(brokenImportErrors.length, 0);
  });

  it('should skip type-only imports (TypeScript)', async () => {
    graph.addNode({
      id: 'import-1',
      type: 'IMPORT',
      name: 'MyType',
      file: '/test/file.ts',
      line: 1,
      source: './types',
      importType: 'named',
      importBinding: 'type', // import type { MyType }
    });

    const result = await validator.execute(createContext(graph));

    const brokenImportErrors = result.errors?.filter(e => e.code === 'ERR_BROKEN_IMPORT') || [];
    assert.strictEqual(brokenImportErrors.length, 0);
  });
});

// =============================================================================
// TESTS: ERR_UNDEFINED_SYMBOL
// =============================================================================

describe('BrokenImportValidator - ERR_UNDEFINED_SYMBOL', () => {
  let graph: MockGraph;
  let validator: BrokenImportValidator;

  beforeEach(() => {
    graph = new MockGraph();
    validator = new BrokenImportValidator();
  });

  it('should detect undefined symbol (not imported, not local, not global)', async () => {
    graph.addNode({
      id: 'call-1',
      type: 'CALL',
      name: 'unknownFunction',
      file: '/test/file.js',
      line: 10,
    });

    const result = await validator.execute(createContext(graph));

    const undefinedErrors = result.errors?.filter(e => e.code === 'ERR_UNDEFINED_SYMBOL') || [];
    assert.strictEqual(undefinedErrors.length, 1);
    assert.ok(undefinedErrors[0].message.includes('unknownFunction'));
  });

  it('should NOT report error for locally defined function', async () => {
    // Define function
    graph.addNode({
      id: 'func-1',
      type: 'FUNCTION',
      name: 'localFunc',
      file: '/test/file.js',
      line: 1,
    });
    // Call to local function
    graph.addNode({
      id: 'call-1',
      type: 'CALL',
      name: 'localFunc',
      file: '/test/file.js',
      line: 10,
    });

    const result = await validator.execute(createContext(graph));

    const undefinedErrors = result.errors?.filter(e => e.code === 'ERR_UNDEFINED_SYMBOL') || [];
    assert.strictEqual(undefinedErrors.length, 0);
  });

  it('should NOT report error for imported function (even if broken)', async () => {
    // Import (even without IMPORTS_FROM - that's ERR_BROKEN_IMPORT, not ERR_UNDEFINED_SYMBOL)
    graph.addNode({
      id: 'import-1',
      type: 'IMPORT',
      name: 'importedFunc',
      file: '/test/file.js',
      source: './utils',
      importType: 'named',
      local: 'importedFunc',
    });
    // Call to imported function
    graph.addNode({
      id: 'call-1',
      type: 'CALL',
      name: 'importedFunc',
      file: '/test/file.js',
      line: 10,
    });

    const result = await validator.execute(createContext(graph));

    const undefinedErrors = result.errors?.filter(e => e.code === 'ERR_UNDEFINED_SYMBOL') || [];
    assert.strictEqual(undefinedErrors.length, 0);
  });

  it('should NOT report error for global functions (console, setTimeout, etc.)', async () => {
    graph.addNode({
      id: 'call-1',
      type: 'CALL',
      name: 'console',
      file: '/test/file.js',
      line: 1,
    });
    graph.addNode({
      id: 'call-2',
      type: 'CALL',
      name: 'setTimeout',
      file: '/test/file.js',
      line: 2,
    });
    graph.addNode({
      id: 'call-3',
      type: 'CALL',
      name: 'Promise',
      file: '/test/file.js',
      line: 3,
    });
    graph.addNode({
      id: 'call-4',
      type: 'CALL',
      name: 'Array',
      file: '/test/file.js',
      line: 4,
    });

    const result = await validator.execute(createContext(graph));

    const undefinedErrors = result.errors?.filter(e => e.code === 'ERR_UNDEFINED_SYMBOL') || [];
    assert.strictEqual(undefinedErrors.length, 0);
  });

  it('should NOT report error for method calls (have object property)', async () => {
    graph.addNode({
      id: 'call-1',
      type: 'CALL',
      name: 'someMethod',
      file: '/test/file.js',
      line: 5,
      object: 'myObject', // Method call: myObject.someMethod()
    });

    const result = await validator.execute(createContext(graph));

    const undefinedErrors = result.errors?.filter(e => e.code === 'ERR_UNDEFINED_SYMBOL') || [];
    assert.strictEqual(undefinedErrors.length, 0);
  });

  it('should NOT report error for resolved calls (have CALLS edge)', async () => {
    graph.addNode({
      id: 'func-1',
      type: 'FUNCTION',
      name: 'targetFunc',
      file: '/test/utils.js',
    });
    graph.addNode({
      id: 'call-1',
      type: 'CALL',
      name: 'targetFunc',
      file: '/test/file.js',
      line: 10,
    });
    graph.addEdge({
      type: 'CALLS',
      src: 'call-1',
      dst: 'func-1',
    });

    const result = await validator.execute(createContext(graph));

    const undefinedErrors = result.errors?.filter(e => e.code === 'ERR_UNDEFINED_SYMBOL') || [];
    assert.strictEqual(undefinedErrors.length, 0);
  });
});

// =============================================================================
// TESTS: Custom Globals Configuration
// =============================================================================

describe('BrokenImportValidator - Custom Globals', () => {
  it('should accept custom globals from config', async () => {
    const graph = new MockGraph();
    const validator = new BrokenImportValidator({
      customGlobals: ['myCustomGlobal', 'anotherGlobal'],
    });

    graph.addNode({
      id: 'call-1',
      type: 'CALL',
      name: 'myCustomGlobal',
      file: '/test/file.js',
      line: 1,
    });

    const result = await validator.execute(createContext(graph));

    const undefinedErrors = result.errors?.filter(e => e.code === 'ERR_UNDEFINED_SYMBOL') || [];
    assert.strictEqual(undefinedErrors.length, 0);
  });
});

// =============================================================================
// TESTS: Metadata and Result Structure
// =============================================================================

describe('BrokenImportValidator - Metadata', () => {
  it('should have correct plugin metadata', () => {
    const validator = new BrokenImportValidator();
    const metadata = validator.metadata;

    assert.strictEqual(metadata.name, 'BrokenImportValidator');
    assert.strictEqual(metadata.phase, 'VALIDATION');
    assert.strictEqual(metadata.priority, 85);
    assert.ok(metadata.dependencies?.includes('ImportExportLinker'));
    assert.ok(metadata.dependencies?.includes('FunctionCallResolver'));
  });

  it('should return proper result structure', async () => {
    const graph = new MockGraph();
    const validator = new BrokenImportValidator();

    const result = await validator.execute(createContext(graph));

    assert.strictEqual(result.status, 'success');
    assert.ok(result.metadata);
    assert.ok('summary' in result.metadata);
    assert.ok(Array.isArray(result.errors));
  });
});
```

---

## Integration Checklist

After implementation, verify:

- [ ] `npm run build` completes without errors
- [ ] `npm test` passes (including new tests)
- [ ] `grafema analyze <test-project>` runs successfully
- [ ] `grafema check imports` shows new category
- [ ] `grafema check --list-categories` shows 'imports' category
- [ ] Broken imports detected correctly in test fixtures
- [ ] No false positives for globals, local definitions, npm packages

---

## Test Fixtures

Create test fixtures for integration testing at `test/fixtures/broken-imports/`:

**`test/fixtures/broken-imports/broken-named.js`:**
```javascript
// ERR_BROKEN_IMPORT: named import of non-existent export
import { nonExistentFunc } from './utils.js';

nonExistentFunc();
```

**`test/fixtures/broken-imports/broken-default.js`:**
```javascript
// ERR_BROKEN_IMPORT: default import of module without default export
import missing from './utils.js';

missing();
```

**`test/fixtures/broken-imports/undefined-symbol.js`:**
```javascript
// ERR_UNDEFINED_SYMBOL: call to undefined function
undefinedFunction();
```

**`test/fixtures/broken-imports/valid.js`:**
```javascript
// No errors - valid code
import { existingFunc } from './utils.js';
import path from 'path';

existingFunc();
console.log('hello');
setTimeout(() => {}, 1000);
```

**`test/fixtures/broken-imports/utils.js`:**
```javascript
// Module with one named export (no default)
export function existingFunc() {
  return 'exists';
}
```

---

## Error Codes Summary

| Code | Severity | Category | Description |
|------|----------|----------|-------------|
| `ERR_BROKEN_IMPORT` | error | imports | Named/default import references non-existent export |
| `ERR_UNDEFINED_SYMBOL` | warning | imports | Symbol used but not defined, imported, or global |

---

## Risk Mitigation

1. **False Positives**: GlobalsRegistry includes comprehensive list of globals. Custom globals configurable via `customGlobals` option.

2. **Performance**: Single pass through nodes with O(1) lookups using pre-built indexes. Same pattern as existing validators.

3. **Edge Cases**: Skip namespace imports, type-only imports, external packages. These have different semantics.

---

## Next Steps

1. Kent Beck: Write tests first (copy tests section above)
2. Rob Pike: Implement validator following spec
3. Verify all tests pass
4. Run `grafema analyze` + `grafema check imports` on real codebase
