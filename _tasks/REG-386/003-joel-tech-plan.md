# Joel Spolsky -- Detailed Technical Spec: REG-386

## Summary

Expose Grafema's own plugin pipeline to the graph so agents can query plugin metadata (phase, creates, dependencies, source file) without reading source code. This implements Don's Option C: create `grafema:plugin` nodes at startup, before the first analysis phase runs.

---

## Implementation Steps (Ordered)

### Step 1: Add `GRAFEMA_PLUGIN` to NAMESPACED_TYPE in NodeKind.ts

**File:** `packages/core/src/core/nodes/NodeKind.ts`

**What:** Add one line to the `NAMESPACED_TYPE` const.

**Context (lines 56-92):**
```typescript
export const NAMESPACED_TYPE = {
  // HTTP (generic)
  HTTP_ROUTE: 'http:route',
  HTTP_REQUEST: 'http:request',
  // ... existing entries ...
  // Events
  EVENT_LISTENER: 'event:listener',
  EVENT_EMIT: 'event:emit',

  // Guarantees (contract-based)
  GUARANTEE_QUEUE: 'guarantee:queue',
  GUARANTEE_API: 'guarantee:api',
  GUARANTEE_PERMISSION: 'guarantee:permission',
} as const;
```

**After:**
```typescript
export const NAMESPACED_TYPE = {
  // ... existing entries ...

  // Guarantees (contract-based)
  GUARANTEE_QUEUE: 'guarantee:queue',
  GUARANTEE_API: 'guarantee:api',
  GUARANTEE_PERMISSION: 'guarantee:permission',

  // Grafema internal (self-describing)
  GRAFEMA_PLUGIN: 'grafema:plugin',
} as const;
```

**Also add** a helper function at the bottom:
```typescript
/**
 * Check if type is a grafema internal type (grafema:plugin, etc.)
 */
export function isGrafemaType(nodeType: string): boolean {
  if (!nodeType) return false;
  return getNamespace(nodeType) === 'grafema';
}
```

**Complexity:** O(1). Trivial constant addition.

**Note:** The `NAMESPACED_TYPE` in `packages/types/src/nodes.ts` does NOT need updating -- it is a parallel definition for the types package but is not consumed by NodeFactory or NodeKind. The canonical definition for runtime use is in `NodeKind.ts`. However, for type completeness, also add to `packages/types/src/nodes.ts`:

```typescript
// packages/types/src/nodes.ts, NAMESPACED_TYPE (line 52-83)
  // Grafema internal
  GRAFEMA_PLUGIN: 'grafema:plugin',
```

---

### Step 2: Create PluginNode.ts contract class

**File (new):** `packages/core/src/core/nodes/PluginNode.ts`

**Pattern:** Follows `GuaranteeNode.ts` and `IssueNode.ts` exactly -- a static class with `create()`, `validate()`, `parseId()`, and `buildId()`.

**Full implementation:**

```typescript
/**
 * PluginNode - contract for grafema:plugin nodes
 *
 * Type: grafema:plugin
 * ID format: grafema:plugin#HTTPConnectionEnricher
 *
 * Represents a Grafema plugin registered in the analysis pipeline.
 * Created by the Orchestrator at startup, before the first analysis phase.
 * Enables agents to query plugin metadata without reading source code.
 */

import type { BaseNodeRecord } from '@grafema/types';
import { NAMESPACED_TYPE, isGrafemaType } from './NodeKind.js';

export interface PluginNodeRecord extends BaseNodeRecord {
  type: 'grafema:plugin';
  /** Plugin class name */
  name: string;
  /** Phase: DISCOVERY | INDEXING | ANALYSIS | ENRICHMENT | VALIDATION */
  phase: string;
  /** Priority within phase (higher = runs earlier) */
  priority: number;
  /** Source file path (relative to monorepo root for builtins, absolute for custom) */
  file: string;
  /** Whether this is a built-in plugin (vs custom from .grafema/plugins/) */
  builtin: boolean;
  /** Node types this plugin creates */
  createsNodes: string[];
  /** Edge types this plugin creates */
  createsEdges: string[];
  /** Names of plugins this plugin depends on */
  dependencies: string[];
}

export interface PluginNodeOptions {
  priority?: number;
  file?: string;
  line?: number;
  builtin?: boolean;
  createsNodes?: string[];
  createsEdges?: string[];
  dependencies?: string[];
}

export class PluginNode {
  static readonly TYPE = NAMESPACED_TYPE.GRAFEMA_PLUGIN;
  static readonly REQUIRED = ['name', 'phase'] as const;
  static readonly OPTIONAL = ['priority', 'file', 'builtin', 'createsNodes', 'createsEdges', 'dependencies'] as const;

  /**
   * Generate plugin node ID
   * Format: grafema:plugin#<name>
   *
   * Plugin names are unique within a pipeline, so no hash needed.
   */
  static generateId(name: string): string {
    return `grafema:plugin#${name}`;
  }

  /**
   * Create plugin node from metadata
   *
   * @param name - Plugin class name (e.g., 'HTTPConnectionEnricher')
   * @param phase - Plugin phase (e.g., 'ENRICHMENT')
   * @param options - Optional fields
   */
  static create(
    name: string,
    phase: string,
    options: PluginNodeOptions = {}
  ): PluginNodeRecord {
    if (!name) throw new Error('PluginNode.create: name is required');
    if (!phase) throw new Error('PluginNode.create: phase is required');

    const VALID_PHASES = ['DISCOVERY', 'INDEXING', 'ANALYSIS', 'ENRICHMENT', 'VALIDATION'];
    if (!VALID_PHASES.includes(phase)) {
      throw new Error(`PluginNode.create: invalid phase "${phase}". Valid: ${VALID_PHASES.join(', ')}`);
    }

    const id = this.generateId(name);

    return {
      id,
      type: 'grafema:plugin',
      name,
      phase,
      priority: options.priority ?? 0,
      file: options.file ?? '',
      line: options.line,
      builtin: options.builtin ?? true,
      createsNodes: options.createsNodes ?? [],
      createsEdges: options.createsEdges ?? [],
      dependencies: options.dependencies ?? [],
      metadata: {
        creates: {
          nodes: options.createsNodes ?? [],
          edges: options.createsEdges ?? [],
        },
        dependencies: options.dependencies ?? [],
        builtin: options.builtin ?? true,
      },
    };
  }

  /**
   * Validate plugin node
   * @returns array of error messages, empty if valid
   */
  static validate(node: BaseNodeRecord): string[] {
    const errors: string[] = [];
    const record = node as PluginNodeRecord;

    if (node.type !== 'grafema:plugin') {
      errors.push(`Expected grafema:plugin type, got ${node.type}`);
    }

    if (!record.name) {
      errors.push('Missing required field: name');
    }

    if (!record.phase) {
      errors.push('Missing required field: phase');
    }

    return errors;
  }

  /**
   * Parse plugin ID into components
   * @param id - full ID (e.g., 'grafema:plugin#HTTPConnectionEnricher')
   * @returns { name } or null if invalid
   */
  static parseId(id: string): { name: string } | null {
    if (!id) return null;

    const match = id.match(/^grafema:plugin#(.+)$/);
    if (!match) return null;

    return { name: match[1] };
  }

  /**
   * Check if type is a plugin type
   */
  static isPluginType(type: string): boolean {
    return type === 'grafema:plugin';
  }
}
```

**Complexity:** O(1) for all operations. No iteration.

---

### Step 3: Export PluginNode from nodes/index.ts

**File:** `packages/core/src/core/nodes/index.ts`

**What:** Add export line after IssueNode.

**After line 53 (IssueNode export):**
```typescript
// Plugin nodes (self-describing pipeline)
export { PluginNode, type PluginNodeRecord } from './PluginNode.js';
```

**Also export `isGrafemaType` from NodeKind section (line 56-69):**
```typescript
export {
  NODE_TYPE,
  NAMESPACED_TYPE,
  isNamespacedType,
  getNamespace,
  getBaseName,
  isEndpointType,
  isSideEffectType,
  matchesTypePattern,
  isGuaranteeType,
  isGrafemaType,       // <-- ADD THIS
  type BaseNodeType,
  type NamespacedNodeType,
  type NodeType,
} from './NodeKind.js';
```

---

### Step 4: Add `createPlugin()` to NodeFactory

**File:** `packages/core/src/core/NodeFactory.ts`

**What:** Add import of `PluginNode` and a new factory method.

**Import addition (after line 47, alongside IssueNode import):**
```typescript
import {
  // ... existing imports ...
  IssueNode,
  PluginNode,            // <-- ADD
  type EntrypointType,
  type EntrypointTrigger,
  type DecoratorTargetType,
  type InterfacePropertyRecord,
  type EnumMemberRecord,
  type IssueSeverity,
} from './nodes/index.js';
```

**New factory method (after `createIssue`, around line 664):**
```typescript
  /**
   * Create grafema:plugin node
   *
   * Represents a Grafema plugin in the analysis pipeline.
   * Created by the Orchestrator at startup to make the pipeline
   * queryable via the graph.
   *
   * @param name - Plugin class name (e.g., 'HTTPConnectionEnricher')
   * @param phase - Plugin phase (DISCOVERY, INDEXING, ANALYSIS, ENRICHMENT, VALIDATION)
   * @param options - Optional fields (priority, file, builtin, creates, dependencies)
   */
  static createPlugin(
    name: string,
    phase: string,
    options: {
      priority?: number;
      file?: string;
      line?: number;
      builtin?: boolean;
      createsNodes?: string[];
      createsEdges?: string[];
      dependencies?: string[];
    } = {}
  ) {
    return brandNode(PluginNode.create(name, phase, options));
  }
```

**Also update the `validate()` method's validators map (line 670-700) to handle `grafema:plugin`:**
```typescript
    // Handle grafema:plugin type
    if (PluginNode.isPluginType(node.type)) {
      return PluginNode.validate(node);
    }
```

Add this check alongside the existing `IssueNode.isIssueType()` check (after line 703).

**Complexity:** O(1). No iteration.

---

### Step 5: Export PluginNode from core/index.ts

**File:** `packages/core/src/index.ts`

**What:** Add export after the GuaranteeNode exports (around line 137).

```typescript
// Plugin nodes (self-describing pipeline)
export { PluginNode } from './core/nodes/PluginNode.js';
export type { PluginNodeRecord } from './core/nodes/PluginNode.js';
```

Also export `isGrafemaType`:
```typescript
// Node kinds
export { isGuaranteeType, isGrafemaType } from './core/nodes/NodeKind.js';
```

(Modify the existing line 131.)

---

### Step 6: Register plugin nodes in Orchestrator

**File:** `packages/core/src/Orchestrator.ts`

This is the core behavioral change. The Orchestrator will create `grafema:plugin` nodes for all loaded plugins before the first phase runs.

**What:** Add a private method `registerPluginNodes()` and call it at the start of `run()`.

**Import addition (line 21, alongside NodeFactory import):**
```typescript
import { NodeFactory } from './core/NodeFactory.js';
// (already imported -- just verify)
```

**New private method (add after the `buildIndexingUnits` method, around line 683):**

```typescript
  /**
   * Register all loaded plugins as grafema:plugin nodes in the graph.
   *
   * Creates a node for each plugin with its metadata (phase, priority,
   * creates, dependencies, source file). Also creates DEPENDS_ON edges
   * between plugins that declare dependencies.
   *
   * Called once at the start of run(), before any analysis phase.
   * Complexity: O(p) where p = number of plugins (typically 20-35).
   */
  private async registerPluginNodes(): Promise<void> {
    const pluginNodes: Array<{ id: string; name: string; dependencies: string[] }> = [];

    for (const plugin of this.plugins) {
      const meta = plugin.metadata;
      if (!meta?.name) continue;

      // Determine source file path
      // Built-in plugins: derive from phase directory convention
      // Custom plugins: stored in plugin.config.sourceFile (set by loadCustomPlugins)
      const sourceFile = (plugin.config?.sourceFile as string) || '';
      const isBuiltin = !plugin.config?.sourceFile;

      const node = NodeFactory.createPlugin(meta.name, meta.phase, {
        priority: meta.priority ?? 0,
        file: sourceFile,
        builtin: isBuiltin,
        createsNodes: meta.creates?.nodes ?? [],
        createsEdges: meta.creates?.edges ?? [],
        dependencies: meta.dependencies ?? [],
      });

      await this.graph.addNode(node);
      pluginNodes.push({
        id: node.id,
        name: meta.name,
        dependencies: meta.dependencies ?? [],
      });
    }

    // Create DEPENDS_ON edges between plugins
    // Build a name-to-id map for resolving dependencies
    const nameToId = new Map<string, string>();
    for (const pn of pluginNodes) {
      nameToId.set(pn.name, pn.id);
    }

    for (const pn of pluginNodes) {
      for (const dep of pn.dependencies) {
        const depId = nameToId.get(dep);
        if (depId) {
          await this.graph.addEdge({
            src: pn.id,
            dst: depId,
            type: 'DEPENDS_ON',
          });
        }
        // If dependency not found (e.g., dependency not in current config),
        // silently skip -- the plugin may still function without it.
      }
    }

    this.logger.debug('Registered plugin nodes', {
      count: pluginNodes.length,
      edges: pluginNodes.reduce((sum, pn) => sum + pn.dependencies.length, 0),
    });
  }
```

**Call site in `run()` (line 220, right after `RADICAL SIMPLIFICATION` clear block, before PHASE 0):**

Current code (lines 232-239):
```typescript
    // RADICAL SIMPLIFICATION: Clear entire graph once at the start if forceAnalysis
    if (this.forceAnalysis && this.graph.clear) {
      this.logger.info('Clearing entire graph (forceAnalysis=true)');
      await this.graph.clear();
      this.logger.info('Graph cleared successfully');
    }

    this.onProgress({ phase: 'discovery', ... });
```

**After the clear block, before the progress call, add:**
```typescript
    // Register plugin pipeline as grafema:plugin nodes (REG-386)
    await this.registerPluginNodes();
```

**Also in `runMultiRoot()` (line 493, after the clear block):**
```typescript
    // Register plugin pipeline as grafema:plugin nodes (REG-386)
    await this.registerPluginNodes();
```

**Complexity:** O(p + d) where p = number of plugins (20-35), d = total dependency edges (typically ~50). This is negligible compared to the analysis pipeline.

---

### Step 7: Pass source file info for custom plugins

**File:** `packages/cli/src/commands/analyze.ts`

**What:** In `loadCustomPlugins()`, store the plugin's source file path in `plugin.config.sourceFile`.

Current code (lines 146-149):
```typescript
        if (PluginClass && typeof PluginClass === 'function') {
          const pluginName = PluginClass.name || file.replace(/\.[cm]?js$/, '');
          customPlugins[pluginName] = () => new PluginClass() as Plugin;
          log(`Loaded custom plugin: ${pluginName}`);
        }
```

**After:**
```typescript
        if (PluginClass && typeof PluginClass === 'function') {
          const pluginName = PluginClass.name || file.replace(/\.[cm]?js$/, '');
          customPlugins[pluginName] = () => {
            const instance = new PluginClass() as Plugin;
            instance.config.sourceFile = pluginPath;
            return instance;
          };
          log(`Loaded custom plugin: ${pluginName}`);
        }
```

**File:** `packages/mcp/src/config.ts`

Same change in `loadCustomPlugins()` (lines 155-160):
```typescript
        if (PluginClass && typeof PluginClass === 'function') {
          const pluginName = PluginClass.name || file.replace(/\.(m?js)$/, '');
          const instance = new PluginClass();
          (instance as any).config = (instance as any).config || {};
          (instance as any).config.sourceFile = pluginPath;
          customPlugins.push(instance);
          pluginMap[pluginName] = PluginClass;
          log(`[Grafema MCP] Loaded custom plugin: ${pluginName} from ${file}`);
        }
```

**Note:** For built-in plugins, we do NOT need to set sourceFile -- the `registerPluginNodes()` method detects `!plugin.config.sourceFile` and sets `builtin: true`. The source file for builtins could be computed, but it is not the acceptance criteria for this ticket. The node's `file` field will be empty for builtins (acceptable for MVP -- the plugin name + metadata is the critical queryable data). If we want to add file paths for builtins later, that is a follow-up (Don's plan notes this as Risk #1).

**Complexity:** O(1) per custom plugin. No additional iteration.

---

### Step 8: Add "plugin" type alias to query.ts

**File:** `packages/cli/src/commands/query.ts`

**What:** Add `'plugin': 'grafema:plugin'` to the `typeMap` in `parsePattern()`, and add `'grafema:plugin'` to the default search types in `findNodes()`.

**In `parsePattern()` (lines 243-265), add to typeMap:**
```typescript
    const typeMap: Record<string, string> = {
      function: 'FUNCTION',
      fn: 'FUNCTION',
      func: 'FUNCTION',
      class: 'CLASS',
      module: 'MODULE',
      variable: 'VARIABLE',
      var: 'VARIABLE',
      const: 'CONSTANT',
      constant: 'CONSTANT',
      // HTTP route aliases
      route: 'http:route',
      endpoint: 'http:route',
      // HTTP request aliases
      request: 'http:request',
      fetch: 'http:request',
      api: 'http:request',
      // Socket.IO aliases
      event: 'socketio:event',
      emit: 'socketio:emit',
      on: 'socketio:on',
      listener: 'socketio:on',
      // Grafema internal
      plugin: 'grafema:plugin',       // <-- ADD
    };
```

**In `findNodes()` (lines 550-563), add to default searchTypes:**
```typescript
    : [
        'FUNCTION',
        'CLASS',
        'MODULE',
        'VARIABLE',
        'CONSTANT',
        'http:route',
        'http:request',
        'socketio:event',
        'socketio:emit',
        'socketio:on',
        'grafema:plugin',  // <-- ADD (optional: only when type is explicitly requested)
      ];
```

**Decision:** We should NOT add `grafema:plugin` to the default search types for untyped queries. When a user searches `grafema query "HTTP"`, they don't want plugin results mixed in. Plugin nodes should only appear when explicitly requested via `grafema query "plugin HTTPConnectionEnricher"` or `grafema query --type grafema:plugin "HTTP"`.

**Corrected approach:** Do NOT add to default searchTypes array. The `plugin` alias in `typeMap` is sufficient -- when user writes `grafema query "plugin HTTP"`, the type is resolved to `grafema:plugin` and only those nodes are searched.

**Also add display support for plugin nodes in `displayNode()` (lines 721-752):**

```typescript
  // Special formatting for plugin nodes
  if (node.type === 'grafema:plugin') {
    console.log(formatPluginDisplay(node, projectPath));
    return;
  }
```

**New helper function:**
```typescript
/**
 * Format plugin node for display
 *
 * Output:
 *   [grafema:plugin] HTTPConnectionEnricher
 *     Phase: ENRICHMENT (priority: 50)
 *     Creates: edges: INTERACTS_WITH, HTTP_RECEIVES
 *     Dependencies: ExpressRouteAnalyzer, FetchAnalyzer, ExpressResponseAnalyzer
 *     Source: packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts
 */
function formatPluginDisplay(node: NodeInfo, projectPath: string): string {
  const lines: string[] = [];

  // Line 1: [type] name
  lines.push(`[${node.type}] ${node.name}`);

  // Line 2: Phase and priority
  const phase = node.phase as string || 'unknown';
  const priority = node.priority as number ?? 0;
  lines.push(`  Phase: ${phase} (priority: ${priority})`);

  // Line 3: Creates
  const createsNodes = (node.createsNodes as string[]) || [];
  const createsEdges = (node.createsEdges as string[]) || [];
  const createsParts: string[] = [];
  if (createsNodes.length > 0) createsParts.push(`nodes: ${createsNodes.join(', ')}`);
  if (createsEdges.length > 0) createsParts.push(`edges: ${createsEdges.join(', ')}`);
  if (createsParts.length > 0) {
    lines.push(`  Creates: ${createsParts.join('; ')}`);
  }

  // Line 4: Dependencies
  const deps = (node.dependencies as string[]) || [];
  if (deps.length > 0) {
    lines.push(`  Dependencies: ${deps.join(', ')}`);
  }

  // Line 5: Source file
  if (node.file) {
    const relPath = relative(projectPath, node.file);
    lines.push(`  Source: ${relPath}`);
  }

  return lines.join('\n');
}
```

**Complexity:** O(1) for display formatting.

---

### Step 9: Add `grafema:plugin` to the NAMESPACED_TYPE in types/nodes.ts

**File:** `packages/types/src/nodes.ts`

**What:** Add to the NAMESPACED_TYPE const for type completeness.

```typescript
export const NAMESPACED_TYPE = {
  // ... existing ...
  EVENT_LISTENER: 'event:listener',
  EVENT_EMIT: 'event:emit',

  // Grafema internal
  GRAFEMA_PLUGIN: 'grafema:plugin',
} as const;
```

**Also add `PluginNodeRecord` to the NodeRecord union type (lines 289-310):**

First, add the interface:
```typescript
// Plugin node (Grafema internal)
export interface PluginNodeRecord extends BaseNodeRecord {
  type: 'grafema:plugin';
  phase: string;
  priority: number;
  builtin: boolean;
  createsNodes: string[];
  createsEdges: string[];
  dependencies: string[];
}
```

Then add to union:
```typescript
export type NodeRecord =
  | FunctionNodeRecord
  // ... existing ...
  | GuaranteeNodeRecord
  | PluginNodeRecord     // <-- ADD
  | BaseNodeRecord;
```

---

## Test Plan

### Test File: `test/unit/PluginNode.test.ts`

**Pattern:** Follows `test/unit/NodeFactoryPart1.test.js` and `test/unit/NodeFactoryPart2.test.js`.

```typescript
/**
 * PluginNode tests - REG-386
 *
 * Tests for grafema:plugin node creation, validation, and factory methods.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NodeFactory } from '@grafema/core';
import { PluginNode } from '@grafema/core';

describe('PluginNode', () => {
  // === PluginNode.create ===

  describe('PluginNode.create', () => {
    it('should create a plugin node with required fields', () => {
      const node = PluginNode.create('HTTPConnectionEnricher', 'ENRICHMENT');
      assert.strictEqual(node.id, 'grafema:plugin#HTTPConnectionEnricher');
      assert.strictEqual(node.type, 'grafema:plugin');
      assert.strictEqual(node.name, 'HTTPConnectionEnricher');
      assert.strictEqual(node.phase, 'ENRICHMENT');
      assert.strictEqual(node.priority, 0);
      assert.strictEqual(node.builtin, true);
      assert.deepStrictEqual(node.createsNodes, []);
      assert.deepStrictEqual(node.createsEdges, []);
      assert.deepStrictEqual(node.dependencies, []);
    });

    it('should create a plugin node with all options', () => {
      const node = PluginNode.create('FetchAnalyzer', 'ANALYSIS', {
        priority: 75,
        file: 'packages/core/src/plugins/analysis/FetchAnalyzer.ts',
        builtin: true,
        createsNodes: ['http:request', 'EXTERNAL'],
        createsEdges: ['CONTAINS', 'MAKES_REQUEST', 'CALLS_API'],
        dependencies: ['JSModuleIndexer', 'JSASTAnalyzer'],
      });
      assert.strictEqual(node.id, 'grafema:plugin#FetchAnalyzer');
      assert.strictEqual(node.phase, 'ANALYSIS');
      assert.strictEqual(node.priority, 75);
      assert.strictEqual(node.file, 'packages/core/src/plugins/analysis/FetchAnalyzer.ts');
      assert.deepStrictEqual(node.createsNodes, ['http:request', 'EXTERNAL']);
      assert.deepStrictEqual(node.createsEdges, ['CONTAINS', 'MAKES_REQUEST', 'CALLS_API']);
      assert.deepStrictEqual(node.dependencies, ['JSModuleIndexer', 'JSASTAnalyzer']);
    });

    it('should store creates info in metadata for Datalog queries', () => {
      const node = PluginNode.create('FetchAnalyzer', 'ANALYSIS', {
        createsNodes: ['http:request'],
        createsEdges: ['MAKES_REQUEST'],
      });
      assert.deepStrictEqual(node.metadata?.creates, {
        nodes: ['http:request'],
        edges: ['MAKES_REQUEST'],
      });
    });

    it('should throw on missing name', () => {
      assert.throws(
        () => PluginNode.create('', 'ANALYSIS'),
        /name is required/
      );
    });

    it('should throw on missing phase', () => {
      assert.throws(
        () => PluginNode.create('Test', ''),
        /phase is required/
      );
    });

    it('should throw on invalid phase', () => {
      assert.throws(
        () => PluginNode.create('Test', 'INVALID'),
        /invalid phase/
      );
    });

    it('should accept all valid phases', () => {
      for (const phase of ['DISCOVERY', 'INDEXING', 'ANALYSIS', 'ENRICHMENT', 'VALIDATION']) {
        const node = PluginNode.create(`Test_${phase}`, phase);
        assert.strictEqual(node.phase, phase);
      }
    });

    it('should mark custom plugins as non-builtin', () => {
      const node = PluginNode.create('CustomAnalyzer', 'ANALYSIS', {
        builtin: false,
        file: '/project/.grafema/plugins/CustomAnalyzer.js',
      });
      assert.strictEqual(node.builtin, false);
      assert.strictEqual(node.file, '/project/.grafema/plugins/CustomAnalyzer.js');
    });
  });

  // === PluginNode.validate ===

  describe('PluginNode.validate', () => {
    it('should pass for a valid node', () => {
      const node = PluginNode.create('Test', 'ANALYSIS');
      const errors = PluginNode.validate(node);
      assert.deepStrictEqual(errors, []);
    });

    it('should fail for wrong type', () => {
      const errors = PluginNode.validate({ id: 'x', type: 'FUNCTION', name: 'x', phase: 'ANALYSIS' } as any);
      assert.ok(errors.some(e => e.includes('grafema:plugin')));
    });

    it('should fail for missing name', () => {
      const errors = PluginNode.validate({ id: 'x', type: 'grafema:plugin', name: '', phase: 'ANALYSIS' } as any);
      assert.ok(errors.some(e => e.includes('name')));
    });
  });

  // === PluginNode.parseId ===

  describe('PluginNode.parseId', () => {
    it('should parse valid ID', () => {
      const parsed = PluginNode.parseId('grafema:plugin#HTTPConnectionEnricher');
      assert.deepStrictEqual(parsed, { name: 'HTTPConnectionEnricher' });
    });

    it('should return null for invalid ID', () => {
      assert.strictEqual(PluginNode.parseId('issue:security#abc'), null);
      assert.strictEqual(PluginNode.parseId(''), null);
      assert.strictEqual(PluginNode.parseId('grafema:plugin'), null);
    });
  });

  // === NodeFactory.createPlugin ===

  describe('NodeFactory.createPlugin', () => {
    it('should create a branded plugin node', () => {
      const node = NodeFactory.createPlugin('TestPlugin', 'ANALYSIS');
      assert.strictEqual(node.type, 'grafema:plugin');
      assert.strictEqual(node.name, 'TestPlugin');
    });

    it('should pass options through', () => {
      const node = NodeFactory.createPlugin('TestPlugin', 'ENRICHMENT', {
        priority: 50,
        createsEdges: ['INTERACTS_WITH'],
        dependencies: ['FetchAnalyzer'],
      });
      assert.strictEqual(node.priority, 50);
      assert.deepStrictEqual(node.createsEdges, ['INTERACTS_WITH']);
      assert.deepStrictEqual(node.dependencies, ['FetchAnalyzer']);
    });
  });

  // === NodeFactory.validate for grafema:plugin ===

  describe('NodeFactory.validate for grafema:plugin', () => {
    it('should validate plugin nodes correctly', () => {
      const node = PluginNode.create('Test', 'ANALYSIS');
      const errors = NodeFactory.validate(node);
      assert.deepStrictEqual(errors, []);
    });
  });
});
```

### Test File: `test/unit/OrchestratorPluginNodes.test.ts`

**Pattern:** Integration test that verifies the Orchestrator creates plugin nodes in the graph.

```typescript
/**
 * Orchestrator plugin node registration - REG-386
 *
 * Verifies that the Orchestrator creates grafema:plugin nodes
 * for all loaded plugins before analysis begins.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

// Test with a mock graph backend
describe('Orchestrator.registerPluginNodes', () => {
  it('should create grafema:plugin nodes for each plugin', async () => {
    // Create mock graph that records addNode/addEdge calls
    const addedNodes: any[] = [];
    const addedEdges: any[] = [];
    const mockGraph = {
      addNode: (n: any) => { addedNodes.push(n); },
      addEdge: (e: any) => { addedEdges.push(e); },
      addNodes: () => {},
      addEdges: () => {},
      getNode: () => null,
      queryNodes: async function* () {},
      getAllNodes: async () => [],
      getOutgoingEdges: async () => [],
      getIncomingEdges: async () => [],
      nodeCount: async () => 0,
      edgeCount: async () => 0,
      countNodesByType: async () => ({}),
      countEdgesByType: async () => ({}),
      clear: async () => {},
    };

    // Create a minimal plugin for testing
    class TestPlugin {
      config = {};
      get metadata() {
        return {
          name: 'TestAnalyzer',
          phase: 'ANALYSIS',
          priority: 80,
          creates: { nodes: ['FUNCTION'], edges: ['CALLS'] },
          dependencies: [],
        };
      }
      async execute() {
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      }
    }

    class TestEnricher {
      config = {};
      get metadata() {
        return {
          name: 'TestEnricher',
          phase: 'ENRICHMENT',
          priority: 50,
          creates: { nodes: [], edges: ['INTERACTS_WITH'] },
          dependencies: ['TestAnalyzer'],
        };
      }
      async execute() {
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      }
    }

    // Import and create Orchestrator
    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mockGraph as any,
      plugins: [new TestPlugin() as any, new TestEnricher() as any],
      logLevel: 'silent',
    });

    // Run analysis (will call registerPluginNodes internally)
    // We can't run full analysis without a real project, so we test
    // the registration separately by checking the graph after construction
    // Actually: we need to call run() which calls registerPluginNodes()
    // For unit test, access the private method via prototype
    await (orchestrator as any).registerPluginNodes();

    // Verify plugin nodes were created
    const pluginNodes = addedNodes.filter(n => n.type === 'grafema:plugin');
    assert.strictEqual(pluginNodes.length, 2);

    const analyzerNode = pluginNodes.find(n => n.name === 'TestAnalyzer');
    assert.ok(analyzerNode);
    assert.strictEqual(analyzerNode.id, 'grafema:plugin#TestAnalyzer');
    assert.strictEqual(analyzerNode.phase, 'ANALYSIS');
    assert.strictEqual(analyzerNode.priority, 80);
    assert.deepStrictEqual(analyzerNode.createsNodes, ['FUNCTION']);

    const enricherNode = pluginNodes.find(n => n.name === 'TestEnricher');
    assert.ok(enricherNode);
    assert.strictEqual(enricherNode.id, 'grafema:plugin#TestEnricher');
    assert.strictEqual(enricherNode.phase, 'ENRICHMENT');

    // Verify DEPENDS_ON edge
    const dependsOnEdges = addedEdges.filter(e => e.type === 'DEPENDS_ON');
    assert.strictEqual(dependsOnEdges.length, 1);
    assert.strictEqual(dependsOnEdges[0].src, 'grafema:plugin#TestEnricher');
    assert.strictEqual(dependsOnEdges[0].dst, 'grafema:plugin#TestAnalyzer');
  });

  it('should handle plugins with no dependencies gracefully', async () => {
    const addedNodes: any[] = [];
    const addedEdges: any[] = [];
    const mockGraph = {
      addNode: (n: any) => { addedNodes.push(n); },
      addEdge: (e: any) => { addedEdges.push(e); },
      addNodes: () => {}, addEdges: () => {},
      getNode: () => null,
      queryNodes: async function* () {},
      getAllNodes: async () => [],
      getOutgoingEdges: async () => [],
      getIncomingEdges: async () => [],
      nodeCount: async () => 0, edgeCount: async () => 0,
      countNodesByType: async () => ({}),
      countEdgesByType: async () => ({}),
      clear: async () => {},
    };

    class LonePlugin {
      config = {};
      get metadata() {
        return { name: 'LonePlugin', phase: 'VALIDATION', priority: 10 };
      }
      async execute() {
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      }
    }

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mockGraph as any,
      plugins: [new LonePlugin() as any],
      logLevel: 'silent',
    });

    await (orchestrator as any).registerPluginNodes();

    assert.strictEqual(addedNodes.length, 1);
    assert.strictEqual(addedEdges.length, 0);
    assert.strictEqual(addedNodes[0].name, 'LonePlugin');
    assert.deepStrictEqual(addedNodes[0].dependencies, []);
  });

  it('should skip dependency edges when target plugin is not loaded', async () => {
    const addedEdges: any[] = [];
    const mockGraph = {
      addNode: () => {},
      addEdge: (e: any) => { addedEdges.push(e); },
      addNodes: () => {}, addEdges: () => {},
      getNode: () => null,
      queryNodes: async function* () {},
      getAllNodes: async () => [],
      getOutgoingEdges: async () => [],
      getIncomingEdges: async () => [],
      nodeCount: async () => 0, edgeCount: async () => 0,
      countNodesByType: async () => ({}),
      countEdgesByType: async () => ({}),
      clear: async () => {},
    };

    class PluginWithMissingDep {
      config = {};
      get metadata() {
        return {
          name: 'Orphan', phase: 'ENRICHMENT', priority: 10,
          dependencies: ['NonexistentPlugin'],
        };
      }
      async execute() {
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      }
    }

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mockGraph as any,
      plugins: [new PluginWithMissingDep() as any],
      logLevel: 'silent',
    });

    await (orchestrator as any).registerPluginNodes();

    // No edges because dependency target is not loaded
    assert.strictEqual(addedEdges.length, 0);
  });

  it('should mark custom plugins as non-builtin', async () => {
    const addedNodes: any[] = [];
    const mockGraph = {
      addNode: (n: any) => { addedNodes.push(n); },
      addEdge: () => {},
      addNodes: () => {}, addEdges: () => {},
      getNode: () => null,
      queryNodes: async function* () {},
      getAllNodes: async () => [],
      getOutgoingEdges: async () => [],
      getIncomingEdges: async () => [],
      nodeCount: async () => 0, edgeCount: async () => 0,
      countNodesByType: async () => ({}),
      countEdgesByType: async () => ({}),
      clear: async () => {},
    };

    class CustomPlugin {
      config = { sourceFile: '/project/.grafema/plugins/Custom.js' };
      get metadata() {
        return { name: 'Custom', phase: 'ANALYSIS', priority: 50 };
      }
      async execute() {
        return { success: true, created: { nodes: 0, edges: 0 }, errors: [], warnings: [] };
      }
    }

    const { Orchestrator } = await import('@grafema/core');
    const orchestrator = new Orchestrator({
      graph: mockGraph as any,
      plugins: [new CustomPlugin() as any],
      logLevel: 'silent',
    });

    await (orchestrator as any).registerPluginNodes();

    assert.strictEqual(addedNodes[0].builtin, false);
    assert.strictEqual(addedNodes[0].file, '/project/.grafema/plugins/Custom.js');
  });
});
```

### Test File: `test/unit/QueryPluginType.test.ts`

**What:** Verify the "plugin" alias in parsePattern resolves to `grafema:plugin`.

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseQuery } from '../../packages/cli/src/commands/query.js';

describe('Query plugin type alias', () => {
  it('should resolve "plugin" to grafema:plugin type', () => {
    const query = parseQuery('plugin HTTPConnectionEnricher');
    assert.strictEqual(query.type, 'grafema:plugin');
    assert.strictEqual(query.name, 'HTTPConnectionEnricher');
  });

  it('should support scope in plugin queries', () => {
    const query = parseQuery('plugin Fetch in ANALYSIS');
    // Note: "ANALYSIS" is not a file scope, so it becomes a function/class scope
    assert.strictEqual(query.type, 'grafema:plugin');
    assert.strictEqual(query.name, 'Fetch');
  });
});
```

---

## Big-O Complexity Analysis

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `PluginNode.create()` | O(1) | Static object construction |
| `PluginNode.validate()` | O(1) | Field presence checks |
| `PluginNode.parseId()` | O(1) | Regex match |
| `registerPluginNodes()` | O(p + d) | p = plugins (~30), d = total deps (~50) |
| DEPENDS_ON edge creation | O(d) | d = total dependency declarations |
| Name-to-ID map build | O(p) | One-time, in-memory |
| Query `grafema:plugin` | O(p) | Iterates only plugin nodes, not entire graph |

**No O(n) iterations over graph nodes.** The plugin registration is O(p) where p << n (graph nodes). The query infrastructure already supports type-filtered iteration, so querying `grafema:plugin` nodes only scans the plugin nodes, not the entire graph.

---

## Edge Cases and Risks

### 1. Plugin with empty or missing metadata.name
**Risk:** Low. All existing plugins have `name` in metadata.
**Mitigation:** `registerPluginNodes()` skips plugins where `meta?.name` is falsy.

### 2. Duplicate plugin names
**Risk:** Low. Plugin names are class names, which are unique in the codebase.
**Mitigation:** If two plugins have the same name, the second `addNode` call will overwrite the first (RFDB behavior). This is acceptable -- duplicate names indicate a configuration error.

### 3. Plugin nodes persist across analysis runs
**Risk:** Medium. If a plugin is removed from config but the graph is not cleared, stale `grafema:plugin` nodes remain.
**Mitigation:** `grafema analyze --clear` rebuilds everything. For non-clear runs, stale nodes are harmless metadata. A future cleanup could delete all `grafema:plugin` nodes at the start of `registerPluginNodes()` before re-creating them. This is NOT needed for MVP.

### 4. Source file paths for built-in plugins
**Risk:** Low-Medium. Built-in plugins don't carry their source file path at runtime.
**Mitigation:** For MVP, the `file` field is empty for built-in plugins. The plugin name + metadata is the primary queryable data. Source file resolution for builtins can be added in a follow-up by computing the path from `packages/core/src/plugins/{phase_lowercase}/{ClassName}.ts`. This is noted as a known limitation.

### 5. `forceAnalysis` clears graph before plugin registration
**Risk:** None. The graph clear happens first, then plugin nodes are registered. If the user does NOT use `--clear`, plugin nodes from a previous run remain, but `registerPluginNodes()` will re-add them (RFDB upsert behavior).

### 6. Plugin config mutation (`instance.config.sourceFile = ...`)
**Risk:** Low. The `Plugin` base class initializes `config` as `{}` in the constructor. Setting `sourceFile` on it is safe.
**Mitigation:** The `config` property is typed as `Record<string, unknown>`, so adding `sourceFile` is type-safe.

### 7. Orchestrator auto-adds SimpleProjectDiscovery
**Risk:** Low. Lines 208-214 of Orchestrator.ts auto-add `SimpleProjectDiscovery` if no discovery plugin is present. This auto-added plugin will also get a `grafema:plugin` node, which is correct behavior.

---

## Files Changed Summary

| # | File | Change Type | Lines |
|---|------|-------------|-------|
| 1 | `packages/core/src/core/nodes/NodeKind.ts` | Modify | +4 (constant + helper) |
| 2 | `packages/core/src/core/nodes/PluginNode.ts` | **New** | ~120 |
| 3 | `packages/core/src/core/nodes/index.ts` | Modify | +3 (export) |
| 4 | `packages/core/src/core/NodeFactory.ts` | Modify | +25 (import + method + validate) |
| 5 | `packages/core/src/index.ts` | Modify | +4 (exports) |
| 6 | `packages/core/src/Orchestrator.ts` | Modify | +50 (method + call sites) |
| 7 | `packages/cli/src/commands/analyze.ts` | Modify | +4 (sourceFile on custom plugins) |
| 8 | `packages/mcp/src/config.ts` | Modify | +3 (sourceFile on custom plugins) |
| 9 | `packages/cli/src/commands/query.ts` | Modify | +35 (alias + display) |
| 10 | `packages/types/src/nodes.ts` | Modify | +15 (type + interface + union) |
| 11 | `test/unit/PluginNode.test.ts` | **New** | ~100 |
| 12 | `test/unit/OrchestratorPluginNodes.test.ts` | **New** | ~180 |
| 13 | `test/unit/QueryPluginType.test.ts` | **New** | ~25 |

**Total production code: ~240 lines**
**Total test code: ~305 lines**

---

## Implementation Order

1. **Step 1** -- NodeKind.ts constant (unblocks everything)
2. **Step 9** -- types/nodes.ts additions (type safety)
3. **Step 2** -- PluginNode.ts contract class (core contract)
4. **Step 3** -- nodes/index.ts export
5. **Step 4** -- NodeFactory.createPlugin()
6. **Step 5** -- core/index.ts exports
7. **Tests for PluginNode** -- write and run `PluginNode.test.ts`
8. **Step 6** -- Orchestrator.registerPluginNodes()
9. **Step 7** -- Source file info in analyze.ts and config.ts
10. **Tests for Orchestrator** -- write and run `OrchestratorPluginNodes.test.ts`
11. **Step 8** -- Query alias + display
12. **Tests for Query** -- write and run `QueryPluginType.test.ts`
13. **Build and full test suite** -- `npm run build && npm test`

This order follows TDD: types first, then contract, then factory, then integration, with tests at each boundary.
