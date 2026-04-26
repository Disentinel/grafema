# Don Melton — Architecture Design for REG-256

## Executive Summary

After thorough analysis of the UX vision (004) and the codebase, I'm rejecting the previous plan's approach (003-don-revised-plan.md) of adding `routing` and `services` directly to `PluginContext`. The user's vision explicitly calls for a **new first-class "Resource" concept** — not another field on PluginContext. This is the right instinct: PluginContext is already growing unwieldy (12+ optional fields), and shared mutable state between plugins deserves its own abstraction.

This document designs the Resource system as core infrastructure, then builds RoutingMap on top of it.

## Prior Art

Before designing, I searched for existing patterns:

- **Service Locator / DI patterns** ([Fowler](https://martinfowler.com/articles/injection.html), [Baeldung](https://www.baeldung.com/cs/dependency-injection-vs-service-locator)): The Resource concept is closest to a typed Service Locator scoped to a pipeline run. Plugins declare what Resources they need; the Orchestrator provides access. Unlike DI, Resources are created lazily by the first plugin that writes to them, not injected from outside.
- **Routing data structures** ([TUM research](https://www.net.in.tum.de/fileadmin/TUM/NET/NET-2017-05-1/NET-2017-05-1_03.pdf), [Trie overview](https://en.wikipedia.org/wiki/Trie)): For Grafema's use case (typically 1-20 routing rules, not millions of IP prefixes), a trie is overkill. A simple sorted array with linear scan is optimal — O(r) where r is typically 1-5.

---

## 1. Resource Concept Specification

### 1.1 Design Philosophy

Resources are **shared typed data containers** that plugins can write to and read from during a pipeline run. They solve the problem of inter-plugin communication beyond the graph.

**Why not just use the graph?**
- Routing rules are configuration-derived metadata, not code-derived graph nodes
- They don't have files, lines, or semantic IDs
- They're ephemeral (rebuilt each run), not persisted
- Multiple plugins need to write to the same collection incrementally

**Why not PluginContext fields?**
- PluginContext is already bloated with 12+ optional fields
- Each new shared concept would require Orchestrator changes, type changes, plumbing in 3+ files
- No validation of provider/consumer relationships
- No lifecycle management

### 1.2 Resource Interface

```typescript
// packages/types/src/resources.ts (NEW FILE)

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

### 1.3 ResourceRegistry Implementation

```typescript
// packages/core/src/core/ResourceRegistry.ts (NEW FILE)

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

### 1.4 PluginContext Integration

Add `resources` to PluginContext — a single new field, not per-resource fields:

```typescript
// packages/types/src/plugins.ts — PluginContext (ADD)
export interface PluginContext {
  // ... existing fields ...

  /**
   * Resource registry for shared data between plugins (REG-256).
   * Plugins can read/write typed Resources through this registry.
   * Available in all phases.
   */
  resources?: ResourceRegistry;
}
```

### 1.5 Orchestrator Changes

Minimal changes to Orchestrator:

1. Create `ResourceRegistryImpl` in `run()` at the start
2. Pass `resources` in `PluginContext` for every `runPhase()` call
3. Clear resources at end of `run()`

```typescript
// In Orchestrator.run():
private resourceRegistry = new ResourceRegistryImpl();

// In run():
this.resourceRegistry.clear(); // Fresh for each run

// In runPhase(), when building pluginContext:
const pluginContext: PluginContext = {
  ...context,
  resources: this.resourceRegistry,
  // ... existing fields
};

// At end of run():
this.resourceRegistry.clear();
```

### 1.6 Why This Design

| Alternative | Problem |
|---|---|
| Resources declared in PluginMetadata | Over-engineering. Plugins already declare dependencies via `dependencies`. Resource creation is lazy — no need for upfront declaration. |
| DI-style injection | Plugins are instantiated before the run. Resources are created during the run. DI doesn't fit the lifecycle. |
| Shared mutable on PluginContext | Exactly what we're escaping from. PluginContext shouldn't grow per-feature. |
| Graph nodes for routing rules | Routing rules aren't code artifacts. They'd pollute the graph and aren't queryable via Datalog. |

---

## 2. RoutingMap Specification

### 2.1 RoutingRule Interface

```typescript
// packages/types/src/routing.ts (NEW FILE)

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
   * If multiple rules match (same from/to pair), returns the most specific one:
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

### 2.2 RoutingMap Implementation

```typescript
// packages/core/src/resources/RoutingMapImpl.ts (NEW FILE)

import type { RoutingMap, RoutingRule, MatchContext, MatchResult } from '@grafema/types';

/**
 * Default implementation of RoutingMap.
 *
 * Stores rules in an array, indexed by service pair for fast lookup.
 * For typical workloads (1-20 rules), linear scan is optimal.
 * If rule count ever exceeds 100, we'd switch to a Map<fromService, Map<toService, rules[]>>.
 *
 * Complexity:
 * - addRule: O(1) amortized
 * - findMatch: O(r) where r = rules for the specific from/to pair (typically 1-3)
 * - findRulesForPair: O(r) same
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

### 2.3 Why This Data Structure

| Alternative | Why Not |
|---|---|
| Trie | Overkill for 1-20 rules. Tries shine at millions of entries. |
| RegExp compilation | Rules are prefix-based, not pattern-based. String operations are simpler and faster. |
| Flat array scan | Close to what we have, but indexing by service pair gives O(1) pair lookup. |

---

## 3. RoutingMapBuilder Interface

### 3.1 Builder Pattern

Builders are regular ENRICHMENT plugins that happen to write to the RoutingMap Resource. No special interface needed — they just use `context.resources.getOrCreate()`.

The convention is:
- Builder plugins run in ENRICHMENT phase
- They declare dependency on any prerequisite plugins (e.g., MountPointResolver)
- They access the RoutingMap via `context.resources.getOrCreate('routing:map', createRoutingMap)`
- They call `routingMap.addRules(...)` to contribute rules
- The consuming plugin (ServiceConnectionEnricher) runs AFTER all builders (via dependency declaration)

### 3.2 Why No Formal Builder Interface

A formal `RoutingMapBuilder` interface would add abstraction with no benefit:
- Builders don't share logic (config parser vs nginx parser vs k8s parser — all different)
- The "write to RoutingMap" part is a single `addRules()` call
- The Orchestrator doesn't need to know which plugins are "builders"
- Plugin ordering is already handled by dependency declarations

Builders are just plugins. That's the KISS principle.

---

## 4. ConfigRoutingMapBuilder Design

### 4.1 Plugin Implementation

```typescript
// packages/core/src/plugins/enrichment/ConfigRoutingMapBuilder.ts (NEW FILE)

/**
 * ConfigRoutingMapBuilder - reads routing rules from config.yaml
 * and writes them to the RoutingMap Resource.
 *
 * This is the first RoutingMapBuilder. Future builders will read from
 * nginx.conf, k8s manifests, etc. All write to the same RoutingMap.
 *
 * Phase: ENRICHMENT (early, before ServiceConnectionEnricher)
 * Dependencies: none (reads from config, not from graph)
 */
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
    const routing = (context.config as OrchestratorConfig & { routing?: RoutingRule[] })?.routing;

    if (!routing || routing.length === 0) {
      logger.debug('No routing rules in config');
      return createSuccessResult({ nodes: 0, edges: 0 }, { rulesLoaded: 0 });
    }

    // Get or create RoutingMap Resource
    const resources = context.resources;
    if (!resources) {
      logger.warn('ResourceRegistry not available — skipping routing rules');
      return createSuccessResult({ nodes: 0, edges: 0 }, { rulesLoaded: 0 });
    }

    const routingMap = resources.getOrCreate(ROUTING_MAP_RESOURCE_ID, createRoutingMap);

    // Add rules with source attribution
    const rulesWithSource = routing.map(rule => ({
      ...rule,
      source: 'config.yaml',
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

### 4.2 Config Access

The routing rules need to reach the plugin. Current flow:

```
config.yaml -> loadConfig() -> GrafemaConfig -> analyze.ts -> OrchestratorOptions -> Orchestrator -> PluginContext.config
```

`PluginContext.config` is typed as `OrchestratorConfig` which doesn't include `routing`. Two approaches:

**Option A: Extend OrchestratorConfig with routing** — add `routing?: RoutingRule[]` to `OrchestratorConfig` in `@grafema/types`. This follows the `services` and `strictMode` precedent.

**Option B: Store routing in the ResourceRegistry pre-run** — Orchestrator pre-populates the RoutingMap from config before plugins run.

**Decision: Option A.** It's simpler, follows existing patterns, and the plugin reads from `context.config.routing` just like it would read `context.config.services`. The ResourceRegistry is for inter-plugin communication, not config plumbing.

But wait — the ConfigRoutingMapBuilder then reads from `context.config` AND writes to the ResourceRegistry. That seems redundant. Why not have the Orchestrator pre-populate the RoutingMap directly?

**Counterargument:** The Orchestrator shouldn't know about RoutingMaps. It shouldn't import RoutingMap types. The whole point of the plugin architecture is that domain-specific logic lives in plugins. The Orchestrator only handles lifecycle.

**Final decision: Option A for config plumbing, plugin for loading.** Config flows through `OrchestratorConfig.routing` -> `PluginContext.config.routing` -> ConfigRoutingMapBuilder reads it -> writes to RoutingMap Resource. Clean separation.

---

## 5. ServiceConnectionEnricher Design

This replaces `HTTPConnectionEnricher`. Name chosen per user's vision document.

### 5.1 Responsibilities

Everything HTTPConnectionEnricher does, plus:
1. Uses RoutingMap for URL transformation
2. Marks `customerFacing` metadata on route nodes
3. Service resolution (node -> service mapping) using graph SERVICE nodes

### 5.2 Plugin Structure

```typescript
// packages/core/src/plugins/enrichment/ServiceConnectionEnricher.ts (NEW FILE)

export class ServiceConnectionEnricher extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ServiceConnectionEnricher',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],   // Updates existing route nodes with customerFacing metadata
        edges: ['INTERACTS_WITH', 'HTTP_RECEIVES'],
      },
      dependencies: [
        'ExpressRouteAnalyzer',
        'FetchAnalyzer',
        'ExpressResponseAnalyzer',
        'MountPointResolver',
        'ConfigRoutingMapBuilder',  // Must run after all builders
      ],
      consumes: ['RESPONDS_WITH'],
      produces: ['INTERACTS_WITH', 'HTTP_RECEIVES'],
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    // 1. Build service ownership map (SERVICE nodes -> path prefix map)
    // 2. Get RoutingMap from ResourceRegistry (may not exist if no builders ran)
    // 3. Mark customerFacing on route nodes
    // 4. Collect and deduplicate http:route and http:request nodes
    // 5. For each request, determine owning service
    // 6. For each route, determine owning service
    // 7. For matching: apply routing rule (if exists for the service pair)
    // 8. Match transformed URL against route path
    // 9. Create INTERACTS_WITH and HTTP_RECEIVES edges
    // 10. Handle unknown methods (preserve strict mode behavior)
  }
}
```

### 5.3 Service Resolution

The enricher needs to know which service a node (route or request) belongs to, using the file path.

```typescript
/**
 * Build a map from file path prefixes to service names.
 * Uses SERVICE nodes from the graph.
 *
 * Returns a sorted array (longest path first) for most-specific-match lookup.
 */
private async buildServiceMap(graph: GraphBackend): Promise<ServiceEntry[]> {
  const entries: ServiceEntry[] = [];
  for await (const node of graph.queryNodes({ type: 'SERVICE' })) {
    if (node.file && node.name) {
      entries.push({ name: node.name as string, path: node.file });
    }
  }
  // Sort by path length descending (most specific first)
  entries.sort((a, b) => b.path.length - a.path.length);
  return entries;
}

/**
 * Find which service owns a file path.
 * O(s) where s = number of services (typically 2-5).
 */
private getServiceName(filePath: string, serviceMap: ServiceEntry[]): string | undefined {
  for (const entry of serviceMap) {
    if (filePath.startsWith(entry.path)) {
      return entry.name;
    }
  }
  return undefined;
}
```

### 5.4 customerFacing Marking

```typescript
/**
 * Mark route nodes as customerFacing based on service configuration.
 * Reads customerFacing flag from ServiceDefinition in config.
 */
private async markCustomerFacingRoutes(
  graph: GraphBackend,
  routes: HTTPRouteNode[],
  serviceMap: ServiceEntry[],
  services: ServiceDefinition[],
  logger: Logger
): Promise<number> {
  // Build name -> customerFacing lookup from config
  const cfMap = new Map<string, boolean>();
  for (const svc of services) {
    if (svc.customerFacing) {
      cfMap.set(svc.name, true);
    }
  }

  let count = 0;
  for (const route of routes) {
    if (!route.file) continue;
    const serviceName = this.getServiceName(route.file, serviceMap);
    if (serviceName && cfMap.get(serviceName)) {
      await graph.addNode({
        ...route,
        customerFacing: true,
      });
      count++;
    }
  }

  logger.info('Marked customer-facing routes', { count });
  return count;
}
```

### 5.5 Matching with RoutingMap

```typescript
// For each request-route pair:
const requestService = this.getServiceName(request.file, serviceMap);
const routeService = this.getServiceName(route.file, serviceMap);

let urlToMatch = url;

// Try RoutingMap transformation if both services are known
if (requestService && routeService && routingMap) {
  const rules = routingMap.findRulesForPair(requestService, routeService);
  for (const rule of rules) {
    const transformed = routingMap.findMatch({
      fromService: requestService,
      requestUrl: url,
    });
    if (transformed && transformed.targetService === routeService) {
      urlToMatch = transformed.transformedUrl;
      break;
    }
  }
}

if (routePath && this.pathsMatch(urlToMatch, routePath)) {
  // Create INTERACTS_WITH edge...
}
```

### 5.6 Backward Compatibility

When no RoutingMap exists (no routing config, no builders), the enricher falls back to direct path matching — identical to current HTTPConnectionEnricher behavior. This ensures zero regression for existing users.

---

## 6. UnconnectedRouteValidator Design

### 6.1 Plugin Structure

```typescript
// packages/core/src/plugins/validation/UnconnectedRouteValidator.ts (NEW FILE)

/**
 * UnconnectedRouteValidator - creates ISSUE nodes for customer-facing routes
 * that have no frontend consumers.
 *
 * Only checks routes marked with customerFacing: true (set by ServiceConnectionEnricher).
 * Routes without the flag are considered internal and don't raise issues.
 *
 * Phase: VALIDATION
 * Uses: context.reportIssue() (injected by Orchestrator for VALIDATION phase)
 */
export class UnconnectedRouteValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'UnconnectedRouteValidator',
      phase: 'VALIDATION',
      dependencies: [],  // Cross-phase dep on ServiceConnectionEnricher handled by phase ordering
      creates: {
        nodes: ['ISSUE'],
        edges: ['AFFECTS'],
      },
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);
    let issueCount = 0;

    for await (const node of graph.queryNodes({ type: 'http:route' })) {
      const route = node as RouteNode;

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
            line: (route.line as number) || 0,
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

    logger.info('Unconnected route check complete', { issues: issueCount });

    return createSuccessResult(
      { nodes: issueCount, edges: issueCount },
      { issueCount }
    );
  }
}
```

### 6.2 Issue Category

New category: `connectivity`. This fits logically — the issue is about route connectivity (or lack thereof) between services. Existing categories are: `security`, `performance`, `style`, `smell`. `connectivity` is a natural addition for cross-service analysis.

---

## 7. Config Schema Changes

### 7.1 GrafemaConfig Extension

```typescript
// packages/core/src/config/ConfigLoader.ts — add to GrafemaConfig

export interface GrafemaConfig {
  // ... existing fields ...

  /**
   * Routing rules for cross-service URL mapping (REG-256).
   * Describes how infrastructure (nginx, gateway) transforms URLs between services.
   *
   * @example
   * ```yaml
   * routing:
   *   - from: frontend
   *     to: backend
   *     stripPrefix: /api        # /api/users -> /users
   *   - from: frontend
   *     to: auth-service
   *     stripPrefix: /auth       # /auth/login -> /login
   * ```
   */
  routing?: RoutingRule[];
}
```

### 7.2 ServiceDefinition Extension

```typescript
// packages/types/src/plugins.ts — add to ServiceDefinition

export interface ServiceDefinition {
  // ... existing fields ...

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

### 7.3 OrchestratorConfig Extension

```typescript
// packages/types/src/plugins.ts — add to OrchestratorConfig

export interface OrchestratorConfig {
  // ... existing fields ...

  /**
   * Routing rules from config (REG-256).
   * Passed through to plugins via PluginContext.config.
   */
  routing?: RoutingRule[];
}
```

### 7.4 Validation

```typescript
// packages/core/src/config/ConfigLoader.ts — new function

/**
 * Validate routing rules structure.
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

    // Cross-validate against services
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

---

## 8. Integration Points

### 8.1 Orchestrator Changes

| Change | File | Details |
|---|---|---|
| Add ResourceRegistryImpl | `Orchestrator.ts` | Create in constructor, pass to PluginContext, clear at run end |
| Pass `routing` to config | `Orchestrator.ts` | Store `routing` from OrchestratorOptions, include in PluginContext.config |
| Store `services` for context | `Orchestrator.ts` | Already stored as `configServices`, needs to be in PluginContext.config |

### 8.2 PluginContext Changes

| Field | Type | Phase Availability | Purpose |
|---|---|---|---|
| `resources` | `ResourceRegistry` | ALL | Access shared Resources |

Note: Only ONE new field added to PluginContext (resources). Routing rules flow through `config.routing`, services through `config.services`. This is the key benefit of the Resource pattern — it doesn't add per-feature fields to PluginContext.

### 8.3 CLI/MCP Wiring

| File | Change |
|---|---|
| `packages/cli/src/commands/analyze.ts` | Import new plugins, add to BUILTIN_PLUGINS, pass `config.routing` to OrchestratorOptions |
| `packages/mcp/src/config.ts` | Import new plugins, add to BUILTIN_PLUGINS |
| `packages/mcp/src/analysis-worker.ts` | Import new plugins, add to BUILTIN_PLUGINS |

### 8.4 Plugin Dependency Graph

```
ConfigRoutingMapBuilder (ENRICHMENT, early)
        |
        | writes to RoutingMap Resource
        v
ServiceConnectionEnricher (ENRICHMENT, depends on ConfigRoutingMapBuilder + MountPointResolver + etc.)
        |
        | creates INTERACTS_WITH, HTTP_RECEIVES edges
        | sets customerFacing metadata on route nodes
        v
UnconnectedRouteValidator (VALIDATION)
        |
        | reads customerFacing + INTERACTS_WITH edges
        | creates issue:connectivity ISSUE nodes
```

---

## 9. Files to Create/Modify

### New Files

| File | Description | Est. LOC |
|---|---|---|
| `packages/types/src/resources.ts` | Resource, ResourceRegistry interfaces | ~50 |
| `packages/types/src/routing.ts` | RoutingRule, RoutingMap, MatchContext, MatchResult | ~80 |
| `packages/core/src/core/ResourceRegistry.ts` | ResourceRegistryImpl | ~40 |
| `packages/core/src/resources/RoutingMapImpl.ts` | RoutingMapImpl, createRoutingMap | ~100 |
| `packages/core/src/plugins/enrichment/ConfigRoutingMapBuilder.ts` | Reads config, writes to RoutingMap | ~60 |
| `packages/core/src/plugins/enrichment/ServiceConnectionEnricher.ts` | Replaces HTTPConnectionEnricher | ~300 |
| `packages/core/src/plugins/validation/UnconnectedRouteValidator.ts` | Creates ISSUE nodes for unconnected customer-facing routes | ~60 |
| `test/unit/core/ResourceRegistry.test.js` | ResourceRegistry unit tests | ~60 |
| `test/unit/resources/RoutingMapImpl.test.js` | RoutingMap unit tests | ~120 |
| `test/unit/plugins/enrichment/ConfigRoutingMapBuilder.test.js` | ConfigRoutingMapBuilder tests | ~80 |
| `test/unit/plugins/enrichment/ServiceConnectionEnricher.test.js` | ServiceConnectionEnricher tests (port + extend) | ~400 |
| `test/unit/plugins/validation/UnconnectedRouteValidator.test.js` | UnconnectedRouteValidator tests | ~100 |

### Modified Files

| File | Change | Est. LOC Delta |
|---|---|---|
| `packages/types/src/plugins.ts` | Add `customerFacing` to ServiceDefinition, `routing` to OrchestratorConfig, `resources` to PluginContext, import Resource types | +15 |
| `packages/types/src/index.ts` | Export new type files | +5 |
| `packages/core/src/config/ConfigLoader.ts` | Add `routing` to GrafemaConfig, `validateRouting()`, update `mergeConfig()` and `loadConfig()`, validate `customerFacing` in `validateServices()` | +50 |
| `packages/core/src/config/index.ts` | Export new types and functions | +3 |
| `packages/core/src/Orchestrator.ts` | Create ResourceRegistryImpl, pass to PluginContext, store/pass routing config | +20 |
| `packages/core/src/index.ts` | Export new plugins, ResourceRegistry, RoutingMap types | +10 |
| `packages/cli/src/commands/analyze.ts` | Import + register 3 new plugins in BUILTIN_PLUGINS, pass routing to Orchestrator | +15 |
| `packages/mcp/src/config.ts` | Import + register 3 new plugins in BUILTIN_PLUGINS | +10 |
| `packages/mcp/src/analysis-worker.ts` | Import + register 3 new plugins (if applicable) | +10 |
| `packages/core/src/config/ConfigLoader.ts` (DEFAULT_CONFIG) | Replace `HTTPConnectionEnricher` with `ConfigRoutingMapBuilder` + `ServiceConnectionEnricher`, add `UnconnectedRouteValidator` | +3 |

### NOT Modified (Backward Compat)

| File | Reason |
|---|---|
| `HTTPConnectionEnricher.ts` | Stays. Users with explicit config still get it. |
| All existing HTTPConnectionEnricher tests | Untouched. Existing behavior preserved. |

---

## 10. Implementation Order

### Phase 1: Types & Infrastructure (foundation, no behavior change)

1. Create `packages/types/src/resources.ts` — Resource, ResourceRegistry interfaces
2. Create `packages/types/src/routing.ts` — RoutingRule, RoutingMap, MatchContext, MatchResult
3. Export from `packages/types/src/index.ts`
4. Add `customerFacing?: boolean` to ServiceDefinition in `packages/types/src/plugins.ts`
5. Add `routing?: RoutingRule[]` to OrchestratorConfig in `packages/types/src/plugins.ts`
6. Add `resources?: ResourceRegistry` to PluginContext in `packages/types/src/plugins.ts`
7. Create `packages/core/src/core/ResourceRegistry.ts` — ResourceRegistryImpl
8. Write `test/unit/core/ResourceRegistry.test.js`
9. Create `packages/core/src/resources/RoutingMapImpl.ts`
10. Write `test/unit/resources/RoutingMapImpl.test.js`
11. `pnpm build` + run tests

### Phase 2: Config (validation, plumbing)

12. Add `routing?: RoutingRule[]` to GrafemaConfig
13. Add `validateRouting()` to ConfigLoader
14. Update `validateServices()` to accept and validate `customerFacing`
15. Update `mergeConfig()` to pass through `routing`
16. Update `loadConfig()` to call `validateRouting()`
17. Export from config/index.ts
18. Extend existing ConfigLoader tests for routing validation and customerFacing
19. `pnpm build` + run tests

### Phase 3: Orchestrator integration

20. Add ResourceRegistryImpl to Orchestrator (create in run, pass to PluginContext, clear at end)
21. Pass `routing` through OrchestratorOptions -> PluginContext.config
22. Ensure `services` (with `customerFacing`) are available in PluginContext.config
23. `pnpm build` + run tests (no behavior change yet — no plugins consume Resources)

### Phase 4: ConfigRoutingMapBuilder

24. Write ConfigRoutingMapBuilder tests
25. Implement ConfigRoutingMapBuilder
26. Register in BUILTIN_PLUGINS (CLI, MCP)
27. Export from core/index.ts
28. `pnpm build` + run tests

### Phase 5: ServiceConnectionEnricher (core logic)

29. Write ServiceConnectionEnricher tests (port all HTTPConnectionEnricher tests + new ones)
30. Implement ServiceConnectionEnricher
31. Register in BUILTIN_PLUGINS (CLI, MCP)
32. Export from core/index.ts
33. Update DEFAULT_CONFIG: replace `HTTPConnectionEnricher` with `ConfigRoutingMapBuilder` + `ServiceConnectionEnricher`
34. `pnpm build` + run tests (all ported tests must pass)

### Phase 6: UnconnectedRouteValidator

35. Write UnconnectedRouteValidator tests
36. Implement UnconnectedRouteValidator
37. Register in BUILTIN_PLUGINS (CLI, MCP)
38. Export from core/index.ts
39. Add to DEFAULT_CONFIG validation plugins
40. `pnpm build` + run tests

### Phase 7: Integration & backward compat

41. Run full test suite
42. Verify HTTPConnectionEnricher still works when explicitly configured
43. Test with a real project that has routing config

---

## 11. Open Questions

### 11.1 For User (Decisions Needed)

1. **Issue category:** I propose `connectivity` as the new issue category for unconnected routes. Alternative: `smell`. Preference?

2. **Issue severity:** I propose `warning`. Unconnected customer-facing routes are suspicious but not broken. Agree?

3. **Default customerFacing:** When `customerFacing` is not specified on a service, default is `false` (no issues for unconnected routes). This means existing users get zero new issues unless they opt in. Confirm?

4. **Plugin name:** The user's vision says "ServiceConnectionEnricher". The previous plan proposed "ServiceRoutingPlugin". I'll go with the user's terminology — `ServiceConnectionEnricher`. Confirm?

5. **Resource scope:** Resources are scoped to a single `Orchestrator.run()` call. They don't persist across runs. This is intentional — routing rules come from config and are rebuilt each time. Agree?

### 11.2 Architectural Decisions (Already Made)

1. **No formal RoutingMapBuilder interface** — builders are just regular plugins that write to the RoutingMap. KISS.

2. **One `resources` field on PluginContext** — not per-resource fields. This is the whole point of the Resource abstraction.

3. **Lazy "get-or-create" pattern** — first plugin to access a Resource creates it. No upfront registration needed.

4. **RoutingMap uses Map<pair, rules[]>** — not a trie. Optimal for the expected rule count (1-20).

5. **Cross-validation of routing rules against services** — `from`/`to` must reference services that exist in the config. Fail loudly if they don't.

6. **HTTPConnectionEnricher stays** — backward compatibility. Users with explicit configs keep working.

---

## Complexity Summary

| Component | Time Complexity | Space |
|---|---|---|
| ResourceRegistry.getOrCreate | O(1) | O(r) resources |
| RoutingMap.addRule | O(1) amortized | O(n) rules |
| RoutingMap.findMatch | O(r) where r = rules for service pair | O(1) |
| Service map build | O(s) where s = SERVICE nodes | O(s) |
| Service lookup | O(s) per lookup | O(1) |
| customerFacing marking | O(routes) | O(s) for lookup map |
| Request-route matching | O(requests * routes * r) | O(1) per match |
| Unconnected route check | O(routes) with one getIncomingEdges per route | O(1) |

No change to asymptotic complexity vs current HTTPConnectionEnricher. The dominant cost remains O(requests * routes) for matching, which is unavoidable without indexing routes by path (future optimization if needed).

---

## Estimated Total Scope

| Category | LOC |
|---|---|
| Type definitions (types package) | ~145 |
| Core infrastructure (ResourceRegistry, RoutingMapImpl) | ~140 |
| Plugins (3 new) | ~420 |
| Config changes | ~70 |
| Plumbing (Orchestrator, CLI, MCP, exports) | ~60 |
| **Total production code** | **~835** |
| Tests | ~760 |
| **Grand total** | **~1595** |
| Files created | 12 |
| Files modified | 9 |
