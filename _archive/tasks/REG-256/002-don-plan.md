# Don Melton - Technical Analysis & Plan for REG-256

## Task

Config-based cross-service routing rules for HTTPConnectionEnricher. Allow matching frontend HTTP requests to backend routes when URL prefixes differ due to infrastructure-level routing (nginx, API gateway, etc.).

## Codebase Analysis

### 1. HTTPConnectionEnricher — Current Matching Logic

**File:** `packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts`

The enricher operates in the ENRICHMENT phase (global, after all services indexed). Current flow:

1. Collects all `http:route` nodes (backend endpoints)
2. Collects all `http:request` nodes (frontend requests)
3. Deduplicates by ID
4. For each request, iterates routes looking for a match:
   - Method matching (case-insensitive, handles `default`/`unknown` sources)
   - Path matching via `pathsMatch()`:
     - Normalizes Express params (`:id`) and template literals (`${...}`) to `{param}`
     - Exact match on normalized forms
     - Falls back to regex match for parametric routes
   - Uses `route.fullPath || route.path` (fullPath set by MountPointResolver for mounted routes)
5. Creates `INTERACTS_WITH` edge (request -> route)
6. Creates `HTTP_RECEIVES` edges if both sides have data nodes

**Critical observation:** The enricher has **no concept of service ownership**. It matches ALL requests against ALL routes globally. There is no filtering by "which service does this request/route belong to."

### 2. Service-to-Node Relationship

Nodes know their origin via the `file` field (absolute path). Services are created as `SERVICE:name` nodes with `file = servicePath`. The JSModuleIndexer creates `SERVICE --CONTAINS--> MODULE` edges. Modules have `file` paths under the service directory.

**To determine which service a node belongs to:** Query `SERVICE` nodes, get their `file` paths, then check if a node's `file` starts with a service's path. Alternatively, traverse the graph: node -> MODULE (via file) -> SERVICE (via CONTAINS edge, reversed).

### 3. ConfigLoader — Current State

**File:** `packages/core/src/config/ConfigLoader.ts`

- Parses `.grafema/config.yaml` (or `.json` fallback)
- `GrafemaConfig` interface has: `plugins`, `services`, `include`, `exclude`, `strict`, `workspace`, `version`
- Each section has its own validator (e.g., `validateServices`, `validateWorkspace`)
- `mergeConfig()` merges user config with `DEFAULT_CONFIG`
- Config flows: `loadConfig()` -> `analyze.ts` -> `Orchestrator` -> `PluginContext.config`

**Config flow to enrichers:** `PluginContext.config` is typed as `OrchestratorConfig` (from `@grafema/types`), but at runtime it's `OrchestratorOptions` which doesn't directly carry `GrafemaConfig` fields like `routing`. The `config` passed to `runPhase('ENRICHMENT', ...)` is `{ manifest, graph, workerCount }` — it does NOT include the full config.

### 4. Existing Tests

- **Unit tests:** `test/unit/plugins/enrichment/HTTPConnectionEnricher.test.js` — comprehensive tests for path matching, method matching, mount prefix support, template literals, HTTP_RECEIVES edges
- **Alarm tests:** `test/unit/plugins/enrichment/HTTPConnectionEnricherAlarm.test.js` — tests for unknown method handling in strict/non-strict mode
- **Integration tests:** `test/integration/cross-service-tracing.test.ts` — full pipeline test with frontend+backend services

### 5. Prior Art Research

Looked at how infrastructure tools handle prefix-based routing:

- **Traefik:** Uses `stripPrefix` and `addPrefix` middleware in Kubernetes CRD. Config schema has `prefixes: ["/foobar"]` array. Clear, declarative approach.
- **nginx:** `proxy_pass` with trailing slash strips location prefix implicitly. More complex rewrite rules for explicit stripping.
- **AWS API Gateway:** Path-based routing with wildcard paths (`/billing/*`). No explicit strip concept — paths are mapped directly.
- **Spring Cloud Gateway:** Regex-based URL rewriting filters.

**Key takeaway:** Traefik's approach is the closest fit. It uses declarative `stripPrefix`/`addPrefix` middlewares with explicit prefix lists. Our `routing` config should follow this pattern — simple, declarative, per-service-pair rules.

## Design Plan

### Approach: Forward Registration via Config

The routing rules describe infrastructure topology. They should be:
1. Parsed at config load time
2. Validated alongside services
3. Passed to HTTPConnectionEnricher via PluginContext
4. Applied during matching (before `pathsMatch()`)

This is **forward registration** (good) — the config declares routing intent, the enricher consumes it. No backward scanning.

### Step 1: Add `routing` to GrafemaConfig

**File:** `packages/core/src/config/ConfigLoader.ts`

```typescript
// New interface
export interface RoutingRule {
  /** Service name where requests originate (must match a service in 'services') */
  from: string;
  /** Service name where routes are defined (must match a service in 'services') */
  to: string;
  /** Prefix to strip from request URL before matching against route path */
  stripPrefix?: string;
  /** Prefix to add to request URL before matching against route path */
  addPrefix?: string;
}

// Add to GrafemaConfig
export interface GrafemaConfig {
  // ... existing fields ...

  /**
   * Cross-service routing rules.
   * Describes infrastructure-level URL transformations (nginx, API gateway).
   * Used by HTTPConnectionEnricher to match requests across services.
   */
  routing?: RoutingRule[];
}
```

### Step 2: Validate Routing Config

**File:** `packages/core/src/config/ConfigLoader.ts`

New `validateRouting()` function, called alongside `validateServices()`:

```typescript
export function validateRouting(
  routing: unknown,
  services: ServiceDefinition[] | undefined
): void {
  if (routing === undefined || routing === null) return;

  if (!Array.isArray(routing)) {
    throw new Error(`Config error: routing must be an array, got ${typeof routing}`);
  }

  // Collect valid service names for cross-reference
  const serviceNames = new Set(
    (services || []).map(s => s.name)
  );

  for (let i = 0; i < routing.length; i++) {
    const rule = routing[i];

    // Must be object
    if (typeof rule !== 'object' || rule === null) {
      throw new Error(`Config error: routing[${i}] must be an object`);
    }

    // 'from' is required, must reference a known service
    if (typeof rule.from !== 'string' || !rule.from.trim()) {
      throw new Error(`Config error: routing[${i}].from must be a non-empty string`);
    }
    if (serviceNames.size > 0 && !serviceNames.has(rule.from)) {
      throw new Error(`Config error: routing[${i}].from "${rule.from}" does not match any service`);
    }

    // 'to' is required, must reference a known service
    if (typeof rule.to !== 'string' || !rule.to.trim()) {
      throw new Error(`Config error: routing[${i}].to must be a non-empty string`);
    }
    if (serviceNames.size > 0 && !serviceNames.has(rule.to)) {
      throw new Error(`Config error: routing[${i}].to "${rule.to}" does not match any service`);
    }

    // At least one transformation must be specified
    if (!rule.stripPrefix && !rule.addPrefix) {
      throw new Error(`Config error: routing[${i}] must have at least stripPrefix or addPrefix`);
    }

    // stripPrefix must start with /
    if (rule.stripPrefix && (typeof rule.stripPrefix !== 'string' || !rule.stripPrefix.startsWith('/'))) {
      throw new Error(`Config error: routing[${i}].stripPrefix must be a string starting with "/"`);
    }

    // addPrefix must start with /
    if (rule.addPrefix && (typeof rule.addPrefix !== 'string' || !rule.addPrefix.startsWith('/'))) {
      throw new Error(`Config error: routing[${i}].addPrefix must be a string starting with "/"`);
    }
  }
}
```

### Step 3: Pass Routing Rules Through Config Flow

**Changes needed:**

1. **`GrafemaConfig`** (ConfigLoader.ts) — add `routing?: RoutingRule[]` field (Step 1)
2. **`mergeConfig()`** (ConfigLoader.ts) — pass through `routing`
3. **`loadConfig()`** (ConfigLoader.ts) — call `validateRouting()` after `validateServices()`
4. **`OrchestratorOptions`** (Orchestrator.ts) — add `routing?: RoutingRule[]`
5. **`Orchestrator` constructor** — store `routing` rules
6. **`runPhase('ENRICHMENT', ...)`** — include routing in context

The simplest and cleanest approach: add `routing` to the `PluginContext.config` object. Currently, the ENRICHMENT phase context is built in `runPhase()` (line ~1005 of Orchestrator.ts). We can add routing to the context config:

```typescript
// In Orchestrator constructor
this.routing = options.routing;

// In runPhase, when building pluginContext:
const pluginContext: PluginContext = {
  ...context,
  config: {
    ...context.config,
    routing: this.routing,  // Pass routing rules
  },
  // ...existing fields
};
```

**Alternative (preferred):** Add `routing` directly to `PluginContext` in `@grafema/types`. This is cleaner than stuffing it into `config`, since `config` is typed as `OrchestratorConfig` and routing is a separate concern. But this changes the types package.

**Decision:** Add `routing` as a new optional field on `OrchestratorOptions` and pass through to `PluginContext` as a new field. This follows the exact same pattern as `strictMode` (REG-330) — stored on Orchestrator, passed to PluginContext in `runPhase()`.

### Step 4: Build Service-to-Path Map in HTTPConnectionEnricher

The enricher needs to know which service a node belongs to, in order to look up applicable routing rules. Strategy:

1. At the start of `execute()`, query all `SERVICE` nodes
2. Build a map: `servicePath -> serviceName`
3. For each request/route node, determine service by checking if `node.file` starts with a service's path
4. This is O(s) per node where s = number of services (tiny, usually 2-5)

```typescript
// Build service path map
const servicePathMap: Array<{ name: string; path: string }> = [];
for await (const node of graph.queryNodes({ type: 'SERVICE' })) {
  if (node.name && node.file) {
    servicePathMap.push({ name: node.name as string, path: node.file as string });
  }
}
// Sort by path length descending (most specific first)
servicePathMap.sort((a, b) => b.path.length - a.path.length);

function getServiceName(filePath: string): string | undefined {
  for (const svc of servicePathMap) {
    if (filePath.startsWith(svc.path)) return svc.name;
  }
  return undefined;
}
```

### Step 5: Apply Routing Rules in Matching

The core change in HTTPConnectionEnricher's matching loop:

```typescript
// Before matching, get routing rules from context
const routing: RoutingRule[] = (context.config as any)?.routing || [];
// Or if we add to PluginContext:
const routing = context.routing || [];

// In the inner loop, before pathsMatch():
for (const route of uniqueRoutes) {
  // ... existing method matching ...

  // Determine service ownership
  const requestService = request.file ? getServiceName(request.file) : undefined;
  const routeService = route.file ? getServiceName(route.file) : undefined;

  // Apply routing transformation if applicable
  let transformedUrl = url;
  if (requestService && routeService) {
    const rule = routing.find(r => r.from === requestService && r.to === routeService);
    if (rule) {
      transformedUrl = applyRoutingRule(url, rule);
    }
  }

  if (routePath && this.pathsMatch(transformedUrl, routePath)) {
    // ... create edges as before ...
  }
}
```

### Step 6: URL Transformation Logic

```typescript
private applyRoutingRule(url: string, rule: RoutingRule): string {
  let result = url;

  // Strip prefix first (if rule specifies)
  if (rule.stripPrefix && result.startsWith(rule.stripPrefix)) {
    result = result.slice(rule.stripPrefix.length);
    // Ensure result starts with /
    if (!result.startsWith('/')) {
      result = '/' + result;
    }
  }

  // Add prefix (if rule specifies)
  if (rule.addPrefix) {
    result = rule.addPrefix + result;
  }

  return result;
}
```

### Edge Cases & Design Decisions

1. **No routing rules configured (backward compatible):** When `routing` is undefined or empty, behavior is identical to current. Zero overhead (no service lookup needed).

2. **No services configured:** If no `SERVICE` nodes exist, routing rules can't be applied (no way to determine which service a node belongs to). Silently skip routing — log a warning.

3. **Multiple matching rules:** First match wins. Rules are ordered — the first `from/to` pair that matches is used. This is consistent with nginx/Traefik behavior.

4. **Path parameters after transformation:** `/api/users/:id` with `stripPrefix: /api` becomes `/users/:id`. The existing `pathsMatch()` handles parametric matching on the transformed URL. No changes needed.

5. **`addPrefix` use case:** Backend route is `/api/users`, frontend sends `/users`. Rule: `{ from: "frontend", to: "backend", addPrefix: "/api" }`. The request URL `/users` becomes `/api/users` before matching.

6. **Both `stripPrefix` and `addPrefix` on same rule:** Applied in order: strip first, then add. Example: frontend sends `/v2/users`, backend has `/api/users`. Rule: `{ stripPrefix: "/v2", addPrefix: "/api" }`. Transform: `/v2/users` -> `/users` -> `/api/users`.

7. **Overlapping prefixes:** `/api/v1` and `/api` — longer prefix should match first. Rules are tried in order (first match), so user controls priority by ordering in config.

8. **Service node not found for file:** If a node's file path doesn't match any service, it's treated as "unknown service." No routing rule applies — falls through to standard matching.

9. **Trailing slashes:** `stripPrefix: "/api"` should match `/api/users` but NOT `/api-v2/users`. This is why we check `startsWith(prefix)` and then verify the next char is `/` or end of string.

### Complexity Analysis

- **Service path map construction:** O(s) where s = number of SERVICE nodes. Done once per execute().
- **Service lookup per node:** O(s) per node. With 3-5 services, this is negligible.
- **Routing rule lookup:** O(r) per request-route pair where r = number of routing rules. Typically 1-5 rules.
- **Overall:** No change to asymptotic complexity. Still O(requests * routes) for matching. Added constant factor is negligible.

### Files to Modify

| File | Change |
|------|--------|
| `packages/core/src/config/ConfigLoader.ts` | Add `RoutingRule` type, `routing` field to `GrafemaConfig`, `validateRouting()`, update `mergeConfig()` |
| `packages/core/src/config/index.ts` | Export new types |
| `packages/types/src/plugins.ts` | Add `routing` to `PluginContext` (optional field) |
| `packages/core/src/Orchestrator.ts` | Add `routing` to `OrchestratorOptions`, store and pass to context |
| `packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts` | Add service resolution, routing rule application |
| `packages/cli/src/commands/analyze.ts` | Pass `config.routing` to Orchestrator |
| `packages/mcp/src/config.ts` | Pass `config.routing` (if MCP creates Orchestrator with routing) |
| `test/unit/plugins/enrichment/HTTPConnectionEnricher.test.js` | Add tests for routing rule matching |
| `test/unit/config/ConfigLoader.test.ts` | Add tests for routing validation |

### Testing Strategy

1. **ConfigLoader tests:** Valid routing configs, invalid configs (missing from/to, bad prefix format, unknown service name), empty routing
2. **HTTPConnectionEnricher unit tests:**
   - stripPrefix transforms URL correctly and creates INTERACTS_WITH edge
   - addPrefix transforms URL correctly
   - Combined stripPrefix + addPrefix
   - No routing rules = backward compatible
   - Service not found for node = no transformation
   - Parametric paths with routing rules
   - Template literals with routing rules
3. **Integration:** Extend cross-service test fixture to include prefix mismatch scenario

### Implementation Order

1. Add `RoutingRule` type + `routing` field to `GrafemaConfig` + `validateRouting()`
2. Update `mergeConfig()` + exports
3. Add `routing` to `PluginContext` types + `OrchestratorOptions`
4. Wire routing through `Orchestrator` -> `runPhase()` -> `PluginContext`
5. Wire routing through CLI `analyze.ts` and MCP `config.ts`
6. Implement service resolution + URL transformation in HTTPConnectionEnricher
7. Write tests (Kent)
8. Implementation (Rob)

### Estimated Scope

- ~150 LOC production code (config validation + enricher changes)
- ~200 LOC test code
- 4-6 files modified
- No architectural changes, pure extension of existing patterns
