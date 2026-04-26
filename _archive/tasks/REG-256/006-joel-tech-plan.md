# Joel Spolsky — Technical Implementation Plan for REG-256

## Overview

This plan expands Don's architecture (005-don-architecture.md) into step-by-step implementation instructions. Every file path, interface, import, and test case is specified. Kent and Rob should be able to implement from this plan without asking questions.

**Total scope: ~1600 LOC across 12 new files + 9 modified files, organized into 7 implementation phases.**

---

## Phase 1: Types & Infrastructure (no behavior change)

### Step 1.1: Create `packages/types/src/resources.ts`

**New file.** Resource abstraction types.

```typescript
// packages/types/src/resources.ts

/**
 * Unique identifier for a Resource type.
 * Convention: 'domain:name' (e.g., 'routing:map', 'auth:policies').
 */
export type ResourceId = string;

/**
 * Resource — a shared typed data container accessible to plugins.
 *
 * Resources are created during a pipeline run and destroyed when the run ends.
 * Multiple plugins can write to a Resource; any plugin can read from it.
 *
 * Unlike graph nodes, Resources are:
 * - Not persisted to RFDB
 * - Not queryable via Datalog
 * - Typed (each Resource has a known interface)
 * - Scoped to a single pipeline run
 *
 * Resources are for structured data that plugins share but that doesn't
 * belong in the code graph (config-derived rules, computed indexes, etc.).
 */
export interface Resource {
  /** Unique identifier for this Resource type */
  readonly id: ResourceId;
}

/**
 * Registry for managing Resources during a pipeline run.
 * The Orchestrator creates one ResourceRegistry per run.
 * Plugins access it via PluginContext.
 */
export interface ResourceRegistry {
  /**
   * Get or create a Resource by ID.
   * If the Resource doesn't exist yet, creates it using the factory.
   * If it already exists, returns the existing instance (factory ignored).
   *
   * This "get-or-create" pattern means:
   * - First plugin to access a Resource creates it
   * - Subsequent plugins get the same instance
   * - No explicit "registration" step needed
   * - Order doesn't matter for creation (but does for writes)
   *
   * @param id - Resource identifier
   * @param factory - Factory function to create the Resource if it doesn't exist
   * @returns The Resource instance (existing or newly created)
   */
  getOrCreate<T extends Resource>(id: ResourceId, factory: () => T): T;

  /**
   * Get a Resource by ID. Returns undefined if not yet created.
   * Use this when a plugin wants to READ a Resource but should not create it.
   *
   * @param id - Resource identifier
   * @returns The Resource instance, or undefined if not yet created
   */
  get<T extends Resource>(id: ResourceId): T | undefined;

  /**
   * Check if a Resource exists.
   */
  has(id: ResourceId): boolean;
}
```

### Step 1.2: Create `packages/types/src/routing.ts`

**New file.** Routing types — RoutingRule, RoutingMap, MatchContext, MatchResult.

```typescript
// packages/types/src/routing.ts

import type { Resource } from './resources.js';

/**
 * A routing rule describes how requests are transformed between services.
 * Source-agnostic — can come from config.yaml, nginx.conf, k8s, etc.
 */
export interface RoutingRule {
  /** Service where requests originate (matches ServiceDefinition.name) */
  from: string;
  /** Service where routes are defined (matches ServiceDefinition.name) */
  to: string;
  /** Path prefix to strip from request URL before matching.
   *  e.g., stripPrefix: '/api' transforms '/api/users' -> '/users' */
  stripPrefix?: string;
  /** Path prefix to add to request URL before matching.
   *  e.g., addPrefix: '/v2' transforms '/users' -> '/v2/users' */
  addPrefix?: string;
  /** Source of this rule (for debugging/traceability) */
  source?: string;
  /** Priority — lower numbers match first. Default: 0 */
  priority?: number;
}

/**
 * Context for matching a request against the routing map.
 */
export interface MatchContext {
  /** Service name where the request originates */
  fromService: string;
  /** Original request URL (before any transformation) */
  requestUrl: string;
  /** HTTP method (optional, for future method-based routing) */
  method?: string;
}

/**
 * Result of a routing match — the transformed URL to use for matching.
 */
export interface MatchResult {
  /** Transformed URL to match against route paths */
  transformedUrl: string;
  /** Service name where the route should be found */
  targetService: string;
  /** The rule that matched */
  rule: RoutingRule;
}

/**
 * RoutingMap Resource — abstract routing table built by multiple builder plugins.
 *
 * The RoutingMap is source-agnostic. It doesn't know where rules came from
 * (config.yaml, nginx.conf, k8s manifests). It only knows:
 * "request from service A with path P routes to service B with path P'"
 *
 * Resource ID: 'routing:map'
 */
export interface RoutingMap extends Resource {
  readonly id: 'routing:map';

  /**
   * Add a routing rule. Called by builder plugins during ENRICHMENT phase.
   * Rules from different sources are merged. Duplicate rules (same from/to/strip/add)
   * are silently deduplicated.
   */
  addRule(rule: RoutingRule): void;

  /**
   * Add multiple rules at once.
   */
  addRules(rules: RoutingRule[]): void;

  /**
   * Find matching route transformation for a request context.
   *
   * If multiple rules match (same from service), returns the most specific one:
   * 1. Rules with longer stripPrefix match first (more specific)
   * 2. Among equal-length prefixes, lower priority number wins
   * 3. If still tied, first-added wins
   *
   * @returns MatchResult if a rule matches, null if no rule applies
   */
  findMatch(context: MatchContext): MatchResult | null;

  /**
   * Find ALL matching rules for a from/to service pair.
   * Used by enrichers that need to try multiple transformations.
   */
  findRulesForPair(fromService: string, toService: string): RoutingRule[];

  /**
   * Get all rules (for debugging/logging).
   */
  getAllRules(): RoutingRule[];

  /**
   * Get count of rules (for metrics).
   */
  get ruleCount(): number;
}

/** Well-known Resource ID for the RoutingMap */
export const ROUTING_MAP_RESOURCE_ID = 'routing:map' as const;
```

### Step 1.3: Update `packages/types/src/index.ts`

Add two new exports at the end of the file:

```typescript
// Add AFTER the existing "export * from './rfdb.js';" line:

// Resource types (REG-256)
export * from './resources.js';

// Routing types (REG-256)
export * from './routing.js';
```

### Step 1.4: Update `packages/types/src/plugins.ts` — ServiceDefinition

Add `customerFacing` field to `ServiceDefinition`. Insert after the existing `entryPoint?` field (line 231):

```typescript
export interface ServiceDefinition {
  /** Unique service identifier (used for graph node ID) */
  name: string;

  /** Service directory path relative to project root */
  path: string;

  /**
   * Optional entry point file path relative to service path.
   * If omitted, auto-detected via resolveSourceEntrypoint() or package.json.main
   */
  entryPoint?: string;

  /**
   * Mark this service as customer-facing (REG-256).
   * Routes in customer-facing services are expected to have frontend consumers.
   * Unconnected routes in customer-facing services raise issue:connectivity warnings.
   * Non-customer-facing services don't raise issues for unconnected routes.
   *
   * Default: false (no issues for unconnected routes).
   */
  customerFacing?: boolean;
}
```

### Step 1.5: Update `packages/types/src/plugins.ts` — OrchestratorConfig

Add `routing` field to `OrchestratorConfig`. Insert after the existing `exclude?` field (line 204):

```typescript
  /**
   * Routing rules from config for cross-service URL mapping (REG-256).
   * Passed through to plugins via PluginContext.config.
   */
  routing?: import('./routing.js').RoutingRule[];
```

**Import note:** Use inline `import()` type to avoid adding a top-level import that would change the existing import structure. Alternatively, add at the top of plugins.ts:

```typescript
import type { RoutingRule } from './routing.js';
```

And then use `routing?: RoutingRule[];` in OrchestratorConfig. The top-level import approach is cleaner.

**Decision: top-level import.** Add `import type { RoutingRule } from './routing.js';` after the existing imports (line 3) in plugins.ts. Then use `routing?: RoutingRule[];` in OrchestratorConfig.

### Step 1.6: Update `packages/types/src/plugins.ts` — PluginContext

Add `resources` field to `PluginContext`. Insert after the existing `rootPrefix?` field (line 128):

```typescript
  /**
   * Resource registry for shared data between plugins (REG-256).
   * Plugins can read/write typed Resources through this registry.
   * Available in all phases. Created by Orchestrator at run start.
   */
  resources?: import('./resources.js').ResourceRegistry;
```

**Same import approach:** Add `import type { ResourceRegistry } from './resources.js';` at the top (line 3). Then use `resources?: ResourceRegistry;`.

### Step 1.7: Create `packages/core/src/core/ResourceRegistry.ts`

**New file.** ResourceRegistryImpl.

```typescript
// packages/core/src/core/ResourceRegistry.ts

import type { Resource, ResourceId, ResourceRegistry as IResourceRegistry } from '@grafema/types';

/**
 * In-memory Resource registry for a single pipeline run.
 * Created by Orchestrator at run start, cleared at run end.
 *
 * Thread safety: Not needed — Grafema runs plugins sequentially within
 * each phase. Multiple plugins in the same phase are toposorted and run
 * one at a time.
 */
export class ResourceRegistryImpl implements IResourceRegistry {
  private resources = new Map<ResourceId, Resource>();

  getOrCreate<T extends Resource>(id: ResourceId, factory: () => T): T {
    let resource = this.resources.get(id);
    if (!resource) {
      resource = factory();
      if (resource.id !== id) {
        throw new Error(
          `Resource factory returned resource with id "${resource.id}" but expected "${id}"`
        );
      }
      this.resources.set(id, resource);
    }
    return resource as T;
  }

  get<T extends Resource>(id: ResourceId): T | undefined {
    return this.resources.get(id) as T | undefined;
  }

  has(id: ResourceId): boolean {
    return this.resources.has(id);
  }

  /**
   * Clear all Resources. Called by Orchestrator at the end of a run.
   */
  clear(): void {
    this.resources.clear();
  }
}
```

### Step 1.8: Create `packages/core/src/resources/RoutingMapImpl.ts`

**New file.** Create the directory `packages/core/src/resources/` first.

```typescript
// packages/core/src/resources/RoutingMapImpl.ts

import type { RoutingMap, RoutingRule, MatchContext, MatchResult } from '@grafema/types';

/**
 * Default implementation of RoutingMap.
 *
 * Stores rules in an array, indexed by service pair for fast lookup.
 * For typical workloads (1-20 rules), linear scan is optimal.
 *
 * Complexity:
 * - addRule: O(r) where r = existing rules for the pair (dedup check)
 * - findMatch: O(p * r) where p = service pairs from `fromService`, r = rules per pair
 * - findRulesForPair: O(1) map lookup + O(r) copy
 */
export class RoutingMapImpl implements RoutingMap {
  readonly id = 'routing:map' as const;

  /** Rules indexed by "from:to" key for O(1) lookup by service pair */
  private rulesByPair = new Map<string, RoutingRule[]>();
  /** All rules in insertion order */
  private allRules: RoutingRule[] = [];

  private pairKey(from: string, to: string): string {
    return `${from}:${to}`;
  }

  addRule(rule: RoutingRule): void {
    const key = this.pairKey(rule.from, rule.to);
    let rules = this.rulesByPair.get(key);
    if (!rules) {
      rules = [];
      this.rulesByPair.set(key, rules);
    }

    // Deduplicate: skip if identical rule already exists
    const isDuplicate = rules.some(
      r => r.stripPrefix === rule.stripPrefix && r.addPrefix === rule.addPrefix
    );
    if (!isDuplicate) {
      rules.push(rule);
      this.allRules.push(rule);
    }
  }

  addRules(rules: RoutingRule[]): void {
    for (const rule of rules) {
      this.addRule(rule);
    }
  }

  findMatch(context: MatchContext): MatchResult | null {
    // Try all target services that have rules from this source service
    for (const [key, rules] of this.rulesByPair.entries()) {
      if (!key.startsWith(context.fromService + ':')) continue;

      // Sort candidates: longer stripPrefix first, then by priority
      const sorted = [...rules].sort((a, b) => {
        const aLen = a.stripPrefix?.length ?? 0;
        const bLen = b.stripPrefix?.length ?? 0;
        if (aLen !== bLen) return bLen - aLen; // longer prefix first
        return (a.priority ?? 0) - (b.priority ?? 0); // lower priority number first
      });

      for (const rule of sorted) {
        const transformed = this.applyRule(context.requestUrl, rule);
        if (transformed !== null) {
          return {
            transformedUrl: transformed,
            targetService: rule.to,
            rule,
          };
        }
      }
    }

    return null;
  }

  findRulesForPair(fromService: string, toService: string): RoutingRule[] {
    return this.rulesByPair.get(this.pairKey(fromService, toService)) ?? [];
  }

  getAllRules(): RoutingRule[] {
    return [...this.allRules];
  }

  get ruleCount(): number {
    return this.allRules.length;
  }

  /**
   * Apply a routing rule to transform a URL.
   * Returns transformed URL, or null if the rule's stripPrefix doesn't match.
   */
  private applyRule(url: string, rule: RoutingRule): string | null {
    let result = url;

    // Strip prefix
    if (rule.stripPrefix) {
      if (!result.startsWith(rule.stripPrefix)) {
        return null; // Rule doesn't apply — prefix doesn't match
      }
      const afterPrefix = result.slice(rule.stripPrefix.length);
      // Verify prefix boundary: next char must be '/' or end of string
      if (afterPrefix !== '' && !afterPrefix.startsWith('/')) {
        return null; // Partial prefix match (e.g., /api doesn't strip from /api-v2)
      }
      result = afterPrefix || '/';
    }

    // Add prefix
    if (rule.addPrefix) {
      if (result.startsWith('/') && rule.addPrefix.endsWith('/')) {
        result = rule.addPrefix + result.slice(1);
      } else {
        result = rule.addPrefix + result;
      }
    }

    return result;
  }
}

/** Factory function for creating a RoutingMap Resource */
export function createRoutingMap(): RoutingMapImpl {
  return new RoutingMapImpl();
}
```

### Step 1.9: Write tests — `test/unit/core/ResourceRegistry.test.ts`

**New file.** Create `test/unit/core/` directory if it doesn't exist.

Test cases:

```
describe('ResourceRegistryImpl')
  describe('getOrCreate')
    it('should create a resource using factory on first access')
    it('should return existing resource on subsequent access (factory ignored)')
    it('should throw if factory returns resource with wrong id')
    it('should handle multiple resources with different ids')
  describe('get')
    it('should return undefined for non-existent resource')
    it('should return resource after it was created via getOrCreate')
  describe('has')
    it('should return false for non-existent resource')
    it('should return true for existing resource')
  describe('clear')
    it('should remove all resources')
    it('should allow re-creation after clear')
```

**Test infrastructure:** These are pure unit tests. No mock graph needed. Use `node:test` + `node:assert`. Import from `@grafema/core` (the tests run against dist/).

**Important pattern note:** Tests in this codebase use `import { ... } from '@grafema/core'` for built code. Follow this pattern.

### Step 1.10: Write tests — `test/unit/resources/RoutingMapImpl.test.ts`

**New file.** Create `test/unit/resources/` directory.

Test cases:

```
describe('RoutingMapImpl')
  describe('addRule / ruleCount')
    it('should add a rule and increment count')
    it('should deduplicate identical rules (same from/to/stripPrefix/addPrefix)')
    it('should NOT deduplicate rules with different stripPrefix')
  describe('addRules')
    it('should add multiple rules at once')
  describe('findRulesForPair')
    it('should return rules for specific from/to pair')
    it('should return empty array for non-existent pair')
  describe('findMatch')
    describe('stripPrefix')
      it('should strip prefix and return transformed URL')
      it('should return null if prefix does not match')
      it('should not strip partial prefix match (/api should not strip /api-v2)')
      it('should handle stripPrefix resulting in root /')
    describe('addPrefix')
      it('should add prefix to URL')
      it('should handle double-slash prevention (addPrefix ends with /, url starts with /)')
    describe('combined stripPrefix + addPrefix')
      it('should strip then add prefix')
    describe('priority')
      it('should prefer longer stripPrefix over shorter')
      it('should prefer lower priority number when stripPrefix length is equal')
    describe('no routing rules')
      it('should return null when no rules exist')
      it('should return null when no rules match the fromService')
  describe('getAllRules')
    it('should return copy of all rules')
  describe('multiple service pairs')
    it('should handle rules for different service pairs independently')
```

### Step 1.11: Build and test

```bash
pnpm build
node --test test/unit/core/ResourceRegistry.test.ts
node --test test/unit/resources/RoutingMapImpl.test.ts
```

---

## Phase 2: Config Changes (validation, plumbing)

### Step 2.1: Update `packages/core/src/config/ConfigLoader.ts` — GrafemaConfig

Add `routing` field to `GrafemaConfig` interface. Insert after `exclude?` (line 73):

```typescript
  /**
   * Routing rules for cross-service URL mapping (REG-256).
   * Describes how infrastructure (nginx, gateway) transforms URLs between services.
   *
   * @example
   * ```yaml
   * routing:
   *   - from: frontend
   *     to: backend
   *     stripPrefix: /api
   *   - from: frontend
   *     to: auth-service
   *     stripPrefix: /auth
   * ```
   */
  routing?: RoutingRule[];
```

Add import at the top of ConfigLoader.ts:

```typescript
import type { ServiceDefinition, RoutingRule } from '@grafema/types';
```

**Note:** Currently the file imports only `ServiceDefinition` from `@grafema/types`. Change to also import `RoutingRule`.

### Step 2.2: Add `validateRouting()` to ConfigLoader.ts

Add new exported function after `validateWorkspace()` (after line 451):

```typescript
/**
 * Validate routing rules structure (REG-256).
 * THROWS on error (fail loudly per project convention).
 *
 * Validation rules:
 * 1. Must be an array if provided
 * 2. Each rule must have 'from' and 'to' as non-empty strings
 * 3. 'stripPrefix' must start with '/' if provided
 * 4. 'addPrefix' must start with '/' if provided
 * 5. 'from' and 'to' must reference services defined in the services array
 *
 * @param routing - Parsed routing rules (may be undefined)
 * @param services - Parsed services array (for cross-validation)
 */
export function validateRouting(routing: unknown, services: ServiceDefinition[]): void {
  if (routing === undefined || routing === null) return;

  if (!Array.isArray(routing)) {
    throw new Error(`Config error: routing must be an array, got ${typeof routing}`);
  }

  const serviceNames = new Set(services.map(s => s.name));

  for (let i = 0; i < routing.length; i++) {
    const rule = routing[i];

    if (typeof rule !== 'object' || rule === null) {
      throw new Error(`Config error: routing[${i}] must be an object`);
    }

    // from — required
    if (typeof rule.from !== 'string' || !rule.from.trim()) {
      throw new Error(`Config error: routing[${i}].from must be a non-empty string`);
    }

    // to — required
    if (typeof rule.to !== 'string' || !rule.to.trim()) {
      throw new Error(`Config error: routing[${i}].to must be a non-empty string`);
    }

    // Cross-validate against services (only if services are defined)
    if (serviceNames.size > 0) {
      if (!serviceNames.has(rule.from)) {
        throw new Error(
          `Config error: routing[${i}].from "${rule.from}" does not match any service name. ` +
          `Available: ${[...serviceNames].join(', ')}`
        );
      }
      if (!serviceNames.has(rule.to)) {
        throw new Error(
          `Config error: routing[${i}].to "${rule.to}" does not match any service name. ` +
          `Available: ${[...serviceNames].join(', ')}`
        );
      }
    }

    // stripPrefix — optional, must start with /
    if (rule.stripPrefix !== undefined) {
      if (typeof rule.stripPrefix !== 'string') {
        throw new Error(`Config error: routing[${i}].stripPrefix must be a string`);
      }
      if (!rule.stripPrefix.startsWith('/')) {
        throw new Error(`Config error: routing[${i}].stripPrefix must start with '/'`);
      }
    }

    // addPrefix — optional, must start with /
    if (rule.addPrefix !== undefined) {
      if (typeof rule.addPrefix !== 'string') {
        throw new Error(`Config error: routing[${i}].addPrefix must be a string`);
      }
      if (!rule.addPrefix.startsWith('/')) {
        throw new Error(`Config error: routing[${i}].addPrefix must start with '/'`);
      }
    }
  }
}
```

### Step 2.3: Update `validateServices()` to validate `customerFacing`

Add validation for `customerFacing` inside the existing for-loop in `validateServices()`, after the `entryPoint` validation block (after line 371):

```typescript
    // customerFacing validation (optional field) - must be boolean if provided (REG-256)
    if (svc.customerFacing !== undefined) {
      if (typeof svc.customerFacing !== 'boolean') {
        throw new Error(`Config error: services[${i}].customerFacing must be a boolean, got ${typeof svc.customerFacing}`);
      }
    }
```

### Step 2.4: Update `loadConfig()` to call `validateRouting()`

In the YAML loading branch, after the `validateWorkspace()` call (line 222), add:

```typescript
    // Validate routing rules if present (THROWS on error) - REG-256
    validateRouting(parsed.routing, (parsed.services || []) as ServiceDefinition[]);
```

In the JSON loading branch, after the `validateWorkspace()` call (line 255), add the same:

```typescript
    // Validate routing rules if present (THROWS on error) - REG-256
    validateRouting(parsed.routing, (parsed.services || []) as ServiceDefinition[]);
```

### Step 2.5: Update `mergeConfig()` to pass through `routing`

In the `mergeConfig()` function's return object (line 514-533), add after the `workspace` line:

```typescript
    // Routing rules: pass through if specified (REG-256)
    routing: user.routing ?? undefined,
```

### Step 2.6: Export from `packages/core/src/config/index.ts`

Add `validateRouting` to the export list:

```typescript
export {
  loadConfig,
  DEFAULT_CONFIG,
  validateVersion,
  validateServices,
  validatePatterns,
  validateWorkspace,
  validateRouting,  // REG-256
} from './ConfigLoader.js';
```

### Step 2.7: Export from `packages/core/src/index.ts`

Add to the Config exports section (around line 37-45):

```typescript
export {
  loadConfig,
  DEFAULT_CONFIG,
  validateVersion,
  validateServices,
  validatePatterns,
  validateWorkspace,
  validateRouting,  // REG-256
} from './config/index.js';
```

### Step 2.8: Extend ConfigLoader tests

Add tests to `test/unit/config/ConfigLoader.test.ts`. Append new `describe` blocks:

```
describe('validateRouting (REG-256)')
  it('should accept undefined/null routing')
  it('should reject non-array routing')
  it('should reject rule without from')
  it('should reject rule without to')
  it('should reject stripPrefix not starting with /')
  it('should reject addPrefix not starting with /')
  it('should reject from referencing non-existent service')
  it('should reject to referencing non-existent service')
  it('should accept valid routing rules')
  it('should accept routing with empty services array (skip cross-validation)')

describe('customerFacing validation (REG-256)')
  it('should accept boolean customerFacing on service')
  it('should reject non-boolean customerFacing')
  it('should accept service without customerFacing (optional)')

describe('routing in mergeConfig (REG-256)')
  it('should pass through routing from user config')
  it('should default to undefined when not specified')
```

**Import note for tests:** Import `validateRouting` from `@grafema/core`.

### Step 2.9: Build and test

```bash
pnpm build
node --test test/unit/config/ConfigLoader.test.ts
```

---

## Phase 3: Orchestrator Integration

### Step 3.1: Update `packages/core/src/Orchestrator.ts`

**3.1a: Add imports.**

Add at the top of the file (line ~16):

```typescript
import { ResourceRegistryImpl } from './core/ResourceRegistry.js';
```

Add to the `@grafema/types` import (line 19):

```typescript
import type { GraphBackend, PluginPhase, Logger, LogLevel, IssueSpec, ServiceDefinition, FieldDeclaration, NodeRecord, RoutingRule } from '@grafema/types';
```

**3.1b: Add `routing` to OrchestratorOptions.**

Add after `workspaceRoots?` (line 84):

```typescript
  /**
   * Routing rules from config (REG-256).
   * Passed through to plugins via PluginContext.config.routing.
   */
  routing?: RoutingRule[];
```

**3.1c: Add private fields to Orchestrator class.**

Add after the `suppressedByIgnoreCount` field (line 176):

```typescript
  /** Resource registry for inter-plugin communication (REG-256) */
  private resourceRegistry = new ResourceRegistryImpl();
  /** Routing rules from config (REG-256) */
  private routing: RoutingRule[] | undefined;
```

**3.1d: Store routing in constructor.**

Add in constructor, after `this.workspaceRoots = options.workspaceRoots;` (line 209):

```typescript
    // Routing rules from config (REG-256)
    this.routing = options.routing;
```

**3.1e: Clear resources at the start of `run()`.**

In `run()`, after `this.suppressedByIgnoreCount = 0;` (line 313):

```typescript
    // REG-256: Reset resource registry for each run
    this.resourceRegistry.clear();
```

**3.1f: Pass resources to `runPhase()` context for ENRICHMENT and VALIDATION.**

In `run()`, update the ENRICHMENT phase call (line 547):

```typescript
    await this.runPhase('ENRICHMENT', { manifest, graph: this.graph, workerCount: this.workerCount });
```

becomes:

```typescript
    await this.runPhase('ENRICHMENT', {
      manifest,
      graph: this.graph,
      workerCount: this.workerCount,
    });
```

No change needed here because we'll pass resources via `runPhase()` itself (see 3.1g).

**3.1g: Update `runPhase()` to include resources and routing in PluginContext.**

In `runPhase()` method, where the `pluginContext` is built (line 1005-1013), add `resources` and include `routing` in config:

```typescript
      const pluginContext: PluginContext = {
        ...context,
        onProgress: this.onProgress as unknown as PluginContext['onProgress'],
        forceAnalysis: this.forceAnalysis,
        logger: this.logger,
        strictMode: this.strictMode,
        rootPrefix: (context as { rootPrefix?: string }).rootPrefix,
        resources: this.resourceRegistry,  // REG-256
      };
```

Now we need to ensure `routing` is accessible via `pluginContext.config`. The current `context.config` comes from whichever `runPhase()` caller passes it. For ENRICHMENT and VALIDATION, `context` doesn't include `config` currently.

Looking at how config flows:
- `this.config` on Orchestrator stores the full `OrchestratorOptions`
- ENRICHMENT phase call doesn't pass `config` in context (line 547)
- Plugins access `context.config` which is typed as `OrchestratorConfig` in the types

We need to ensure `config` is always available in the PluginContext. Add it in `runPhase()`:

```typescript
      const pluginContext: PluginContext = {
        ...context,
        config: {
          ...((context as Record<string, unknown>).config as Record<string, unknown> ?? {}),
          projectPath: (context as { manifest?: { projectPath?: string } }).manifest?.projectPath ?? '',
          services: this.configServices,
          routing: this.routing,  // REG-256
        } as unknown as PluginContext['config'],
        onProgress: this.onProgress as unknown as PluginContext['onProgress'],
        forceAnalysis: this.forceAnalysis,
        logger: this.logger,
        strictMode: this.strictMode,
        rootPrefix: (context as { rootPrefix?: string }).rootPrefix,
        resources: this.resourceRegistry,  // REG-256
      };
```

**Wait — this is getting complex.** Let me check how `context.config` is currently used.

Looking at the Orchestrator code:
- `context` passed to `runPhase()` is `Partial<PluginContext> & { graph }`
- The ENRICHMENT call (line 547) passes `{ manifest, graph: this.graph, workerCount: this.workerCount }` — no `config` field
- The `this.config` property stores `OrchestratorOptions` (not `OrchestratorConfig`)

The current HTTPConnectionEnricher doesn't use `context.config` at all. But our ConfigRoutingMapBuilder needs it.

**Simplest correct approach:** Add `config` to the `runPhase` calls for ENRICHMENT and VALIDATION phases, building it from the stored options. In `runPhase()`:

After building `pluginContext`, before the `if (phaseName === 'VALIDATION')` block, add:

```typescript
      // Ensure config is available for all plugins (REG-256)
      if (!pluginContext.config) {
        pluginContext.config = {
          projectPath: (context as { manifest?: { projectPath?: string } }).manifest?.projectPath ?? '',
          services: this.configServices,
          routing: this.routing,
        };
      } else {
        // Merge routing into existing config
        const cfg = pluginContext.config as Record<string, unknown>;
        if (this.routing && !cfg.routing) {
          cfg.routing = this.routing;
        }
        if (this.configServices && !cfg.services) {
          cfg.services = this.configServices;
        }
      }
```

**Actually, even simpler.** Let's just ensure config is always set when building pluginContext:

```typescript
      const pluginContext: PluginContext = {
        ...context,
        onProgress: this.onProgress as unknown as PluginContext['onProgress'],
        forceAnalysis: this.forceAnalysis,
        logger: this.logger,
        strictMode: this.strictMode,
        rootPrefix: (context as { rootPrefix?: string }).rootPrefix,
        resources: this.resourceRegistry,  // REG-256
        config: {
          ...((context as Partial<PluginContext>).config ?? {}),
          projectPath: (context as { manifest?: { projectPath?: string } }).manifest?.projectPath ?? (context as Partial<PluginContext>).config?.projectPath ?? '',
          services: this.configServices,
          routing: this.routing,
        } as PluginContext['config'],
      };
```

**Rob: please check what `context.config` currently contains for different phases.** If it's always undefined for ENRICHMENT/VALIDATION, the simpler approach is fine. If it's sometimes set by callers, preserve the existing values and only add routing/services.

**3.1h: Also update `runMultiRoot()` ENRICHMENT and VALIDATION calls.**

Same pattern — ensure resources and routing are available. The `runMultiRoot()` method calls `this.runPhase('ENRICHMENT', ...)` and `this.runPhase('VALIDATION', ...)` on lines 719-745. No changes needed there since `runPhase()` now adds `resources` and `config` automatically.

**3.1i: Clear resources at the end of `run()`.**

At the end of `run()`, before `return manifest;` (line 582):

```typescript
    // REG-256: Clear resources after run
    this.resourceRegistry.clear();
```

Same for `runMultiRoot()`, before `return unifiedManifest;` (line 760).

### Step 3.2: Build and test

```bash
pnpm build
node --test --test-concurrency=1 'test/unit/*.test.js'  # Run full suite to verify no regression
```

---

## Phase 4: ConfigRoutingMapBuilder

### Step 4.1: Create `packages/core/src/plugins/enrichment/ConfigRoutingMapBuilder.ts`

**New file.**

```typescript
// packages/core/src/plugins/enrichment/ConfigRoutingMapBuilder.ts

/**
 * ConfigRoutingMapBuilder — reads routing rules from config and writes
 * them to the RoutingMap Resource (REG-256).
 *
 * This is the first RoutingMapBuilder. Future builders will read from
 * nginx.conf, k8s manifests, etc. All write to the same RoutingMap.
 *
 * Phase: ENRICHMENT (early, before ServiceConnectionEnricher)
 * Dependencies: none (reads from config, not from graph)
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { RoutingRule, OrchestratorConfig } from '@grafema/types';
import { ROUTING_MAP_RESOURCE_ID } from '@grafema/types';
import { createRoutingMap } from '../../resources/RoutingMapImpl.js';

export class ConfigRoutingMapBuilder extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ConfigRoutingMapBuilder',
      phase: 'ENRICHMENT',
      creates: { nodes: [], edges: [] },
      dependencies: [],
      consumes: [],
      produces: [],
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);

    // Read routing rules from config
    const config = context.config as OrchestratorConfig & { routing?: RoutingRule[] };
    const routing = config?.routing;

    if (!routing || routing.length === 0) {
      logger.debug('No routing rules in config');
      return createSuccessResult({ nodes: 0, edges: 0 }, { rulesLoaded: 0 });
    }

    // Get ResourceRegistry
    const resources = context.resources;
    if (!resources) {
      logger.warn('ResourceRegistry not available — skipping routing rules');
      return createSuccessResult({ nodes: 0, edges: 0 }, { rulesLoaded: 0 });
    }

    // Get or create RoutingMap Resource
    const routingMap = resources.getOrCreate(ROUTING_MAP_RESOURCE_ID, createRoutingMap);

    // Add rules with source attribution
    const rulesWithSource: RoutingRule[] = routing.map(rule => ({
      ...rule,
      source: rule.source ?? 'config',
    }));

    routingMap.addRules(rulesWithSource);

    logger.info('Loaded routing rules from config', {
      count: routing.length,
      pairs: [...new Set(routing.map(r => `${r.from} -> ${r.to}`))],
    });

    return createSuccessResult({ nodes: 0, edges: 0 }, { rulesLoaded: routing.length });
  }
}
```

### Step 4.2: Write tests — `test/unit/plugins/enrichment/ConfigRoutingMapBuilder.test.ts`

**New file.**

Test infrastructure: Use a minimal mock that provides `context.config` with `routing` and `context.resources` as a real `ResourceRegistryImpl` instance.

```
describe('ConfigRoutingMapBuilder')
  it('should load routing rules from config into RoutingMap resource')
  it('should return rulesLoaded=0 when no routing rules in config')
  it('should return rulesLoaded=0 when config is undefined')
  it('should skip gracefully when ResourceRegistry is not available')
  it('should set source to "config" on rules without explicit source')
  it('should preserve existing source on rules that have one')
  it('should handle multiple routing rules')
  it('should create RoutingMap resource if it does not exist')
  it('should add to existing RoutingMap resource if it already exists')
```

**Test setup pattern:**

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ConfigRoutingMapBuilder } from '@grafema/core';
// NOTE: ResourceRegistryImpl is internal, not exported.
// Import from dist directly or use a simple in-test registry.

// Option A: Create a simple test ResourceRegistry
class TestResourceRegistry {
  private resources = new Map();
  getOrCreate(id, factory) {
    if (!this.resources.has(id)) {
      this.resources.set(id, factory());
    }
    return this.resources.get(id);
  }
  get(id) { return this.resources.get(id); }
  has(id) { return this.resources.has(id); }
}
```

**Rob/Kent decision:** The `ResourceRegistryImpl` is not exported from `@grafema/core`. Two options:
1. Export it from `packages/core/src/index.ts` (recommended — tests need it, and it's part of the public API)
2. Use an in-test implementation (simpler but duplicates logic)

**Decision: Export ResourceRegistryImpl.** Add to `packages/core/src/index.ts`:

```typescript
// Resource system (REG-256)
export { ResourceRegistryImpl } from './core/ResourceRegistry.js';
```

Also export `createRoutingMap` and `RoutingMapImpl`:

```typescript
export { RoutingMapImpl, createRoutingMap } from './resources/RoutingMapImpl.js';
```

### Step 4.3: Register in BUILTIN_PLUGINS and DEFAULT_CONFIG

**`packages/cli/src/commands/analyze.ts`:**

Add import (alphabetical within Enrichment section):

```typescript
import {
  // ... existing imports ...
  // Enrichment
  // ... existing ...
  ConfigRoutingMapBuilder,  // REG-256
  // ... rest ...
} from '@grafema/core';
```

Add to `BUILTIN_PLUGINS` map (in Enrichment section):

```typescript
  ConfigRoutingMapBuilder: () => new ConfigRoutingMapBuilder() as Plugin,
```

**`packages/mcp/src/config.ts`:**

Add import:

```typescript
import {
  // ... existing ...
  ConfigRoutingMapBuilder,
  // ... rest ...
} from '@grafema/core';
```

Add to `BUILTIN_PLUGINS`:

```typescript
  ConfigRoutingMapBuilder: () => new ConfigRoutingMapBuilder(),
```

**`packages/mcp/src/analysis-worker.ts`:**

Add import:

```typescript
import {
  // ... existing ...
  ConfigRoutingMapBuilder,
  // ... rest ...
} from '@grafema/core';
```

**`packages/core/src/config/ConfigLoader.ts` — DEFAULT_CONFIG:**

Add `ConfigRoutingMapBuilder` to the enrichment array, BEFORE `HTTPConnectionEnricher` (line 144):

```typescript
    enrichment: [
      'MethodCallResolver',
      'ArgumentParameterLinker',
      'AliasTracker',
      'ClosureCaptureEnricher',
      'RejectionPropagationEnricher',
      'ValueDomainAnalyzer',
      'MountPointResolver',
      'ExpressHandlerLinker',
      'PrefixEvaluator',
      'ImportExportLinker',
      'ConfigRoutingMapBuilder',   // REG-256: Must run before ServiceConnectionEnricher
      'HTTPConnectionEnricher',
      'CallbackCallResolver',
    ],
```

**Note:** We're adding ConfigRoutingMapBuilder but NOT yet replacing HTTPConnectionEnricher. That happens in Phase 5.

### Step 4.4: Export from core/index.ts

```typescript
export { ConfigRoutingMapBuilder } from './plugins/enrichment/ConfigRoutingMapBuilder.js';
```

### Step 4.5: Build and test

```bash
pnpm build
node --test test/unit/plugins/enrichment/ConfigRoutingMapBuilder.test.ts
node --test test/unit/core/ResourceRegistry.test.ts
node --test test/unit/resources/RoutingMapImpl.test.ts
```

---

## Phase 5: ServiceConnectionEnricher (core logic)

### Step 5.1: Create `packages/core/src/plugins/enrichment/ServiceConnectionEnricher.ts`

**New file.** This is the largest new file (~300 LOC). The plugin replaces HTTPConnectionEnricher's matching logic and adds:
1. Service ownership resolution (which service owns which file)
2. RoutingMap integration (URL transformation before matching)
3. `customerFacing` metadata marking on route nodes

```typescript
// packages/core/src/plugins/enrichment/ServiceConnectionEnricher.ts

/**
 * ServiceConnectionEnricher — connects http:request to http:route nodes
 * with cross-service routing support (REG-256).
 *
 * Replaces HTTPConnectionEnricher with:
 * 1. Service-aware matching (uses SERVICE nodes to determine ownership)
 * 2. RoutingMap URL transformation (stripPrefix/addPrefix before matching)
 * 3. customerFacing metadata (marks routes in customer-facing services)
 *
 * Falls back to direct path matching when no RoutingMap exists (backward compat).
 *
 * Phase: ENRICHMENT
 * Dependencies: ExpressRouteAnalyzer, FetchAnalyzer, ExpressResponseAnalyzer,
 *               MountPointResolver, ConfigRoutingMapBuilder
 */

import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord, ServiceDefinition, RoutingMap, OrchestratorConfig, RoutingRule } from '@grafema/types';
import { ROUTING_MAP_RESOURCE_ID } from '@grafema/types';
import { StrictModeError, ValidationError } from '../../errors/GrafemaError.js';
```

**Key internal types** (same as HTTPConnectionEnricher):

```typescript
interface HTTPRouteNode extends BaseNodeRecord {
  method?: string;
  path?: string;
  fullPath?: string;
  url?: string;
  customerFacing?: boolean;
}

interface HTTPRequestNode extends BaseNodeRecord {
  method?: string;
  methodSource?: MethodSource;
  url?: string;
  responseDataNode?: string;
}

type MethodSource = 'explicit' | 'default' | 'unknown';

interface ServiceEntry {
  name: string;
  path: string;
}
```

**Plugin class:**

```typescript
export class ServiceConnectionEnricher extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ServiceConnectionEnricher',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],
        edges: ['INTERACTS_WITH', 'HTTP_RECEIVES'],
      },
      dependencies: [
        'ExpressRouteAnalyzer',
        'FetchAnalyzer',
        'ExpressResponseAnalyzer',
        'MountPointResolver',
        'ConfigRoutingMapBuilder',
      ],
      consumes: ['RESPONDS_WITH'],
      produces: ['INTERACTS_WITH', 'HTTP_RECEIVES'],
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);

    try {
      // 1. Build service ownership map from SERVICE nodes
      const serviceMap = await this.buildServiceMap(graph);
      logger.debug('Service map built', { services: serviceMap.length });

      // 2. Get RoutingMap from ResourceRegistry (may not exist)
      const routingMap = context.resources?.get<RoutingMap>(ROUTING_MAP_RESOURCE_ID) ?? null;
      if (routingMap) {
        logger.info('RoutingMap available', { rules: routingMap.ruleCount });
      }

      // 3. Mark customerFacing on route nodes
      const config = context.config as OrchestratorConfig & { routing?: RoutingRule[] };
      const services = (config?.services ?? []) as ServiceDefinition[];
      // ... (see full implementation below)

      // 4-9. Collect nodes, match, create edges (same as HTTPConnectionEnricher)
      // ... (port all matching logic from HTTPConnectionEnricher)

    } catch (error) {
      logger.error('Error in ServiceConnectionEnricher', { error });
      return createErrorResult(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
```

**Full execute() method — port from HTTPConnectionEnricher + additions:**

The `execute()` method must:

1. Build service ownership map (call `buildServiceMap()`)
2. Get RoutingMap from resources (optional)
3. Read `services` from config, mark `customerFacing` on route nodes
4. Collect all `http:route` and `http:request` nodes
5. Deduplicate by ID
6. For each request:
   - Determine owning service via file path
   - For each route:
     - Determine owning service via file path
     - If both services known AND routingMap exists, apply URL transformation
     - Match (possibly transformed) URL against route path
     - Create INTERACTS_WITH edge
     - Create HTTP_RECEIVES edges if responseDataNode exists
7. Handle unknown methods (same as HTTPConnectionEnricher)
8. Return result

**Critical: All existing HTTPConnectionEnricher logic for path matching, method handling, methodSource, deduplication, HTTP_RECEIVES, and strict mode errors MUST be preserved exactly.** Copy the private methods verbatim:
- `normalizeUrl()`
- `hasParamsNormalized()`
- `pathsMatch()`
- `escapeRegExp()`
- `buildParamRegex()`
- `hasParams()`
- `deduplicateById()`

**New methods to add:**

```typescript
  /**
   * Build service ownership map from SERVICE nodes in the graph.
   * Returns entries sorted by path length descending (most specific first).
   *
   * Complexity: O(s) where s = SERVICE nodes (typically 2-5)
   */
  private async buildServiceMap(graph: PluginContext['graph']): Promise<ServiceEntry[]> {
    const entries: ServiceEntry[] = [];
    for await (const node of graph.queryNodes({ type: 'SERVICE' })) {
      if (node.file && node.name) {
        entries.push({ name: node.name as string, path: node.file as string });
      }
    }
    entries.sort((a, b) => b.path.length - a.path.length);
    return entries;
  }

  /**
   * Find which service owns a file path.
   * Uses longest-prefix match against service paths.
   *
   * Complexity: O(s) where s = service count (typically 2-5)
   */
  private getServiceForFile(filePath: string, serviceMap: ServiceEntry[]): string | undefined {
    for (const entry of serviceMap) {
      if (filePath.startsWith(entry.path)) {
        return entry.name;
      }
    }
    return undefined;
  }

  /**
   * Mark route nodes as customerFacing based on service configuration.
   * Only marks routes whose owning service has customerFacing: true.
   *
   * Complexity: O(routes * services) — typically O(routes * 2..5)
   */
  private async markCustomerFacingRoutes(
    graph: PluginContext['graph'],
    routes: HTTPRouteNode[],
    serviceMap: ServiceEntry[],
    services: ServiceDefinition[],
    logger: ReturnType<typeof this.log>
  ): Promise<number> {
    const cfServices = new Set(
      services.filter(s => s.customerFacing).map(s => s.name)
    );

    if (cfServices.size === 0) return 0;

    let count = 0;
    for (const route of routes) {
      if (!route.file) continue;
      const serviceName = this.getServiceForFile(route.file, serviceMap);
      if (serviceName && cfServices.has(serviceName)) {
        await graph.addNode({
          ...route,
          customerFacing: true,
        });
        count++;
      }
    }

    if (count > 0) {
      logger.info('Marked customer-facing routes', { count });
    }
    return count;
  }

  /**
   * Try to transform a URL using routing rules for a service pair.
   * Returns the transformed URL, or the original URL if no rule applies.
   */
  private transformUrl(
    url: string,
    requestService: string | undefined,
    routeService: string | undefined,
    routingMap: RoutingMap | null
  ): string {
    if (!requestService || !routeService || !routingMap) return url;

    const match = routingMap.findMatch({
      fromService: requestService,
      requestUrl: url,
    });

    if (match && match.targetService === routeService) {
      return match.transformedUrl;
    }

    return url;
  }
```

**The matching loop (modified from HTTPConnectionEnricher):**

```typescript
      // For each request, find matching route
      for (const request of uniqueRequests) {
        const methodSource = request.methodSource ?? 'explicit';
        const method = request.method ? request.method.toUpperCase() : null;
        const url = request.url;

        if (methodSource === 'unknown') {
          // ... same strict/warning handling as HTTPConnectionEnricher ...
          continue;
        }

        if (url === 'dynamic' || !url) continue;

        // Determine request's owning service
        const requestService = request.file
          ? this.getServiceForFile(request.file, serviceMap)
          : undefined;

        for (const route of uniqueRoutes) {
          const routeMethod = route.method ? route.method.toUpperCase() : null;
          const routePath = route.fullPath || route.path;

          if (!routeMethod) continue;
          if (methodSource === 'default' && routeMethod !== 'GET') continue;
          if (methodSource === 'explicit' && (!method || method !== routeMethod)) continue;

          // Determine route's owning service
          const routeService = route.file
            ? this.getServiceForFile(route.file, serviceMap)
            : undefined;

          // Apply URL transformation if routing rules exist
          const urlToMatch = this.transformUrl(url, requestService, routeService, routingMap);

          if (routePath && this.pathsMatch(urlToMatch, routePath)) {
            // Create INTERACTS_WITH edge
            await graph.addEdge({
              type: 'INTERACTS_WITH',
              src: request.id,
              dst: route.id,
              matchType: this.hasParams(routePath) ? 'parametric' : 'exact'
            });
            edgesCreated++;

            // Create HTTP_RECEIVES edges (same as HTTPConnectionEnricher)
            const responseDataNode = request.responseDataNode;
            if (responseDataNode) {
              const respondsWithEdges = await graph.getOutgoingEdges(route.id, ['RESPONDS_WITH']);
              for (const respEdge of respondsWithEdges) {
                await graph.addEdge({
                  type: 'HTTP_RECEIVES',
                  src: responseDataNode,
                  dst: respEdge.dst,
                  metadata: {
                    method: request.method,
                    path: request.url,
                    viaRequest: request.id,
                    viaRoute: route.id
                  }
                });
                edgesCreated++;
              }
            }

            connections.push({
              request: `${method ?? 'UNKNOWN'} ${url}`,
              route: `${routeMethod} ${routePath}`,
              requestFile: request.file,
              routeFile: route.file,
              transformed: urlToMatch !== url ? urlToMatch : undefined,
            });

            break; // One request -> one route
          }
        }
      }
```

### Step 5.2: Write tests — `test/unit/plugins/enrichment/ServiceConnectionEnricher.test.ts`

**New file.** This is the largest test file (~400 LOC).

**Test structure — port ALL existing HTTPConnectionEnricher tests:**

```
describe('ServiceConnectionEnricher')
  describe('Basic matching (ported from HTTPConnectionEnricher)')
    it('should match request to route using fullPath')
    it('should NOT match when using only path (without fullPath)')
    it('should use path when fullPath not set (unmounted route)')
    it('should match through nested mounts (/api/v1/users)')
    it('should match parametric route with fullPath')
    it('should treat dots in routes as literal characters')
    it('should NOT match different methods')
    it('should be case insensitive for methods')
    it('should match default GET only when route is GET')
    it('should skip matching when method is unknown')
    it('should skip dynamic URLs')
    it('should skip requests without url')
    it('should skip routes without path')

  describe('HTTP_RECEIVES edges (ported)')
    it('should create HTTP_RECEIVES edge when both responseDataNode and RESPONDS_WITH exist')
    it('should NOT create HTTP_RECEIVES when responseDataNode is missing')
    it('should NOT create HTTP_RECEIVES when RESPONDS_WITH is missing')
    it('should create multiple HTTP_RECEIVES for multiple RESPONDS_WITH edges')
    it('should include HTTP context in edge metadata')

  describe('Template literal matching (ported)')
    it('should match template literal ${...} to :param')
    it('should match named template literal ${userId} to :id')
    it('should match paths with multiple params')
    it('should match concrete value to :param')
    it('should NOT match different base paths')

  describe('Routing transformation (NEW)')
    it('should transform URL using stripPrefix before matching')
    it('should transform URL using addPrefix')
    it('should transform URL using stripPrefix + addPrefix')
    it('should fall back to direct matching when no routing rules exist')
    it('should fall back to direct matching when services are not determined')
    it('should not transform when rule does not match service pair')

  describe('Service ownership (NEW)')
    it('should determine service from file path using SERVICE nodes')
    it('should handle routes without file path')
    it('should use longest prefix match for nested service paths')

  describe('customerFacing marking (NEW)')
    it('should mark routes as customerFacing when service has customerFacing: true')
    it('should NOT mark routes when service has customerFacing: false/undefined')
    it('should handle routes not belonging to any service')

  describe('Unknown method handling (ported)')
    it('should emit warning for unknown method in non-strict mode')
    it('should emit StrictModeError in strict mode')

  describe('Backward compatibility')
    it('should work identically to HTTPConnectionEnricher when no routing/services configured')
```

**Test infrastructure pattern:**

Use the same `MockGraphBackend` pattern from existing HTTPConnectionEnricher tests. For the plugin-level tests (not unit logic tests), instantiate the real plugin class:

```typescript
import { ServiceConnectionEnricher, ResourceRegistryImpl, createRoutingMap } from '@grafema/core';
import { ROUTING_MAP_RESOURCE_ID } from '@grafema/types';

// Extended mock with SERVICE nodes, getOutgoingEdges, getIncomingEdges
class MockGraphBackend {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
  }
  addNode(node) { this.nodes.set(node.id, { ...this.nodes.get(node.id), ...node }); }
  async addEdge(edge) { this.edges.push(edge); }
  async *queryNodes(filter) {
    for (const node of this.nodes.values()) {
      if (filter?.type && node.type !== filter.type) continue;
      yield node;
    }
  }
  async getOutgoingEdges(nodeId, edgeTypes = null) {
    return this.edges.filter(e => {
      if (e.src !== nodeId) return false;
      if (edgeTypes && !edgeTypes.includes(e.type)) return false;
      return true;
    });
  }
  async getIncomingEdges(nodeId, edgeTypes = null) {
    return this.edges.filter(e => {
      if (e.dst !== nodeId) return false;
      if (edgeTypes && !edgeTypes.includes(e.type)) return false;
      return true;
    });
  }
}
```

**For routing transformation tests:**

```typescript
it('should transform URL using stripPrefix before matching', async () => {
  const graph = new MockGraphBackend();

  // SERVICE nodes for ownership resolution
  graph.addNode({ id: 'service:frontend', type: 'SERVICE', name: 'frontend', file: '/project/apps/frontend' });
  graph.addNode({ id: 'service:backend', type: 'SERVICE', name: 'backend', file: '/project/apps/backend' });

  // Backend route: GET /users (without /api prefix)
  graph.addNode({
    id: 'route:get-users',
    type: 'http:route',
    method: 'GET',
    path: '/users',
    fullPath: '/users',
    file: '/project/apps/backend/src/routes.js',
  });

  // Frontend request: GET /api/users (with /api prefix)
  graph.addNode({
    id: 'request:fetch-users',
    type: 'http:request',
    method: 'GET',
    url: '/api/users',
    file: '/project/apps/frontend/src/api.js',
  });

  // Set up routing map with stripPrefix rule
  const resources = new ResourceRegistryImpl();
  const routingMap = resources.getOrCreate(ROUTING_MAP_RESOURCE_ID, createRoutingMap);
  routingMap.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });

  const plugin = new ServiceConnectionEnricher();
  const result = await plugin.execute({
    graph,
    resources,
    config: {
      projectPath: '/project',
      services: [
        { name: 'frontend', path: 'apps/frontend' },
        { name: 'backend', path: 'apps/backend' },
      ],
    },
  });

  assert.ok(result.success);
  const interactsEdge = graph.edges.find(e => e.type === 'INTERACTS_WITH');
  assert.ok(interactsEdge, 'Should create INTERACTS_WITH edge after URL transformation');
  assert.strictEqual(interactsEdge.src, 'request:fetch-users');
  assert.strictEqual(interactsEdge.dst, 'route:get-users');
});
```

### Step 5.3: Register in BUILTIN_PLUGINS

**`packages/cli/src/commands/analyze.ts`:**

Add import:
```typescript
  ServiceConnectionEnricher,  // REG-256
```

Add to BUILTIN_PLUGINS:
```typescript
  ServiceConnectionEnricher: () => new ServiceConnectionEnricher() as Plugin,
```

**`packages/mcp/src/config.ts`:**

Add import and BUILTIN_PLUGINS entry.

**`packages/mcp/src/analysis-worker.ts`:**

Add import.

### Step 5.4: Update DEFAULT_CONFIG

In `packages/core/src/config/ConfigLoader.ts`, replace `HTTPConnectionEnricher` with `ServiceConnectionEnricher` in `DEFAULT_CONFIG.plugins.enrichment`:

```typescript
    enrichment: [
      'MethodCallResolver',
      'ArgumentParameterLinker',
      'AliasTracker',
      'ClosureCaptureEnricher',
      'RejectionPropagationEnricher',
      'ValueDomainAnalyzer',
      'MountPointResolver',
      'ExpressHandlerLinker',
      'PrefixEvaluator',
      'ImportExportLinker',
      'ConfigRoutingMapBuilder',       // REG-256
      'ServiceConnectionEnricher',     // REG-256 (replaces HTTPConnectionEnricher)
      'CallbackCallResolver',
    ],
```

**HTTPConnectionEnricher is removed from DEFAULT_CONFIG but NOT deleted.** Users with explicit configs that reference `HTTPConnectionEnricher` will still find it in BUILTIN_PLUGINS.

### Step 5.5: Export from core/index.ts

```typescript
export { ServiceConnectionEnricher } from './plugins/enrichment/ServiceConnectionEnricher.js';
```

### Step 5.6: Build and test

```bash
pnpm build
node --test test/unit/plugins/enrichment/ServiceConnectionEnricher.test.ts
# ALSO verify existing HTTPConnectionEnricher tests still pass:
node --test test/unit/plugins/enrichment/HTTPConnectionEnricher.test.js
node --test test/unit/plugins/enrichment/HTTPConnectionEnricherAlarm.test.js
```

---

## Phase 6: UnconnectedRouteValidator

### Step 6.1: Create `packages/core/src/plugins/validation/UnconnectedRouteValidator.ts`

**New file.** Follow the exact pattern from `AwaitInLoopValidator.ts`.

```typescript
// packages/core/src/plugins/validation/UnconnectedRouteValidator.ts

/**
 * UnconnectedRouteValidator — creates ISSUE nodes for customer-facing routes
 * that have no frontend consumers (REG-256).
 *
 * Only checks routes marked with customerFacing: true (set by ServiceConnectionEnricher).
 * Routes without the flag are considered internal and don't raise issues.
 *
 * Creates issue:connectivity ISSUE nodes with AFFECTS edges to flagged routes.
 *
 * Phase: VALIDATION
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';

interface RouteNode {
  id: string;
  type: string;
  file?: string;
  line?: number;
  column?: number;
  method?: string;
  path?: string;
  fullPath?: string;
  customerFacing?: boolean;
}

export class UnconnectedRouteValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'UnconnectedRouteValidator',
      phase: 'VALIDATION',
      dependencies: [],  // Cross-phase dep handled by phase ordering
      creates: {
        nodes: ['ISSUE'],
        edges: ['AFFECTS'],
      },
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);

    logger.info('Starting unconnected route check');

    let issueCount = 0;

    for await (const node of graph.queryNodes({ type: 'http:route' })) {
      const route = node as unknown as RouteNode;

      // Only check customer-facing routes
      if (!route.customerFacing) continue;

      // Check for incoming INTERACTS_WITH edges (frontend consumers)
      const incoming = await graph.getIncomingEdges(route.id, ['INTERACTS_WITH']);

      if (incoming.length === 0) {
        const routePath = route.fullPath || route.path || '';
        const method = route.method || 'UNKNOWN';

        if (context.reportIssue) {
          await context.reportIssue({
            category: 'connectivity',
            severity: 'warning',
            message: `Customer-facing route ${method} ${routePath} has no frontend consumers`,
            file: route.file || '',
            line: route.line || 0,
            column: route.column || 0,
            targetNodeId: route.id,
            context: {
              type: 'UNCONNECTED_CUSTOMER_ROUTE',
              method,
              path: routePath,
            },
          });
          issueCount++;
        }
      }
    }

    if (issueCount > 0) {
      logger.info('Unconnected customer-facing routes found', { count: issueCount });
    } else {
      logger.info('No unconnected customer-facing routes');
    }

    return createSuccessResult(
      { nodes: issueCount, edges: issueCount },
      { issueCount }
    );
  }
}
```

### Step 6.2: Write tests — `test/unit/plugins/validation/UnconnectedRouteValidator.test.ts`

**New file.**

```
describe('UnconnectedRouteValidator')
  it('should create issue for customer-facing route with no INTERACTS_WITH edges')
  it('should NOT create issue for non-customer-facing routes')
  it('should NOT create issue for customer-facing route WITH INTERACTS_WITH edges')
  it('should include route method and path in issue message')
  it('should set issue category to "connectivity"')
  it('should set issue severity to "warning"')
  it('should create AFFECTS edge to the route node')
  it('should handle routes without file/line gracefully')
  it('should count issues correctly in result metadata')
  it('should work when reportIssue is not available (no-op)')
```

**Test infrastructure:**

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { UnconnectedRouteValidator } from '@grafema/core';

class MockGraphBackend {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
  }
  addNode(node) { this.nodes.set(node.id, node); }
  async addEdge(edge) { this.edges.push(edge); }
  async *queryNodes(filter) {
    for (const node of this.nodes.values()) {
      if (filter?.type && node.type !== filter.type) continue;
      yield node;
    }
  }
  async getIncomingEdges(nodeId, edgeTypes = null) {
    return this.edges.filter(e => {
      if (e.dst !== nodeId) return false;
      if (edgeTypes && !edgeTypes.includes(e.type)) return false;
      return true;
    });
  }
}

// Mock reportIssue that collects issues
function createMockReportIssue() {
  const issues = [];
  const reportIssue = async (issue) => {
    issues.push(issue);
    return `issue:connectivity#mock-${issues.length}`;
  };
  return { reportIssue, issues };
}
```

### Step 6.3: Register in BUILTIN_PLUGINS and DEFAULT_CONFIG

**`packages/cli/src/commands/analyze.ts`:**

Add import and BUILTIN_PLUGINS entry:
```typescript
  UnconnectedRouteValidator: () => new UnconnectedRouteValidator() as Plugin,
```

**`packages/mcp/src/config.ts`:**

Add import and BUILTIN_PLUGINS entry.

**`packages/mcp/src/analysis-worker.ts`:**

Add import.

**`packages/core/src/config/ConfigLoader.ts` — DEFAULT_CONFIG:**

Add to validation plugins array:
```typescript
    validation: [
      'GraphConnectivityValidator',
      'DataFlowValidator',
      'EvalBanValidator',
      'CallResolverValidator',
      'SQLInjectionValidator',
      'AwaitInLoopValidator',
      'ShadowingDetector',
      'TypeScriptDeadCodeValidator',
      'BrokenImportValidator',
      'UnconnectedRouteValidator',  // REG-256
    ],
```

### Step 6.4: Export from core/index.ts

```typescript
export { UnconnectedRouteValidator } from './plugins/validation/UnconnectedRouteValidator.js';
```

### Step 6.5: Build and test

```bash
pnpm build
node --test test/unit/plugins/validation/UnconnectedRouteValidator.test.ts
```

---

## Phase 7: Integration & Full Suite

### Step 7.1: Run full test suite

```bash
pnpm build
node --test --test-concurrency=1 'test/unit/*.test.js'
```

### Step 7.2: Verify backward compatibility

1. HTTPConnectionEnricher tests still pass (they test the plugin directly, not via DEFAULT_CONFIG)
2. A project without `routing` config gets zero new behavior (ConfigRoutingMapBuilder creates empty RoutingMap, ServiceConnectionEnricher falls back to direct matching)
3. A project without `customerFacing` services gets zero ISSUE nodes from UnconnectedRouteValidator

### Step 7.3: Verify with a sample config

Create a test fixture or manual test with:

```yaml
services:
  - name: backend
    path: apps/backend
    entryPoint: src/index.ts
    customerFacing: true
  - name: frontend
    path: apps/frontend
    entryPoint: src/main.tsx

routing:
  - from: frontend
    to: backend
    stripPrefix: /api
```

---

## Complexity Analysis

| Component | Operation | Time | Space |
|-----------|-----------|------|-------|
| ResourceRegistryImpl | getOrCreate | O(1) amortized | O(r) total resources |
| ResourceRegistryImpl | get | O(1) | O(1) |
| RoutingMapImpl | addRule | O(r) dedup check, r = rules for pair | O(n) total |
| RoutingMapImpl | findMatch | O(p * r * log r) where p = pairs from service, r = rules per pair | O(r) for sort copy |
| RoutingMapImpl | findRulesForPair | O(1) map + O(r) copy | O(r) |
| ServiceConnectionEnricher | buildServiceMap | O(S) scan SERVICE nodes | O(S) |
| ServiceConnectionEnricher | getServiceForFile | O(S) linear scan | O(1) |
| ServiceConnectionEnricher | markCustomerFacingRoutes | O(R * S) | O(S) for cfServices set |
| ServiceConnectionEnricher | matching loop | O(req * routes * S) | O(1) per match |
| UnconnectedRouteValidator | execute | O(R) with one getIncomingEdges per route | O(1) |

Where: S = services (2-5), R = routes (10-100), req = requests (10-100), r = routing rules (1-5).

**Overall:** No asymptotic change vs HTTPConnectionEnricher. The dominant cost is O(req * routes) for matching, same as before. URL transformation adds O(1) per match attempt.

---

## Potential Issues & Mitigations

### 1. PluginContext.config typing

`PluginContext.config` is typed as `OrchestratorConfig` in `@grafema/types`, but `OrchestratorConfig` does NOT include `routing` currently. After Step 1.5, it will.

**Risk:** Low. TypeScript will catch any type mismatch at build time.

### 2. Plugin ordering across phases

ConfigRoutingMapBuilder declares no dependencies, so it could run before MountPointResolver. But that's fine — it reads from config, not from the graph. The important ordering is:

```
ConfigRoutingMapBuilder -> ServiceConnectionEnricher (declared via dependencies)
```

**Risk:** None. The `dependencies` array in ServiceConnectionEnricher's metadata ensures correct ordering.

### 3. Graph API for `addNode` updates

`ServiceConnectionEnricher.markCustomerFacingRoutes()` calls `graph.addNode()` to update existing route nodes with `customerFacing: true`. This works because both the in-memory graph and RFDBServerBackend treat `addNode` as upsert — if the node exists, it merges fields.

**Risk:** Medium. Verify that `addNode` with `{ ...existingNode, customerFacing: true }` doesn't lose any existing fields. The spread `{ ...route, customerFacing: true }` should be safe since `route` already has all fields from the query.

### 4. Test infrastructure

Tests use `MockGraphBackend` classes defined inline in test files. This is the established pattern. New tests should follow the same pattern.

**Risk:** None. This pattern is well-established.

### 5. MCP config.ts out of sync

The MCP config.ts doesn't import all plugins that CLI has (e.g., missing `ImportExportLinker`, `ExpressHandlerLinker`, `CallbackCallResolver`, `BrokenImportValidator`). We're adding our new plugins but should note this existing gap.

**Risk:** Low for our task. The MCP config relies on `BUILTIN_PLUGINS` map for resolution. As long as we add entries, it works.

### 6. analysis-worker.ts plugin list

The analysis worker has its own hardcoded plugin list. We need to add our new plugins there too, but since analysis-worker runs ANALYSIS phase plugins (not ENRICHMENT/VALIDATION), our new plugins won't actually execute in workers. However, they should still be importable for config resolution.

**Risk:** Low. If the analysis-worker plugin list is only for ANALYSIS phase, our ENRICHMENT/VALIDATION plugins don't need to be there. But adding them for completeness is harmless.

---

## File Summary

### New Files (12)

| # | File | LOC | Phase |
|---|------|-----|-------|
| 1 | `packages/types/src/resources.ts` | ~55 | 1 |
| 2 | `packages/types/src/routing.ts` | ~85 | 1 |
| 3 | `packages/core/src/core/ResourceRegistry.ts` | ~45 | 1 |
| 4 | `packages/core/src/resources/RoutingMapImpl.ts` | ~110 | 1 |
| 5 | `packages/core/src/plugins/enrichment/ConfigRoutingMapBuilder.ts` | ~65 | 4 |
| 6 | `packages/core/src/plugins/enrichment/ServiceConnectionEnricher.ts` | ~320 | 5 |
| 7 | `packages/core/src/plugins/validation/UnconnectedRouteValidator.ts` | ~65 | 6 |
| 8 | `test/unit/core/ResourceRegistry.test.ts` | ~80 | 1 |
| 9 | `test/unit/resources/RoutingMapImpl.test.ts` | ~150 | 1 |
| 10 | `test/unit/plugins/enrichment/ConfigRoutingMapBuilder.test.ts` | ~100 | 4 |
| 11 | `test/unit/plugins/enrichment/ServiceConnectionEnricher.test.ts` | ~450 | 5 |
| 12 | `test/unit/plugins/validation/UnconnectedRouteValidator.test.ts` | ~120 | 6 |

### Modified Files (9)

| # | File | Changes | Phase |
|---|------|---------|-------|
| 1 | `packages/types/src/plugins.ts` | +customerFacing, +routing, +resources, +imports | 1 |
| 2 | `packages/types/src/index.ts` | +2 export lines | 1 |
| 3 | `packages/core/src/config/ConfigLoader.ts` | +routing to GrafemaConfig, +validateRouting, +customerFacing validation, +mergeConfig routing, +DEFAULT_CONFIG changes | 2,5,6 |
| 4 | `packages/core/src/config/index.ts` | +validateRouting export | 2 |
| 5 | `packages/core/src/Orchestrator.ts` | +ResourceRegistryImpl, +routing storage, +resources/config in PluginContext | 3 |
| 6 | `packages/core/src/index.ts` | +exports for new plugins, ResourceRegistryImpl, RoutingMapImpl | 1,4,5,6 |
| 7 | `packages/cli/src/commands/analyze.ts` | +3 plugin imports and BUILTIN_PLUGINS entries | 4,5,6 |
| 8 | `packages/mcp/src/config.ts` | +3 plugin imports and BUILTIN_PLUGINS entries | 4,5,6 |
| 9 | `packages/mcp/src/analysis-worker.ts` | +3 plugin imports | 4,5,6 |

### NOT Modified (backward compat)

| File | Reason |
|------|--------|
| `HTTPConnectionEnricher.ts` | Stays for explicit config backward compat |
| `HTTPConnectionEnricher.test.js` | Existing tests must still pass |
| `HTTPConnectionEnricherAlarm.test.js` | Existing tests must still pass |

---

## Commit Plan

| Commit | Content | Tests |
|--------|---------|-------|
| 1 | Types: resources.ts, routing.ts, plugins.ts changes, index.ts exports | N/A (type-only) |
| 2 | Infrastructure: ResourceRegistryImpl, RoutingMapImpl + tests | ResourceRegistry.test.ts, RoutingMapImpl.test.ts |
| 3 | Config: validateRouting, customerFacing validation, mergeConfig, routing in GrafemaConfig + tests | ConfigLoader.test.ts (extended) |
| 4 | Orchestrator: ResourceRegistry integration, routing passthrough | Full suite (no behavior change) |
| 5 | ConfigRoutingMapBuilder plugin + tests + registration | ConfigRoutingMapBuilder.test.ts |
| 6 | ServiceConnectionEnricher plugin + tests + registration + DEFAULT_CONFIG change | ServiceConnectionEnricher.test.ts, HTTPConnectionEnricher.test.js (regression) |
| 7 | UnconnectedRouteValidator plugin + tests + registration | UnconnectedRouteValidator.test.ts |
