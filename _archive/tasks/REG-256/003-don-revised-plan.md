# Don Melton - Revised Plan for REG-256

## Context

Previous plan (002-don-plan.md) proposed modifying HTTPConnectionEnricher. User rejected this approach. New requirements:

1. **A separate NEW plugin** that COMPLETELY REPLACES HTTPConnectionEnricher
2. **Customer-facing API marking** — plugin sets `customerFacing: true` metadata on route nodes. If marked, unconnected routes are silent. Otherwise, unconnected endpoints raise ISSUE nodes.

User's words: "Внутри плагина надо ставить пометку customerFacing: true, на усмотрение разработчика. Если метка стоит то алярму о несвязанности не показываем, в противном случае неиспользуемые эндпоинты должны поднимать ISSUE"

---

## Analysis of Current Code

### 1. HTTPConnectionEnricher — Full Responsibility Map

**File:** `packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts` (302 lines)

| Responsibility | Lines | Description |
|---|---|---|
| Node collection | 69-83 | Queries `http:route` and `http:request` nodes |
| Deduplication | 87-93 | `deduplicateById()` removes duplicates from multi-service analysis |
| Unknown method handling | 100-137 | Strict mode: StrictModeError. Non-strict: ValidationError with `WARN_HTTP_METHOD_UNKNOWN` |
| Dynamic URL skip | 140-142 | Skips `url === 'dynamic'` or empty |
| Method matching | 146-152 | Case-insensitive. Handles `default`/`explicit`/`unknown` method sources |
| Path matching | 154 | `pathsMatch()` — normalizes Express params (`:id`) and template literals (`${...}`) to `{param}`, then exact or regex match |
| INTERACTS_WITH edge | 156-162 | request -> route, with `matchType: 'parametric' | 'exact'` |
| HTTP_RECEIVES edge | 166-183 | If request has `responseDataNode` and route has `RESPONDS_WITH` edges, creates HTTP_RECEIVES edges |
| URL normalization | 226-230 | `normalizeUrl()` — converts `:id` and `${...}` to `{param}` |
| Regex building | 271-275 | `buildParamRegex()` — splits on `{param}` and builds regex |
| Has-params check | 280-284 | `hasParams()` — checks for `:` or `${` |

**Plugin metadata:**
- Phase: ENRICHMENT
- Creates edges: INTERACTS_WITH, HTTP_RECEIVES
- Dependencies: ExpressRouteAnalyzer, FetchAnalyzer, ExpressResponseAnalyzer
- Consumes: RESPONDS_WITH
- Produces: INTERACTS_WITH, HTTP_RECEIVES

### 2. Plugin Registration System

Plugins are registered via factory maps in three locations:

1. **`packages/cli/src/commands/analyze.ts`** — `BUILTIN_PLUGINS` record, `string -> () => Plugin`
2. **`packages/mcp/src/config.ts`** — `BUILTIN_PLUGINS` record, same pattern
3. **`packages/mcp/src/analysis-worker.ts`** — same pattern (for parallel analysis)

Config selects plugins by name from `config.yaml` -> `plugins.enrichment` array. The name must match a key in `BUILTIN_PLUGINS`.

**Default config** (`ConfigLoader.ts:DEFAULT_CONFIG`): enrichment list includes `HTTPConnectionEnricher`.

**To replace:** Create `ServiceRoutingPlugin`, register it in all three factory maps, change DEFAULT_CONFIG to use it instead of `HTTPConnectionEnricher`. Old class stays for backward compat (users who explicitly name it in config), but default changes.

### 3. ISSUE Node System

**`packages/core/src/core/nodes/IssueNode.ts`:**
- Types: `issue:security`, `issue:performance`, `issue:style`, `issue:smell` (extensible via `issue:${string}`)
- ID: `issue:<category>#<hash12>` — deterministic based on plugin+file+line+column+message
- Required fields: `category`, `severity`, `message`, `plugin`, `file`, `line`
- Optional: `column`, `context` (arbitrary Record), `targetNodeId`

**Creation via `context.reportIssue()`:**
- Available ONLY in VALIDATION phase (Orchestrator adds it in `runPhase()` for VALIDATION only)
- Creates issue node + AFFECTS edge to targetNodeId
- Used by: AwaitInLoopValidator, SQLInjectionValidator, etc.

**Critical constraint:** `reportIssue` is only injected for VALIDATION phase plugins. Our new plugin runs in ENRICHMENT phase. Two options:
- Option A: Move issue creation to a companion VALIDATION plugin
- Option B: Create issue nodes directly via `graph.addNode()` (bypassing `reportIssue`)
- Option C: Make `reportIssue` available in ENRICHMENT phase too

**Recommendation: Option A** — create a separate `UnconnectedRouteValidator` in VALIDATION phase. This follows the separation of concerns: ENRICHMENT creates connections + marks metadata, VALIDATION checks invariants and creates issues. This matches the existing codebase pattern exactly (AwaitInLoopValidator, BrokenImportValidator, etc.).

### 4. Alarm System (HTTPConnectionEnricherAlarm)

The "alarm" in HTTPConnectionEnricher is actually just the unknown-method error handling (lines 100-137). There's no separate alarm class — the test file `HTTPConnectionEnricherAlarm.test.js` tests the strict/non-strict mode error paths.

The new plugin must preserve this behavior: unknown method sources should emit StrictModeError or ValidationError depending on strict mode.

### 5. Config Flow

```
config.yaml -> loadConfig() -> GrafemaConfig
                                    |
                            analyze.ts / config.ts (MCP)
                                    |
                            OrchestratorOptions { routing?, services?, strictMode?, ... }
                                    |
                            Orchestrator.constructor()
                                    |
                            runPhase('ENRICHMENT', context)
                                    |
                            PluginContext { graph, strictMode, logger, ... }
```

Currently `PluginContext` does not carry GrafemaConfig or routing. The `config` field is typed as `OrchestratorConfig` but at runtime is a partial object. Routing rules need to be threaded through.

### 6. Service Ownership

Nodes have a `file` field (absolute path). SERVICE nodes have `file = servicePath`. The relationship `SERVICE --CONTAINS--> MODULE --DEFINES--> node` exists in the graph. For service lookup:
- Query SERVICE nodes, get their paths
- For any node, check which SERVICE's path is a prefix of `node.file`

---

## Recommended Architecture

### New Plugin: `ServiceRoutingPlugin`

A **single new ENRICHMENT plugin** that replaces `HTTPConnectionEnricher`. It does everything the old one does, plus:

1. **Routing rules** from config (stripPrefix/addPrefix)
2. **Customer-facing metadata** on route nodes
3. **Unconnected route tracking** (marks connected vs unconnected)

### Companion: `UnconnectedRouteValidator`

A **new VALIDATION plugin** that runs after enrichment:
- Queries all `http:route` nodes
- Checks which have INTERACTS_WITH incoming edges (connected) vs not
- For unconnected routes: if `customerFacing: true` -> silent. Otherwise -> create ISSUE node.
- Uses `context.reportIssue()` (available in VALIDATION phase)

### Why Two Plugins Instead of One

1. **Separation of concerns:** ENRICHMENT creates connections, VALIDATION detects problems
2. **`reportIssue` availability:** Only in VALIDATION phase per Orchestrator design
3. **Matches existing patterns:** AwaitInLoopValidator (VALIDATION) checks metadata set by JSASTAnalyzer (ANALYSIS). Same pattern here.
4. **Testability:** Each plugin has a clear, focused responsibility

---

## Config Schema Changes

### 1. Add `routing` to GrafemaConfig

```typescript
// packages/core/src/config/ConfigLoader.ts

export interface RoutingRule {
  /** Service name where requests originate (must match a service in 'services') */
  from: string;
  /** Service name where routes are defined (must match a service in 'services') */
  to: string;
  /** Prefix to strip from request URL before matching */
  stripPrefix?: string;
  /** Prefix to add to request URL before matching */
  addPrefix?: string;
}

// Add to GrafemaConfig
export interface GrafemaConfig {
  // ... existing fields ...
  routing?: RoutingRule[];
}
```

### 2. Add `customerFacing` to ServiceDefinition

The user said `customerFacing: true` is "на усмотрение разработчика" (at the developer's discretion). This means it's a manual declaration, not auto-inferred.

**Three options considered:**

| Option | Declaration | Example |
|--------|------------|---------|
| A: On service definition | `customerFacing: true` on the service | `- name: backend\n  customerFacing: true` |
| B: Inferred from routing rules | Routes reachable from external `from` are customer-facing | Implicit from routing topology |
| C: Explicit list of customer-facing services | `customerFacingServices: [backend]` | Separate config section |

**Recommendation: Option A** — add `customerFacing?: boolean` to `ServiceDefinition`.

Reasoning:
- Matches user's intent: "на усмотрение разработчика" = explicit declaration
- Simple mental model: "this service is customer-facing" is a property of the service
- Does not require routing rules to exist (a service can be customer-facing without routing)
- Granularity is correct: whole service is customer-facing, not individual routes

```typescript
// packages/types/src/plugins.ts — ServiceDefinition
export interface ServiceDefinition {
  name: string;
  path: string;
  entryPoint?: string;
  /** Mark this service as customer-facing. Routes in customer-facing services
   *  are expected to have frontend consumers. Unconnected routes in non-customer-facing
   *  services do not raise issues. Default: false. */
  customerFacing?: boolean;
}
```

**Config example:**
```yaml
services:
  - name: backend
    path: apps/backend
    entryPoint: src/index.ts
    customerFacing: true     # Routes here MUST have frontend consumers
  - name: auth-service
    path: apps/auth
    entryPoint: src/index.ts
    customerFacing: true
  - name: internal-worker
    path: apps/worker
    entryPoint: src/index.ts
    # NOT customer-facing — unconnected routes are fine

routing:
  - from: frontend
    to: backend
    stripPrefix: /api
  - from: frontend
    to: auth-service
    stripPrefix: /auth
```

### 3. Pass Config to Plugins

Add `routing` to `PluginContext` following the `strictMode` pattern:

```typescript
// packages/types/src/plugins.ts — PluginContext
export interface PluginContext {
  // ... existing fields ...
  /** Routing rules from config (REG-256) */
  routing?: RoutingRule[];
  /** Service definitions from config, for service ownership resolution */
  services?: ServiceDefinition[];
}
```

Both `routing` and `services` need to be available to the plugin. `services` is needed for:
1. Building the service-to-path map (which service owns which files)
2. Reading `customerFacing` flag per service

---

## Customer-Facing API Classification

### How It Works

1. **ServiceRoutingPlugin** (ENRICHMENT):
   - Builds service path map from SERVICE nodes in graph
   - For each `http:route` node, determines owning service
   - If owning service has `customerFacing: true` in config, sets `metadata.customerFacing = true` on the route node
   - Creates INTERACTS_WITH and HTTP_RECEIVES edges as before
   - Tracks which routes got connected (have INTERACTS_WITH edges)

2. **UnconnectedRouteValidator** (VALIDATION):
   - Queries all `http:route` nodes
   - For each, checks incoming INTERACTS_WITH edges
   - If route has 0 incoming INTERACTS_WITH:
     - If `customerFacing: true` on the node -> create `issue:connectivity` ISSUE node
     - If `customerFacing` is not set or false -> skip (internal endpoint, silence is expected)

### Metadata on Route Nodes

The `customerFacing` flag is set as a metadata field directly on the `http:route` node:

```typescript
// In ServiceRoutingPlugin, after determining service ownership:
if (isCustomerFacing) {
  await graph.addNode({
    ...route,
    customerFacing: true
  });
}
```

This is the "enricher adds data to nodes, validator queries it" pattern — exactly how Grafema works (forward registration).

---

## ISSUE Node Creation Logic

### UnconnectedRouteValidator

```typescript
// For each http:route with customerFacing: true and no INTERACTS_WITH edges:
await context.reportIssue({
  category: 'connectivity',
  severity: 'warning',
  message: `Customer-facing route ${method} ${path} has no connected frontend requests`,
  file: route.file,
  line: route.line,
  targetNodeId: route.id,
  context: {
    type: 'UNCONNECTED_CUSTOMER_ROUTE',
    method: route.method,
    path: routePath,
    service: serviceName,
  }
});
```

Issue type: `issue:connectivity` — new category for route connectivity problems.

---

## Files to Create/Modify

### New Files

| File | Description |
|------|-------------|
| `packages/core/src/plugins/enrichment/ServiceRoutingPlugin.ts` | New ENRICHMENT plugin, replaces HTTPConnectionEnricher |
| `packages/core/src/plugins/validation/UnconnectedRouteValidator.ts` | New VALIDATION plugin, creates ISSUE nodes for unconnected customer-facing routes |
| `test/unit/plugins/enrichment/ServiceRoutingPlugin.test.js` | Unit tests for routing, matching, customerFacing metadata |
| `test/unit/plugins/validation/UnconnectedRouteValidator.test.js` | Unit tests for ISSUE node creation |

### Modified Files

| File | Change |
|------|--------|
| `packages/types/src/plugins.ts` | Add `routing?: RoutingRule[]` and `services?: ServiceDefinition[]` to PluginContext. Add `customerFacing?: boolean` to ServiceDefinition. Add `RoutingRule` interface. |
| `packages/core/src/config/ConfigLoader.ts` | Add `RoutingRule` type, `routing` field to `GrafemaConfig`, `validateRouting()` function, update `mergeConfig()` and `loadConfig()`. Validate `customerFacing` in `validateServices()`. |
| `packages/core/src/config/index.ts` | Export new types |
| `packages/core/src/Orchestrator.ts` | Store routing/services, pass to PluginContext in `runPhase()` |
| `packages/core/src/index.ts` | Export ServiceRoutingPlugin and UnconnectedRouteValidator |
| `packages/cli/src/commands/analyze.ts` | Add ServiceRoutingPlugin and UnconnectedRouteValidator to BUILTIN_PLUGINS. Pass routing/services to OrchestratorOptions. |
| `packages/mcp/src/config.ts` | Same as CLI |
| `packages/mcp/src/analysis-worker.ts` | Same as CLI |
| `packages/core/src/config/ConfigLoader.ts` (DEFAULT_CONFIG) | Replace `HTTPConnectionEnricher` with `ServiceRoutingPlugin` in default enrichment plugins. Add `UnconnectedRouteValidator` to default validation plugins. |

### NOT Modified (Kept for Backward Compat)

| File | Reason |
|------|--------|
| `packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts` | Stays as-is. Users with explicit `HTTPConnectionEnricher` in config still get it. |
| `test/unit/plugins/enrichment/HTTPConnectionEnricher.test.js` | Stays as-is. Tests existing behavior. |
| `test/unit/plugins/enrichment/HTTPConnectionEnricherAlarm.test.js` | Stays as-is. |

---

## ServiceRoutingPlugin — Detailed Design

### Class Structure

```typescript
export class ServiceRoutingPlugin extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ServiceRoutingPlugin',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],   // Updates existing nodes (customerFacing metadata)
        edges: ['INTERACTS_WITH', 'HTTP_RECEIVES']
      },
      dependencies: ['ExpressRouteAnalyzer', 'FetchAnalyzer', 'ExpressResponseAnalyzer', 'MountPointResolver'],
      consumes: ['RESPONDS_WITH'],
      produces: ['INTERACTS_WITH', 'HTTP_RECEIVES']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    // 1. Build service path map (SERVICE nodes -> name/path)
    // 2. Build routing rules index (from config)
    // 3. Mark customerFacing routes (based on service config)
    // 4. Collect and deduplicate http:route and http:request nodes
    // 5. Match requests to routes (with routing rule transforms)
    // 6. Create INTERACTS_WITH and HTTP_RECEIVES edges
    // 7. Return result with metadata about connections and customerFacing counts
  }
}
```

### Service Resolution

```typescript
private buildServiceMap(serviceNodes: Array<{ name: string; file: string }>): ServiceMap {
  // Returns sorted by path length (most specific first)
  // getServiceName(filePath) -> service name or undefined
}
```

### Routing Rule Application

```typescript
private applyRoutingRule(url: string, rule: RoutingRule): string {
  let result = url;

  // Strip prefix first
  if (rule.stripPrefix && result.startsWith(rule.stripPrefix)) {
    const afterPrefix = result.slice(rule.stripPrefix.length);
    // Verify prefix boundary (next char is '/' or end of string)
    if (afterPrefix === '' || afterPrefix.startsWith('/')) {
      result = afterPrefix || '/';
    }
  }

  // Add prefix
  if (rule.addPrefix) {
    // Ensure no double slash
    if (result.startsWith('/') && rule.addPrefix.endsWith('/')) {
      result = rule.addPrefix + result.slice(1);
    } else {
      result = rule.addPrefix + result;
    }
  }

  return result;
}
```

### CustomerFacing Marking

```typescript
// During route collection, mark customerFacing routes:
for (const route of routes) {
  const serviceName = getServiceName(route.file);
  const serviceDef = servicesByName.get(serviceName);
  if (serviceDef?.customerFacing) {
    await graph.addNode({
      ...route,
      customerFacing: true
    });
    customerFacingCount++;
  }
}
```

### Matching Logic

Identical to HTTPConnectionEnricher, with one addition: before `pathsMatch()`, apply routing rule if both request and route have known service ownership and a matching routing rule exists.

```typescript
// For each request-route pair:
const requestService = getServiceName(request.file);
const routeService = getServiceName(route.file);

let urlToMatch = url;
if (requestService && routeService) {
  const rule = findRoutingRule(requestService, routeService);
  if (rule) {
    urlToMatch = applyRoutingRule(url, rule);
  }
}

if (routePath && this.pathsMatch(urlToMatch, routePath)) {
  // ... create edges
}
```

---

## UnconnectedRouteValidator — Detailed Design

```typescript
export class UnconnectedRouteValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'UnconnectedRouteValidator',
      phase: 'VALIDATION',
      dependencies: ['ServiceRoutingPlugin'],
      creates: {
        nodes: ['ISSUE'],
        edges: ['AFFECTS']
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    let issueCount = 0;

    for await (const node of graph.queryNodes({ type: 'http:route' })) {
      const route = node as HTTPRouteNode;

      // Only check customer-facing routes
      if (!route.customerFacing) continue;

      // Check for INTERACTS_WITH incoming edges
      const incomingEdges = await graph.getIncomingEdges(route.id, ['INTERACTS_WITH']);

      if (incomingEdges.length === 0) {
        // Unconnected customer-facing route -> create issue
        const routePath = route.fullPath || route.path || '';
        const method = route.method || 'UNKNOWN';

        if (context.reportIssue) {
          await context.reportIssue({
            category: 'connectivity',
            severity: 'warning',
            message: `Customer-facing route ${method} ${routePath} has no frontend consumers`,
            file: route.file || '',
            line: route.line || 0,
            targetNodeId: route.id,
            context: {
              type: 'UNCONNECTED_CUSTOMER_ROUTE',
              method,
              path: routePath,
            }
          });
          issueCount++;
        }
      }
    }

    return createSuccessResult(
      { nodes: issueCount, edges: issueCount },
      { issueCount }
    );
  }
}
```

---

## Testing Strategy

### 1. ServiceRoutingPlugin Unit Tests

**File:** `test/unit/plugins/enrichment/ServiceRoutingPlugin.test.js`

Tests to write (organized by capability):

**A. Backward compatibility (no routing config):**
- All existing HTTPConnectionEnricher tests should pass when ported
- Exact match, parametric match, template literals, method matching, mount prefix (fullPath), deduplication, dynamic URL skip, unknown method handling

**B. Routing rule application:**
- `stripPrefix: /api` transforms `/api/users` -> `/users`, matches backend route `/users`
- `addPrefix: /api` transforms `/users` -> `/api/users`, matches backend route `/api/users`
- Combined `stripPrefix: /v2` + `addPrefix: /api` transforms `/v2/users` -> `/api/users`
- Prefix boundary: `/api` should NOT strip from `/api-v2/users` (prefix must end at `/` or end of string)
- No matching rule: falls through to direct path matching
- Unknown service: no transformation applied

**C. Service resolution:**
- Routes correctly attributed to services based on file paths
- Most specific service path wins (`/apps/backend/src` over `/apps/backend`)
- No SERVICE nodes: routing rules silently skipped

**D. CustomerFacing metadata:**
- Route in customer-facing service gets `customerFacing: true` metadata
- Route in non-customer-facing service does NOT get the flag
- Route with unknown service does NOT get the flag

**E. Edge cases:**
- Multiple routing rules, first match (by service pair) wins
- Request and route in same service (no routing rule applies)
- Empty routing config = no transformation
- Parametric paths + routing rules work together

### 2. UnconnectedRouteValidator Unit Tests

**File:** `test/unit/plugins/validation/UnconnectedRouteValidator.test.js`

**A. Issue creation:**
- Route with `customerFacing: true` and NO incoming INTERACTS_WITH -> creates issue
- Route with `customerFacing: true` and HAS incoming INTERACTS_WITH -> no issue
- Route WITHOUT `customerFacing` and no connections -> no issue (internal endpoint)

**B. Issue details:**
- Issue has correct category, severity, message, file, line
- Issue has AFFECTS edge to the route node
- Issue context includes method, path

**C. Edge cases:**
- No routes -> no issues
- All routes connected -> no issues
- Route with multiple INTERACTS_WITH -> no issue (connected)

### 3. Config validation tests

**File:** `test/unit/config/ConfigLoader.test.ts` (extend existing)

- Valid routing config passes validation
- Missing `from` fails
- Missing `to` fails
- Unknown service name in `from`/`to` fails
- `stripPrefix` not starting with `/` fails
- `customerFacing: true` on service definition accepted
- `customerFacing: false` on service definition accepted
- Non-boolean `customerFacing` fails

---

## Implementation Order

### Phase 1: Types & Config (foundation)

1. Add `RoutingRule` interface to `packages/types/src/plugins.ts`
2. Add `customerFacing?: boolean` to `ServiceDefinition` in `packages/types/src/plugins.ts`
3. Add `routing?: RoutingRule[]` and `services?: ServiceDefinition[]` to `PluginContext`
4. Add `routing?: RoutingRule[]` to `GrafemaConfig` in ConfigLoader
5. Add `validateRouting()` function to ConfigLoader
6. Update `validateServices()` to accept `customerFacing` (boolean validation)
7. Update `mergeConfig()` to pass through `routing`
8. Update `loadConfig()` to call `validateRouting()`

### Phase 2: Config flow (plumbing)

9. Add `routing` to `OrchestratorOptions`
10. Store routing and services in Orchestrator constructor
11. Pass routing and services to PluginContext in `runPhase()`
12. Wire in CLI `analyze.ts`: pass `config.routing` and `config.services` to Orchestrator
13. Wire in MCP `config.ts`: same

### Phase 3: ServiceRoutingPlugin (core logic)

14. Write ServiceRoutingPlugin tests (Kent)
15. Implement ServiceRoutingPlugin (Rob)
16. Register in BUILTIN_PLUGINS (CLI, MCP, analysis-worker)
17. Export from `packages/core/src/index.ts`
18. Update DEFAULT_CONFIG: replace `HTTPConnectionEnricher` with `ServiceRoutingPlugin`

### Phase 4: UnconnectedRouteValidator (issue detection)

19. Write UnconnectedRouteValidator tests (Kent)
20. Implement UnconnectedRouteValidator (Rob)
21. Register in BUILTIN_PLUGINS
22. Export from `packages/core/src/index.ts`
23. Add to DEFAULT_CONFIG validation plugins

### Phase 5: Integration & cleanup

24. Run full test suite (existing HTTPConnectionEnricher tests must still pass)
25. Run `pnpm build` and verify everything compiles
26. Verify backward compatibility: explicit `HTTPConnectionEnricher` in config still works

---

## Complexity Analysis

- **Service map construction:** O(s) where s = SERVICE node count. Once per execute().
- **Service lookup per node:** O(s) per node (linear scan, sorted by path length). s is typically 2-5.
- **Routing rule lookup:** O(r) per request-route pair. r is typically 1-5.
- **CustomerFacing marking:** O(routes) — single pass over route nodes.
- **UnconnectedRouteValidator:** O(routes) — single pass, one `getIncomingEdges()` per route.
- **No change to asymptotic complexity** vs current HTTPConnectionEnricher. Still O(requests * routes) for matching.

---

## Estimated Scope

- ~250 LOC ServiceRoutingPlugin (existing enricher is 302, we add service resolution + routing)
- ~60 LOC UnconnectedRouteValidator
- ~50 LOC config changes (types, validation, wiring)
- ~30 LOC registration/export changes
- ~400 LOC test code (ServiceRoutingPlugin tests + UnconnectedRouteValidator tests)
- **Total:** ~390 LOC production, ~400 LOC tests
- **Files:** 4 new, 8-10 modified

---

## Open Questions for User

1. **Issue category:** I propose `connectivity` as the issue category. This is a new category (existing ones: security, performance, style, smell). Alternative: `smell`. Preference?

2. **Issue severity:** I propose `warning`. Routes without frontend consumers are suspicious but not broken. Agree?

3. **Default customerFacing:** When no `customerFacing` field is specified on a service, default is `false` (no issues for unconnected routes). This means existing users get zero new issues unless they opt in. Correct?

4. **Plugin name:** `ServiceRoutingPlugin` vs `HTTPRoutingPlugin` vs `ServiceConnectionEnricher`? I lean toward `ServiceRoutingPlugin` because it emphasizes the service-aware routing aspect.
