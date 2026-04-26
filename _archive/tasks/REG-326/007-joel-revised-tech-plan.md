# Joel Spolsky - Revised Technical Specification for REG-326

## Executive Summary

This revised spec addresses Linus's concerns about disconnected response nodes. The implementation now includes three parts:

1. **Part A**: Fix ExpressResponseAnalyzer to create ASSIGNED_FROM edges from response nodes to actual variables
2. **Part B**: Add `--from-route` CLI option (simplified from previous spec)
3. **Part C**: Add ExpressResponseAnalyzer to DEFAULT_CONFIG

The key insight: response nodes currently float disconnected in the graph. By adding ASSIGNED_FROM edges, `traceValues()` can follow the data flow backward to find actual sources.

---

## Part A: ExpressResponseAnalyzer Data Flow Fix

### Problem Statement

Current code in `ExpressResponseAnalyzer.createResponseArgumentNode()` creates stub nodes:

```typescript
// For res.json(users):
case 'Identifier': {
  const counter = this.responseNodeCounter++;
  const id = `VARIABLE#response:${counter}#${file}#${line}:${column}`;
  await graph.addNode({
    id,
    type: 'VARIABLE',
    name: '<response>',  // NOT the actual variable name
    file, line, column
  });
  return id;  // No ASSIGNED_FROM edge!
}
```

**Result:** Response node is disconnected. `traceValues()` finds it, sees no ASSIGNED_FROM edges, returns "no_sources".

### Solution Design

When processing an Identifier in a response call (e.g., `res.json(users)`):

1. Create the response node (as before)
2. **NEW**: Resolve `users` to an existing VARIABLE/PARAMETER/CONSTANT node in the handler's scope
3. **NEW**: Create ASSIGNED_FROM edge from response node to resolved node

### A.1 Method Signature Change

Modify `createResponseArgumentNode()` to accept handler context:

```typescript
private async createResponseArgumentNode(
  graph: PluginContext['graph'],
  file: string,
  line: number,
  column: number,
  astType: string,
  routeId: string,
  handlerFunctionId: string,      // NEW: Handler function node ID
  identifierName?: string          // NEW: Actual identifier name (for Identifier case)
): Promise<string>
```

### A.2 Modify `analyzeRouteResponses()` Call Site

Update the call to `createResponseArgumentNode()`:

```typescript
// In analyzeRouteResponses(), line ~130-141
for (const call of responseCalls) {
  const dstNodeId = await this.createResponseArgumentNode(
    graph,
    handlerNode.file,
    call.argLine,
    call.argColumn,
    call.argType,
    route.id,
    handlerEdge.dst,              // NEW: Pass handler function ID
    call.identifierName           // NEW: Pass identifier name (see A.3)
  );
  // ... rest unchanged
}
```

### A.3 Extend `ResponseCallInfo` Interface

Add identifier name to the response call info:

```typescript
interface ResponseCallInfo {
  method: string;          // 'json' or 'send'
  argLine: number;
  argColumn: number;
  argType: string;
  line: number;
  identifierName?: string; // NEW: Name if argType is 'Identifier'
}
```

Update `findResponseCalls()` to capture identifier name:

```typescript
// In findResponseCalls(), when creating ResponseCallInfo
const arg = callNode.arguments[0] as Node;

calls.push({
  method: responseInfo.method,
  argLine,
  argColumn,
  argType: arg.type,
  line: getLine(callNode),
  identifierName: arg.type === 'Identifier' ? (arg as Identifier).name : undefined  // NEW
});
```

### A.4 Identifier Resolution Algorithm

Add new method `resolveIdentifierInScope()`:

```typescript
/**
 * Resolve an identifier name to an existing node in the handler's scope.
 *
 * Search order:
 * 1. Parameters of the handler function
 * 2. Variables/Constants declared in handler scope
 * 3. Module-level variables (if not found in handler)
 *
 * @param graph - Graph backend
 * @param identifierName - Name to resolve (e.g., 'users')
 * @param file - Source file path
 * @param handlerFunctionId - Handler function node ID
 * @param useLine - Line where identifier is used (must be defined before)
 * @returns Node ID if found, null otherwise
 */
private async resolveIdentifierInScope(
  graph: PluginContext['graph'],
  identifierName: string,
  file: string,
  handlerFunctionId: string,
  useLine: number
): Promise<string | null> {
  // Parse handler function ID to get scope info
  const handlerParsed = parseSemanticId(handlerFunctionId);
  if (!handlerParsed) return null;

  // Handler scope path: e.g., ['global'] or ['router'] for named functions
  const handlerScopePath = handlerParsed.scopePath;
  const handlerName = handlerParsed.name;

  // 1. Search PARAMETER nodes (req, res are params, but also custom ones like 'users' in callback)
  for await (const node of graph.queryNodes({ type: 'PARAMETER' })) {
    if (node.name !== identifierName || node.file !== file) continue;

    // Check if this parameter belongs to our handler function
    const paramParsed = parseSemanticId(node.id);
    if (!paramParsed) continue;

    // Parameter's scope should include handler function name
    if (this.scopeContainsFunction(paramParsed.scopePath, handlerName, handlerScopePath)) {
      return node.id;
    }
  }

  // 2. Search VARIABLE nodes
  for await (const node of graph.queryNodes({ type: 'VARIABLE' })) {
    if (node.name !== identifierName || node.file !== file) continue;

    // Must be declared before use
    if (typeof node.line === 'number' && node.line > useLine) continue;

    const varParsed = parseSemanticId(node.id);
    if (!varParsed) continue;

    // Variable in handler scope or ancestor scope
    if (this.scopeContainsFunction(varParsed.scopePath, handlerName, handlerScopePath)) {
      return node.id;
    }

    // Also check module-level variables (scopePath = ['global'])
    if (varParsed.scopePath.length === 1 && varParsed.scopePath[0] === 'global') {
      return node.id;
    }
  }

  // 3. Search CONSTANT nodes
  for await (const node of graph.queryNodes({ type: 'CONSTANT' })) {
    if (node.name !== identifierName || node.file !== file) continue;
    if (typeof node.line === 'number' && node.line > useLine) continue;

    const constParsed = parseSemanticId(node.id);
    if (!constParsed) continue;

    if (this.scopeContainsFunction(constParsed.scopePath, handlerName, handlerScopePath)) {
      return node.id;
    }
    if (constParsed.scopePath.length === 1 && constParsed.scopePath[0] === 'global') {
      return node.id;
    }
  }

  return null;
}
```

### A.5 Scope Matching Helper

```typescript
/**
 * Check if a node's scope path includes the handler function.
 *
 * Examples:
 * - handlerName='handler', nodeScopePath=['global','handler'] -> true
 * - handlerName='handler', nodeScopePath=['global','handler','if#0'] -> true
 * - handlerName='handler', nodeScopePath=['global','otherFn'] -> false
 */
private scopeContainsFunction(
  nodeScopePath: string[],
  handlerName: string,
  handlerScopePath: string[]
): boolean {
  // Node scope must contain handler name at appropriate level
  // handlerScopePath = ['global'] means handler is module-level anonymous
  // handlerScopePath = ['global', 'router'] means handler is in router object

  // Simple check: does node's scope path contain handler name?
  if (nodeScopePath.includes(handlerName)) {
    return true;
  }

  // For anonymous handlers (arrow functions at route definition),
  // check if node scope starts with handler's scope
  if (handlerScopePath.every((seg, i) => nodeScopePath[i] === seg)) {
    return true;
  }

  return false;
}
```

### A.6 Modified `createResponseArgumentNode()` - Identifier Case

```typescript
case 'Identifier': {
  const counter = this.responseNodeCounter++;
  const id = `VARIABLE#response:${counter}#${file}#${line}:${column}`;

  // Create response node with actual identifier name
  await graph.addNode({
    id,
    type: 'VARIABLE',
    name: identifierName || '<response>',  // Use actual name
    file,
    line,
    column
  } as NodeRecord);

  // NEW: Resolve identifier and create ASSIGNED_FROM edge
  if (identifierName && handlerFunctionId) {
    const sourceNodeId = await this.resolveIdentifierInScope(
      graph,
      identifierName,
      file,
      handlerFunctionId,
      line
    );

    if (sourceNodeId) {
      await graph.addEdge({
        type: 'ASSIGNED_FROM',
        src: id,
        dst: sourceNodeId
      });
    }
  }

  return id;
}
```

### A.7 CallExpression Handling

For `res.json(transform(data))`, the argument is a CallExpression. We should:

1. Create a CALL node for the response (as current code does)
2. Try to find a matching CALL node from JSASTAnalyzer (same file/line/column)
3. If found, create ASSIGNED_FROM edge

```typescript
case 'CallExpression': {
  const counter = this.responseNodeCounter++;
  const id = `CALL#response:${counter}#${file}#${line}:${column}`;

  await graph.addNode({
    id,
    type: 'CALL',
    name: '<response>',
    file,
    line,
    column
  } as NodeRecord);

  // NEW: Try to find existing CALL node at same location
  if (handlerFunctionId) {
    const existingCallId = await this.findCallNodeAtLocation(graph, file, line, column);
    if (existingCallId) {
      await graph.addEdge({
        type: 'ASSIGNED_FROM',
        src: id,
        dst: existingCallId
      });
    }
  }

  return id;
}
```

Add helper:

```typescript
/**
 * Find a CALL node at specific file/line/column.
 * JSASTAnalyzer creates CALL nodes, we link to them.
 */
private async findCallNodeAtLocation(
  graph: PluginContext['graph'],
  file: string,
  line: number,
  column: number
): Promise<string | null> {
  for await (const node of graph.queryNodes({ type: 'CALL' })) {
    if (node.file === file && node.line === line && node.column === column) {
      return node.id;
    }
  }
  return null;
}
```

### A.8 Required Import

Add to imports in ExpressResponseAnalyzer.ts:

```typescript
import { parseSemanticId } from '../../core/SemanticId.js';
```

### A.9 Complexity Analysis

| Operation | Complexity | Notes |
|-----------|------------|-------|
| `resolveIdentifierInScope` | O(P + V + C) | P=parameters, V=variables, C=constants in file |
| Per response call | O(P + V + C) | Called once per res.json/res.send |
| Total per route | O(R * (P + V + C)) | R = response calls in handler |

**Typical values:**
- P: 3-10 parameters per file
- V: 10-50 variables per file
- C: 5-20 constants per file
- R: 1-3 response calls per handler

**Performance:** Acceptable. Graph queries iterate only nodes of specific type.

**Optimization opportunity (future):** Add index on (file, name) for faster lookups.

---

## Part B: CLI `--from-route` Option

Per Don's recommendation, we simplify the route matching from the previous spec.

### B.1 Add CLI Option

In `/packages/cli/src/commands/trace.ts`:

```typescript
interface TraceOptions {
  project: string;
  json?: boolean;
  depth: string;
  to?: string;
  fromRoute?: string;  // NEW
}

// Add option to command (line ~87)
.option('-r, --from-route <pattern>', 'Trace from HTTP route response (e.g., "GET /api/users")')
```

### B.2 Handle `--from-route` in Action

Update the action handler (around line ~108):

```typescript
// In action handler, after the --to check:
if (options.fromRoute) {
  await handleRouteTrace(backend, options.fromRoute, projectPath, options.json, parseInt(options.depth, 10));
  return;
}
```

### B.3 Route Finding Function

Simplified version (no glob patterns needed for MVP):

```typescript
/**
 * Find route by pattern.
 *
 * Pattern formats:
 * 1. Full ID: "http:route#GET /api/users#file.js"
 * 2. Method + path: "GET /api/users"
 * 3. Path only: "/api/users"
 */
async function findRouteByPattern(
  backend: RFDBServerBackend,
  pattern: string
): Promise<string | null> {
  const trimmed = pattern.trim();

  for await (const node of backend.queryNodes({ type: 'http:route' })) {
    const routeId = node.id || '';
    const routeMethod = (node.method || '').toUpperCase();
    const routePath = node.path || node.fullPath || '';

    // 1. Exact ID match
    if (routeId === trimmed) {
      return routeId;
    }

    // 2. Method + path match
    const methodPath = `${routeMethod} ${routePath}`;
    if (methodPath === trimmed.toUpperCase() ||
        methodPath === trimmed.toUpperCase().replace(/\s+/g, ' ')) {
      return routeId;
    }

    // 3. Path-only match
    if (routePath === trimmed || routePath === trimmed.replace(/^\//, '')) {
      return routeId;
    }
  }

  return null;
}
```

### B.4 Main Route Trace Handler

```typescript
/**
 * Handle --from-route trace command.
 */
async function handleRouteTrace(
  backend: RFDBServerBackend,
  routePattern: string,
  projectPath: string,
  jsonOutput?: boolean,
  maxDepth: number = 10
): Promise<void> {
  // 1. Find the route
  const routeId = await findRouteByPattern(backend, routePattern);

  if (!routeId) {
    console.error(`No route found matching: ${routePattern}`);
    console.error('');
    console.error('Hint: Run "grafema list-routes" to see available routes');
    return;
  }

  // 2. Get route node details
  const routeNode = await backend.getNode(routeId);
  if (!routeNode) {
    console.error(`Route node not found: ${routeId}`);
    return;
  }

  const method = routeNode.method || 'GET';
  const path = routeNode.fullPath || routeNode.path || '';
  const file = routeNode.file || '';
  const line = routeNode.line || 0;

  // 3. Get RESPONDS_WITH edges
  const respondsWithEdges = await backend.getOutgoingEdges(routeId, ['RESPONDS_WITH']);

  // Prepare result structure for JSON output
  const result = {
    route: { id: routeId, method, path, file, line },
    responses: [] as any[],
    statistics: { totalSources: 0, literals: 0, parameters: 0, calls: 0, unknown: 0 }
  };

  // Human-readable header
  if (!jsonOutput) {
    console.log(`Route: ${method} ${path}`);
    console.log(`File:  ${formatPath(file, projectPath)}:${line}`);
    console.log('');
  }

  if (respondsWithEdges.length === 0) {
    if (!jsonOutput) {
      console.log('No response detected');
      console.log('');
      console.log('Hint: Ensure ExpressResponseAnalyzer is enabled in config');
    }
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  if (!jsonOutput) {
    console.log(`Found ${respondsWithEdges.length} response point(s):`);
    console.log('');
  }

  // 4. Trace each response
  for (const edge of respondsWithEdges) {
    const responseNode = await backend.getNode(edge.dst);
    if (!responseNode) continue;

    const responseMethod = (edge.metadata?.responseMethod as string) || 'json';
    const responseLine = responseNode.line || 0;

    // Call traceValues
    const traced = await traceValues(backend, edge.dst, {
      maxDepth,
      followDerivesFrom: true,
      detectNondeterministic: true
    });

    // Collect for JSON
    const responseResult = {
      responseMethod,
      line: responseLine,
      sources: traced.map(t => ({
        value: t.value,
        file: t.source.file,
        line: t.source.line,
        isUnknown: t.isUnknown,
        reason: (t as any).reason
      }))
    };
    result.responses.push(responseResult);

    // Update statistics
    for (const t of traced) {
      result.statistics.totalSources++;
      if (!t.isUnknown) {
        result.statistics.literals++;
      } else {
        const reason = (t as any).reason;
        if (reason === 'parameter') result.statistics.parameters++;
        else if (reason === 'call_result') result.statistics.calls++;
        else result.statistics.unknown++;
      }
    }

    // Human-readable output
    if (!jsonOutput) {
      console.log(`res.${responseMethod}() at line ${responseLine}:`);

      if (traced.length === 0) {
        console.log('  (no data sources found)');
        console.log('');
        continue;
      }

      for (const t of traced) {
        const srcPath = formatPath(t.source.file, projectPath);

        if (!t.isUnknown) {
          const valueStr = formatValue(t.value);
          console.log(`  LITERAL: ${valueStr}`);
          console.log(`    ${srcPath}:${t.source.line}`);
        } else {
          const reason = (t as any).reason || 'unknown';
          const label = {
            'parameter': 'PARAMETER (runtime input)',
            'call_result': 'CALL (function return)',
            'nondeterministic': 'USER INPUT (req.body, etc.)',
            'max_depth': 'MAX DEPTH (trace limit)',
            'no_sources': 'NO SOURCE (missing data flow edge)'
          }[reason] || reason;

          console.log(`  ${label}`);
          console.log(`    ${srcPath}:${t.source.line}`);
        }
      }
      console.log('');
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Summary
    const { totalSources, literals, parameters, calls, unknown } = result.statistics;
    console.log('Summary:');
    console.log(`  ${totalSources} source(s): ${literals} literals, ${parameters} parameters, ${calls} calls, ${unknown} unknown`);
  }
}

/**
 * Format file path relative to project
 */
function formatPath(filePath: string, projectPath: string): string {
  if (filePath.startsWith(projectPath)) {
    return filePath.slice(projectPath.length + 1);
  }
  return filePath;
}

/**
 * Format value for display (truncate if too long)
 */
function formatValue(value: unknown): string {
  const str = JSON.stringify(value);
  if (str.length > 60) {
    return str.slice(0, 57) + '...';
  }
  return str;
}
```

### B.5 Update Help Text

Add example to the help text (around line ~88):

```typescript
.addHelpText('after', `
Examples:
  grafema trace "userId"                     Trace all variables named "userId"
  grafema trace "userId from authenticate"   Trace userId within authenticate function
  grafema trace "config" --depth 5           Limit trace depth to 5 levels
  grafema trace "apiKey" --json              Output trace as JSON
  grafema trace --to "addNode#0.type"        Trace values reaching sink point
  grafema trace --from-route "GET /api/users"    Trace route response to data sources
  grafema trace --from-route "/api/invitations"  Trace by path only
`)
```

### B.6 Required Imports

Add to imports if not present:

```typescript
import { traceValues } from '@grafema/core';
```

---

## Part C: Add ExpressResponseAnalyzer to DEFAULT_CONFIG

### C.1 Config Change

In `/packages/core/src/config/ConfigLoader.ts`, line ~73-80:

```typescript
analysis: [
  'JSASTAnalyzer',
  'ExpressRouteAnalyzer',
  'ExpressResponseAnalyzer',  // ADD THIS LINE
  'SocketIOAnalyzer',
  'DatabaseAnalyzer',
  'FetchAnalyzer',
  'ServiceLayerAnalyzer',
],
```

### C.2 Priority Verification

ExpressResponseAnalyzer has priority 74, ExpressRouteAnalyzer has priority 75.
Lower number = runs later (after higher priority plugins).

Order is correct: ExpressRouteAnalyzer (75) runs first, creates http:route nodes.
Then ExpressResponseAnalyzer (74) runs, processes those routes.

---

## Implementation Order

**Recommended order:**

1. **Part C first** (5 minutes) - Ensures ExpressResponseAnalyzer runs by default, so we can test Parts A and B

2. **Part A second** (1-2 days) - Core fix for data flow edges. This is the critical change.

3. **Part B last** (1 day) - CLI option. Depends on Part A working correctly for meaningful results.

**Rationale:**
- Part C is trivial, do it first
- Part A is the architectural fix - without it, Part B shows "no sources" for everything
- Part B is consumer of the fix, natural to implement after Part A is verified

---

## Test Strategy

### Unit Tests for Part A

File: `test/unit/plugins/ExpressResponseAnalyzer.test.ts`

Add or extend tests:

```typescript
describe('ExpressResponseAnalyzer - Data Flow', () => {
  it('creates ASSIGNED_FROM edge for res.json(identifier)', async () => {
    // Setup: Create handler function node and variable node
    // Act: Run analyzer on code with res.json(users)
    // Assert: Response node has ASSIGNED_FROM edge to users variable
  });

  it('creates ASSIGNED_FROM edge for res.json(param)', async () => {
    // res.json(req.body) should link to PARAMETER node
  });

  it('creates ASSIGNED_FROM edge for res.json(call())', async () => {
    // res.json(transform(data)) should link to CALL node
  });

  it('resolves identifier from outer scope', async () => {
    // Module-level const CONFIG = {...}
    // Handler: res.json(CONFIG)
    // Should link to module-level CONSTANT
  });

  it('resolves identifier declared before use', async () => {
    // const users = await db.all(...)
    // res.json(users)
    // Should link, users.line < res.json.line
  });

  it('does not link to identifier declared after use', async () => {
    // res.json(users)  // line 10
    // const users = [] // line 15
    // Should NOT link (or link with warning)
  });
});
```

### Unit Tests for Part B

File: `test/unit/cli/trace-from-route.test.ts`

```typescript
describe('trace --from-route', () => {
  describe('findRouteByPattern', () => {
    it('finds route by exact ID', async () => {});
    it('finds route by "METHOD /path"', async () => {});
    it('finds route by path only', async () => {});
    it('returns null for non-existent route', async () => {});
    it('handles case-insensitive method', async () => {});
  });

  describe('handleRouteTrace output', () => {
    it('shows helpful message when no route found', async () => {});
    it('shows hint when no RESPONDS_WITH edges', async () => {});
    it('traces through ASSIGNED_FROM to literals', async () => {});
    it('reports parameters as unknown', async () => {});
    it('outputs valid JSON with --json flag', async () => {});
  });
});
```

### Integration Test

File: `test/integration/trace-from-route.test.ts`

Use fixture `test/fixtures/09-cross-service/backend/`:

```typescript
describe('trace --from-route integration', () => {
  beforeAll(async () => {
    // Run grafema analyze on fixture
  });

  it('traces GET /users to literal response', async () => {
    const result = await runCLI(['trace', '--from-route', 'GET /users', '-j']);
    expect(result.responses[0].sources).toContainEqual(
      expect.objectContaining({ isUnknown: false })
    );
  });

  it('traces variable response through ASSIGNED_FROM', async () => {
    // If fixture has: const data = {...}; res.json(data)
    // Should trace to the literal value
  });
});
```

---

## Edge Cases

### Part A Edge Cases

| Case | Behavior |
|------|----------|
| `res.json(outerScopeVar)` | Search module-level, should find |
| `res.json(this.field)` | MemberExpression, not Identifier - no special handling (creates EXPRESSION node) |
| `res.json(await fetch())` | AwaitExpression wrapping CallExpression - handle CallExpression case |
| `res.json({ ...spread })` | ObjectExpression - existing behavior (no change) |
| Identifier not found | No edge created, response node is terminal (same as before) |
| Multiple handlers same name | Scope path disambiguation via parseSemanticId |

### Part B Edge Cases

| Case | Behavior |
|------|----------|
| Route not found | Clear error message with hint |
| No RESPONDS_WITH edges | Warn about ExpressResponseAnalyzer config |
| Multiple response points | Trace all, show separately |
| Circular references | traceValues has cycle protection |
| Max depth reached | Report with "max_depth" reason |

---

## Files to Modify

| File | Changes |
|------|---------|
| `/packages/core/src/plugins/analysis/ExpressResponseAnalyzer.ts` | Part A: identifier resolution, ASSIGNED_FROM edges |
| `/packages/cli/src/commands/trace.ts` | Part B: --from-route option, handlers |
| `/packages/core/src/config/ConfigLoader.ts` | Part C: add to DEFAULT_CONFIG |

## Files to Create

| File | Purpose |
|------|---------|
| `test/unit/plugins/ExpressResponseAnalyzer-dataflow.test.ts` | Unit tests for Part A |
| `test/unit/cli/trace-from-route.test.ts` | Unit tests for Part B |
| `test/integration/trace-from-route.test.ts` | Integration test |

---

## Estimated Effort

| Part | Task | Time |
|------|------|------|
| C | Add to DEFAULT_CONFIG | 5 min |
| A | Extend createResponseArgumentNode signature | 30 min |
| A | Implement resolveIdentifierInScope | 2 hours |
| A | Implement scopeContainsFunction helper | 1 hour |
| A | Handle CallExpression case | 1 hour |
| A | Unit tests for Part A | 2 hours |
| B | CLI option and findRouteByPattern | 1 hour |
| B | handleRouteTrace implementation | 2 hours |
| B | Unit tests for Part B | 1.5 hours |
| - | Integration test | 1 hour |
| - | Manual testing and polish | 1 hour |
| **Total** | | **~13 hours (~2 days)** |

---

## Success Criteria

1. `res.json(variableName)` creates ASSIGNED_FROM edge to existing variable node
2. `traceValues` from response node reaches actual data sources (LITERAL, PARAMETER, CALL)
3. `grafema trace --from-route "GET /api/users"` shows meaningful data sources
4. ExpressResponseAnalyzer runs by default (no config needed)
5. All existing tests pass
6. New tests cover identifier resolution and CLI command

---

## Deferred to Future Work

1. **HAS_PROPERTY edges for response objects** - When `res.json({ key: val })`, should create property value edges
2. **db:query linking** - Show SQL query text in trace output
3. **MCP tool `trace_route_response`** - For agent use
4. **Glob pattern matching** - `GET /api/*` style patterns

---

*Revised technical specification by Joel Spolsky, Implementation Planner*
*Based on Don Melton's revised plan (006-don-revised-plan.md)*
