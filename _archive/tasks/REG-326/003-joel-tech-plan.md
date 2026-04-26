# Joel Spolsky - Technical Specification for REG-326

## Executive Summary

This spec extends the `grafema trace` command with a `--from-route` option to trace API response data back to its sources (database queries, literals, user input). The implementation builds on existing infrastructure: `traceValues()` for backward tracing, `RESPONDS_WITH` edges for route-to-response mapping, and http:route nodes created by ExpressRouteAnalyzer.

## Phase 1: CLI Command Extension

### 1.1 Command Interface

```bash
# Full route ID (exact match)
grafema trace --from-route "http:route#GET:/api/users#/path/to/file.js#42"

# Pattern match (method + path)
grafema trace --from-route "GET /api/users"
grafema trace --from-route "GET /users"

# Path only (matches any HTTP method)
grafema trace --from-route "/api/users"

# Glob-style path matching
grafema trace --from-route "GET /api/*"
grafema trace --from-route "*/invitations"
```

**Options:**
- `-p, --project <path>` - Project path (default: `.`)
- `-d, --depth <n>` - Max trace depth (default: `10`)
- `-j, --json` - Output as JSON
- `--all` - Show all routes with their traces (without pattern argument)

### 1.2 Route Matching Strategy

**Matching priority (first match wins):**

1. **Exact ID match** - If pattern starts with `http:route#`, match node ID directly
2. **Method + path** - Pattern like `GET /users` matches route with method=GET and path=/users (or fullPath=/users)
3. **Path only** - Pattern like `/users` matches any route with path=/users regardless of method
4. **Glob matching** - Pattern like `GET /api/*` uses simple glob (convert `*` to regex `[^/]*`)

**Path normalization:**
- Strip leading/trailing slashes for comparison
- Normalize Express params: `:id` treated as wildcard in matching

```typescript
function matchRoute(pattern: string, route: HttpRouteNode): boolean {
  // 1. Exact ID match
  if (pattern.startsWith('http:route#')) {
    return route.id === pattern;
  }

  // 2. Parse pattern: "METHOD /path" or just "/path"
  const methodMatch = pattern.match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(.+)$/i);
  let method: string | null = null;
  let pathPattern: string;

  if (methodMatch) {
    method = methodMatch[1].toUpperCase();
    pathPattern = methodMatch[2].trim();
  } else {
    pathPattern = pattern.trim();
  }

  // 3. Check method (if specified)
  if (method && route.method?.toUpperCase() !== method) {
    return false;
  }

  // 4. Check path (use fullPath from MountPointResolver if available)
  const routePath = route.fullPath || route.path;
  return pathsMatchWithGlob(pathPattern, routePath);
}
```

### 1.3 Core Implementation Flow

```
1. Parse --from-route pattern
2. Find matching http:route nodes
3. For each route:
   a. Follow RESPONDS_WITH edges to get response nodes
   b. For each response node, call traceValues()
   c. Aggregate and format results
4. Display results (text or JSON)
```

**Key code changes in `/packages/cli/src/commands/trace.ts`:**

```typescript
interface TraceOptions {
  project: string;
  json?: boolean;
  depth: string;
  to?: string;
  fromRoute?: string;  // NEW: --from-route option
  all?: boolean;       // NEW: --all for listing all routes
}

// Add option to command
.option('-r, --from-route <pattern>', 'Trace from http:route (e.g., "GET /api/users")')
.option('--all', 'Show all routes with traces (use with --from-route)')

// In action handler:
if (options.fromRoute) {
  await handleRouteTrace(backend, options.fromRoute, projectPath, {
    json: options.json,
    maxDepth: parseInt(options.depth, 10),
    all: options.all
  });
  return;
}
```

### 1.4 New Function: `handleRouteTrace`

```typescript
interface RouteTraceResult {
  route: {
    id: string;
    method: string;
    path: string;
    fullPath?: string;
    file: string;
    line: number;
  };
  responseNodes: Array<{
    id: string;
    type: string;
    responseMethod?: string;  // 'json' | 'send' from RESPONDS_WITH metadata
  }>;
  traces: Array<{
    responseNodeId: string;
    sources: TracedValue[];
  }>;
  statistics: {
    responseCount: number;
    totalSources: number;
    literalCount: number;
    parameterCount: number;
    callResultCount: number;
    dbQueryCount: number;  // Count of sources that are db:query nodes
  };
}

async function handleRouteTrace(
  backend: RFDBServerBackend,
  pattern: string,
  projectPath: string,
  options: {
    json?: boolean;
    maxDepth?: number;
    all?: boolean;
  }
): Promise<void> {
  const maxDepth = options.maxDepth ?? 10;

  // Find matching routes
  const routes = await findMatchingRoutes(backend, pattern);

  if (routes.length === 0) {
    console.log(`No routes found matching pattern: ${pattern}`);
    console.log('\nHint: Try --all to see available routes');
    return;
  }

  if (routes.length > 10 && !options.all) {
    console.log(`Found ${routes.length} matching routes.`);
    console.log('Showing first 10. Use --all to see all.');
    routes.length = 10;
  }

  const results: RouteTraceResult[] = [];

  for (const route of routes) {
    const result = await traceRoute(backend, route, maxDepth);
    results.push(result);
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    displayRouteTraceResults(results, projectPath);
  }
}
```

### 1.5 Route Finding: `findMatchingRoutes`

```typescript
async function findMatchingRoutes(
  backend: RFDBServerBackend,
  pattern: string
): Promise<HttpRouteNode[]> {
  const routes: HttpRouteNode[] = [];

  for await (const node of backend.queryNodes({ type: 'http:route' })) {
    if (matchRoute(pattern, node as HttpRouteNode)) {
      routes.push(node as HttpRouteNode);
    }
  }

  // Sort by: method (GET first), then path alphabetically
  routes.sort((a, b) => {
    const methodOrder = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    const aOrder = methodOrder.indexOf(a.method || 'GET');
    const bOrder = methodOrder.indexOf(b.method || 'GET');
    if (aOrder !== bOrder) return aOrder - bOrder;
    return (a.path || '').localeCompare(b.path || '');
  });

  return routes;
}
```

### 1.6 Route Tracing: `traceRoute`

```typescript
async function traceRoute(
  backend: RFDBServerBackend,
  route: HttpRouteNode,
  maxDepth: number
): Promise<RouteTraceResult> {
  // 1. Get RESPONDS_WITH edges
  const respondsWithEdges = await backend.getOutgoingEdges(route.id, ['RESPONDS_WITH']);

  const responseNodes: RouteTraceResult['responseNodes'] = [];
  const traces: RouteTraceResult['traces'] = [];

  // Statistics counters
  let literalCount = 0;
  let parameterCount = 0;
  let callResultCount = 0;
  let dbQueryCount = 0;

  // 2. For each response node, trace values
  for (const edge of respondsWithEdges) {
    const responseNode = await backend.getNode(edge.dst);
    if (!responseNode) continue;

    responseNodes.push({
      id: edge.dst,
      type: responseNode.type || 'UNKNOWN',
      responseMethod: edge.metadata?.responseMethod as string
    });

    // 3. Trace values from response node
    const traced = await traceValues(backend, edge.dst, {
      maxDepth,
      followDerivesFrom: true,
      detectNondeterministic: true
    });

    traces.push({
      responseNodeId: edge.dst,
      sources: traced
    });

    // Count source types
    for (const t of traced) {
      if (!t.isUnknown) {
        literalCount++;
      } else {
        switch (t.reason) {
          case 'parameter':
            parameterCount++;
            break;
          case 'call_result':
            callResultCount++;
            // Check if this is a db:query call
            const node = await backend.getNode(t.source.id);
            if (node?.type === 'db:query') {
              dbQueryCount++;
            }
            break;
        }
      }
    }
  }

  return {
    route: {
      id: route.id,
      method: route.method || 'GET',
      path: route.path || '',
      fullPath: route.fullPath,
      file: route.file || '',
      line: route.line || 0
    },
    responseNodes,
    traces,
    statistics: {
      responseCount: responseNodes.length,
      totalSources: traces.reduce((sum, t) => sum + t.sources.length, 0),
      literalCount,
      parameterCount,
      callResultCount,
      dbQueryCount
    }
  };
}
```

### 1.7 Output Format: `displayRouteTraceResults`

```typescript
function displayRouteTraceResults(
  results: RouteTraceResult[],
  projectPath: string
): void {
  for (const result of results) {
    const { route, statistics, traces } = result;

    // Route header
    console.log(`\n${route.method} ${route.fullPath || route.path}`);
    const relPath = route.file.startsWith(projectPath)
      ? route.file.slice(projectPath.length + 1)
      : route.file;
    console.log(`  ${relPath}:${route.line}`);

    if (statistics.responseCount === 0) {
      console.log('  No response detected (missing res.json/res.send)');
      continue;
    }

    // Response summary
    console.log(`  Responses: ${statistics.responseCount}`);

    // Show traced values
    console.log('\n  Data sources:');

    for (const trace of traces) {
      for (const source of trace.sources) {
        const srcRelPath = source.source.file.startsWith(projectPath)
          ? source.source.file.slice(projectPath.length + 1)
          : source.source.file;

        if (!source.isUnknown) {
          // Literal value
          const valueStr = JSON.stringify(source.value);
          const truncated = valueStr.length > 50
            ? valueStr.slice(0, 47) + '...'
            : valueStr;
          console.log(`    - ${truncated} (LITERAL)`);
          console.log(`      ${srcRelPath}:${source.source.line}`);
        } else {
          // Unknown source
          const reasonLabel = {
            'parameter': 'PARAMETER (runtime input)',
            'call_result': 'CALL (function return)',
            'nondeterministic': 'USER INPUT (req.body, etc.)',
            'max_depth': 'MAX DEPTH (trace limit)',
            'no_sources': 'NO SOURCE (missing edges)'
          }[source.reason || 'no_sources'];

          console.log(`    - <${reasonLabel}>`);
          console.log(`      ${srcRelPath}:${source.source.line}`);
        }
      }
    }

    // Summary
    console.log(`\n  Summary: ${statistics.literalCount} literals, ` +
      `${statistics.parameterCount} parameters, ` +
      `${statistics.callResultCount} calls` +
      (statistics.dbQueryCount > 0 ? `, ${statistics.dbQueryCount} db:query` : ''));
  }
}
```

### 1.8 JSON Output Structure

```json
{
  "route": {
    "id": "http:route#GET:/api/users#/app/routes.js#15",
    "method": "GET",
    "path": "/api/users",
    "fullPath": "/api/users",
    "file": "/app/routes.js",
    "line": 15
  },
  "responseNodes": [
    {
      "id": "OBJECT_LITERAL#response:0#/app/routes.js#16:10",
      "type": "OBJECT_LITERAL",
      "responseMethod": "json"
    }
  ],
  "traces": [
    {
      "responseNodeId": "OBJECT_LITERAL#response:0#/app/routes.js#16:10",
      "sources": [
        {
          "value": { "users": [], "total": 0 },
          "source": { "id": "...", "file": "/app/routes.js", "line": 16 },
          "isUnknown": false
        }
      ]
    }
  ],
  "statistics": {
    "responseCount": 1,
    "totalSources": 1,
    "literalCount": 1,
    "parameterCount": 0,
    "callResultCount": 0,
    "dbQueryCount": 0
  }
}
```

## Phase 2: MCP Tool (Future)

Add `trace_route_response` tool to `/packages/mcp/src/definitions.ts` and handler.

**Tool definition:**
```typescript
{
  name: 'trace_route_response',
  description: `Trace an HTTP route's response data back to its sources.

Given an HTTP route (e.g., "GET /api/users"), finds what data sources contribute
to the response: literals, database queries, user input (req.body), etc.

Use this to understand what data an API endpoint returns and where it comes from.`,
  inputSchema: {
    type: 'object',
    properties: {
      route: {
        type: 'string',
        description: 'Route pattern: "GET /api/users", "/users", or full ID'
      },
      depth: {
        type: 'number',
        description: 'Max trace depth (default: 10)'
      }
    },
    required: ['route']
  }
}
```

## Complexity Analysis

### Time Complexity

| Operation | Complexity | Notes |
|-----------|------------|-------|
| Find routes | O(R) | R = number of http:route nodes |
| Pattern matching | O(1) per route | Simple string/regex comparison |
| RESPONDS_WITH edges | O(E) | E = edges from route (typically 1-3) |
| traceValues | O(V * D) | V = visited nodes, D = depth |

**Total per route:** O(R + V * D)

**Worst case:** Large codebase with 1000 routes, 100 nodes in trace chain, depth 10:
- Route finding: O(1000) = ~1000 comparisons
- Tracing: O(100 * 10) = ~1000 node visits

**Performance safeguards:**
- Default depth limit: 10
- Route limit without --all: 10
- Cycle detection in traceValues (visited set)

### Space Complexity

| Structure | Space |
|-----------|-------|
| Route list | O(R) |
| Visited set (trace) | O(V) |
| Results | O(R * S) | S = sources per route |

**Memory:** Proportional to routes matched, not total codebase size.

## Edge Cases

### 1. Multiple routes match pattern
**Behavior:** Show all matches, limit to 10 by default.
```
$ grafema trace --from-route "/api/*"
Found 25 matching routes. Showing first 10. Use --all to see all.

GET /api/users
  ...
```

### 2. No route found
**Behavior:** Helpful error with suggestion.
```
$ grafema trace --from-route "GET /nonexistent"
No routes found matching pattern: GET /nonexistent

Hint: Try --all to see available routes
```

### 3. Route has no RESPONDS_WITH edge
**Cause:** Handler doesn't use res.json() or res.send(), or ExpressResponseAnalyzer didn't detect it.
**Behavior:** Report clearly.
```
GET /api/health
  routes/health.js:15
  No response detected (missing res.json/res.send)
```

### 4. Multiple RESPONDS_WITH edges (conditional responses)
**Example:** `if (error) res.json({ error }) else res.json({ data })`
**Behavior:** Trace all response paths.
```
GET /api/item/:id
  routes/items.js:33
  Responses: 2

  Data sources:
    Response 1 (json):
    - {"error": "Not found"} (LITERAL)
      routes/items.js:35

    Response 2 (json):
    - <CALL (function return)>
      routes/items.js:38
```

### 5. Circular reference in data flow
**Cause:** `a = b; b = a;`
**Behavior:** traceValues handles with visited set, stops at cycle.

### 6. Max depth reached
**Behavior:** Reports with `max_depth` reason.
```
    - <MAX DEPTH (trace limit)>
      deeply/nested/file.js:99
```

## Test Strategy

### Unit Tests (`test/unit/cli/trace-from-route.test.ts`)

1. **Route matching:**
   - Exact ID match
   - Method + path match
   - Path only match
   - Glob pattern match
   - Case insensitivity for methods
   - Express param normalization

2. **traceRoute function:**
   - Route with single res.json(literal)
   - Route with res.send(variable)
   - Route with conditional responses
   - Route with no RESPONDS_WITH edges
   - Route tracing to PARAMETER
   - Route tracing to CALL (including db calls)

3. **Output formatting:**
   - Text output structure
   - JSON output structure
   - Path relativization

### Integration Tests (`test/integration/trace-from-route.test.ts`)

Using existing `test/fixtures/09-cross-service` fixture:

1. **End-to-end trace:**
   - `grafema trace --from-route "GET /users"` traces to OBJECT_LITERAL
   - `grafema trace --from-route "POST /items"` traces to variable

2. **Pattern matching integration:**
   - Glob pattern finds multiple routes
   - Exact path finds single route

### Test Fixtures Needed

Can reuse existing `test/fixtures/09-cross-service/backend/routes.js` which already has:
- GET /users - res.json(literal)
- GET /status - res.send(variable)
- POST /items - res.status(201).json(variable)
- GET /item/:id - conditional responses
- GET /health - named handler

**Optional enhancement for Phase 3:** Add fixture with db.all() call.

## Files to Modify

| File | Changes |
|------|---------|
| `/packages/cli/src/commands/trace.ts` | Add `--from-route` option, new handlers |
| `/packages/core/src/queries/index.ts` | Export new types if needed |

## Files to Create

| File | Purpose |
|------|---------|
| `test/unit/cli/trace-from-route.test.ts` | Unit tests for route matching and tracing |
| `test/integration/trace-from-route.test.ts` | Integration tests |

## Open Questions Resolved

### Q1: How to find routes by pattern?
**Answer:** Iterate `http:route` nodes, apply pattern matching. O(R) is acceptable since route count is small (typically <100 even in large projects).

### Q2: What if route has multiple RESPONDS_WITH?
**Answer:** Trace all of them, show as "Response 1", "Response 2", etc.

### Q3: How to connect CALL to db:query?
**Answer:** For Phase 1, we rely on existing traceValues which stops at CALL with `call_result` reason. The CALL node's file/line can be used to manually check. Phase 3 will add RETURNS edge from db:query to make this automatic.

### Q4: Response object structure tracing?
**Answer:** Current ExpressResponseAnalyzer creates response OBJECT_LITERAL nodes but doesn't connect HAS_PROPERTY edges to property values. traceValues will stop at the OBJECT_LITERAL. Phase 3 enhancement to add property edges if needed.

## Implementation Checklist

- [ ] Add `--from-route` option to trace command
- [ ] Implement `matchRoute()` function
- [ ] Implement `findMatchingRoutes()` function
- [ ] Implement `traceRoute()` function
- [ ] Implement `handleRouteTrace()` function
- [ ] Implement `displayRouteTraceResults()` function
- [ ] Add help text examples
- [ ] Write unit tests for route matching
- [ ] Write unit tests for tracing
- [ ] Write integration tests
- [ ] Manual testing with real codebase

## Estimated Effort

| Task | Time |
|------|------|
| CLI option and handlers | 4 hours |
| Route matching logic | 2 hours |
| Output formatting | 2 hours |
| Unit tests | 3 hours |
| Integration tests | 2 hours |
| Manual testing & polish | 1 hour |
| **Total** | **14 hours (~2 days)** |

---

*Technical specification by Joel Spolsky, Implementation Planner*
*Based on Don Melton's high-level plan (002-don-plan.md)*
