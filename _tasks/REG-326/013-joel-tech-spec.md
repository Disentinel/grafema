# Joel Spolsky - Technical Specification for REG-326

**Date:** 2026-02-03

## Overview

This spec expands Don's revised plan into implementation-ready instructions for Part A (fix ExpressResponseAnalyzer), Part B (CLI option), and Part C (config update).

---

## Part A: Fix ExpressResponseAnalyzer to Link Response Nodes

### A.1 Extend ResponseCallInfo Interface

**File:** `/Users/vadimr/grafema-worker-5/packages/core/src/plugins/analysis/ExpressResponseAnalyzer.ts`

**Current interface (line 33-39):**
```typescript
interface ResponseCallInfo {
  method: string;          // 'json' or 'send'
  argLine: number;         // Line of the argument
  argColumn: number;       // Column of the argument
  argType: string;         // Type of the argument ('ObjectExpression', 'Identifier', etc.)
  line: number;
}
```

**Add field:**
```typescript
interface ResponseCallInfo {
  method: string;
  argLine: number;
  argColumn: number;
  argType: string;
  line: number;
  identifierName?: string;  // NEW: actual variable name for Identifier args
}
```

**Location to modify:** `findResponseCalls()` method, around line 221

**Current code:**
```typescript
calls.push({
  method: responseInfo.method,
  argLine,
  argColumn,
  argType: arg.type,
  line: getLine(callNode)
});
```

**New code:**
```typescript
calls.push({
  method: responseInfo.method,
  argLine,
  argColumn,
  argType: arg.type,
  line: getLine(callNode),
  identifierName: arg.type === 'Identifier' ? (arg as Identifier).name : undefined
});
```

---

### A.2 Modify analyzeRouteResponses() to Pass Handler Context

**File:** `/Users/vadimr/grafema-worker-5/packages/core/src/plugins/analysis/ExpressResponseAnalyzer.ts`

**Location:** `analyzeRouteResponses()` method, around line 130-151

**Current code (line 134-142):**
```typescript
const dstNodeId = await this.createResponseArgumentNode(
  graph,
  handlerNode.file,
  call.argLine,
  call.argColumn,
  call.argType,
  route.id
);
```

**Replace with:**
```typescript
const dstNodeId = await this.resolveOrCreateResponseNode(
  graph,
  handlerNode.file,
  call,
  route.id,
  handlerNode.id  // Pass handler's semantic ID for scope resolution
);
```

**Signature change:**
- **Old:** `createResponseArgumentNode(graph, file, line, column, astType, routeId)`
- **New:** `resolveOrCreateResponseNode(graph, file, call, routeId, handlerSemanticId)`

---

### A.3 Implement resolveOrCreateResponseNode() Method

**File:** `/Users/vadimr/grafema-worker-5/packages/core/src/plugins/analysis/ExpressResponseAnalyzer.ts`

**Location:** Add after `isResMethodCall()` method (after line 313)

**Full implementation:**

```typescript
/**
 * Resolve response node: find existing variable or create stub.
 *
 * For Identifier arguments (e.g., res.json(statusData)):
 * 1. Try to find existing VARIABLE/PARAMETER/CONSTANT with same name in handler scope
 * 2. If found, return existing node ID (no stub needed)
 * 3. If not found, fall back to creating stub (external/global variables)
 *
 * For non-Identifier arguments (ObjectExpression, CallExpression, etc.):
 * - Always create stub node (existing behavior)
 *
 * @param graph - Graph backend
 * @param file - Handler file path
 * @param call - Response call info (includes identifierName)
 * @param routeId - Route ID (for metadata)
 * @param handlerSemanticId - Handler function's semantic ID (for scope matching)
 * @returns Node ID (existing or newly created)
 */
private async resolveOrCreateResponseNode(
  graph: PluginContext['graph'],
  file: string,
  call: ResponseCallInfo,
  routeId: string,
  handlerSemanticId: string
): Promise<string> {
  const { argLine, argColumn, argType, identifierName } = call;

  // For Identifier arguments, try to find existing variable/parameter
  if (argType === 'Identifier' && identifierName) {
    const existingNodeId = await this.findIdentifierInScope(
      graph,
      file,
      identifierName,
      handlerSemanticId,
      argLine
    );

    if (existingNodeId) {
      return existingNodeId;  // Use existing node, no stub needed
    }
    // Fall through to create stub if not found (external/global variables)
  }

  // For non-Identifier or not-found, create stub node (existing logic)
  return this.createResponseArgumentNode(
    graph,
    file,
    argLine,
    argColumn,
    argType,
    routeId
  );
}
```

**Complexity:** O(V + C + P) where V = VARIABLE nodes, C = CONSTANT nodes, P = PARAMETER nodes. In practice, this is bounded by the number of nodes in the handler's scope (typically < 50).

---

### A.4 Implement findIdentifierInScope() Method

**File:** `/Users/vadimr/grafema-worker-5/packages/core/src/plugins/analysis/ExpressResponseAnalyzer.ts`

**Location:** Add after `resolveOrCreateResponseNode()` method

**Full implementation:**

```typescript
/**
 * Find existing VARIABLE/CONSTANT/PARAMETER node in handler scope.
 *
 * Strategy:
 * 1. Parse handler semantic ID to extract scope prefix
 * 2. Query VARIABLE/CONSTANT nodes: match by name, file, scope prefix, and line <= useLine
 * 3. Query PARAMETER nodes: match by name, file, parentFunctionId === handlerSemanticId
 *
 * Scope matching:
 * - Handler ID: "routes.js->anonymous[1]->FUNCTION->anonymous[1]"
 * - Scope prefix: "routes.js->anonymous[1]->"
 * - Variable ID: "routes.js->anonymous[1]->VARIABLE->statusData" ✓ (matches prefix)
 * - External ID: "utils.js->VARIABLE->config" ✗ (different file)
 *
 * @param graph - Graph backend
 * @param file - File path
 * @param name - Variable name to find
 * @param handlerSemanticId - Handler function's semantic ID
 * @param useLine - Line where identifier is used (variable must be declared before this)
 * @returns Node ID if found, null otherwise
 */
private async findIdentifierInScope(
  graph: PluginContext['graph'],
  file: string,
  name: string,
  handlerSemanticId: string,
  useLine: number
): Promise<string | null> {
  // Extract scope prefix from handler semantic ID
  const handlerScopePrefix = this.extractScopePrefix(handlerSemanticId);

  // Query VARIABLE nodes
  for await (const node of graph.queryNodes({ type: 'VARIABLE' })) {
    if (node.name === name && node.file === file) {
      // Check if in handler scope and declared before usage
      if (node.id.startsWith(handlerScopePrefix) && (node.line as number) <= useLine) {
        return node.id;
      }
    }
  }

  // Query CONSTANT nodes
  for await (const node of graph.queryNodes({ type: 'CONSTANT' })) {
    if (node.name === name && node.file === file) {
      if (node.id.startsWith(handlerScopePrefix) && (node.line as number) <= useLine) {
        return node.id;
      }
    }
  }

  // Query PARAMETER nodes
  for await (const node of graph.queryNodes({ type: 'PARAMETER' })) {
    if (node.name === name && node.file === file) {
      // Parameters belong to the function directly
      const parentFunctionId = (node as any).parentFunctionId;
      if (parentFunctionId === handlerSemanticId) {
        return node.id;
      }
    }
  }

  return null;  // Not found - will create stub
}

/**
 * Extract scope prefix from semantic ID.
 *
 * Examples:
 * - "routes.js->anonymous[1]->FUNCTION->anonymous[1]" -> "routes.js->anonymous[1]->"
 * - "app.js->startServer->FUNCTION->startServer" -> "app.js->startServer->"
 * - "index.js->MODULE->index.js" -> "index.js->MODULE->" (edge case, unlikely for handlers)
 *
 * Algorithm:
 * 1. Split by "->"
 * 2. Take first 2 parts (file + function name)
 * 3. Rejoin with "->" and add trailing "->"
 *
 * @param semanticId - Handler function's semantic ID
 * @returns Scope prefix for matching variables
 */
private extractScopePrefix(semanticId: string): string {
  const parts = semanticId.split('->');
  // Keep file and function name parts for scope matching
  if (parts.length >= 2) {
    return `${parts[0]}->${parts[1]}->`;
  }
  // Fallback: use full ID (shouldn't happen for handler functions)
  return semanticId;
}
```

**Complexity:**
- `findIdentifierInScope()`: O(V + C + P) where V, C, P = total nodes of each type in graph
  - Typical small project: ~1000 VARIABLE nodes, ~100 CONSTANT nodes, ~200 PARAMETER nodes → ~1300 iterations
  - With early return on first match: often O(1) - O(100)
- `extractScopePrefix()`: O(1) (simple string operations)

**Optimization opportunity (future):** Add parentScopeId index to VARIABLE/CONSTANT nodes to avoid full scan. Not in scope for REG-326.

---

### A.5 Edge Cases and Behavior

| Case | Input | Behavior | Result |
|------|-------|----------|--------|
| Local variable | `res.json(statusData)` where `statusData` is local | Finds existing VARIABLE node | Links to `routes.js->anonymous[1]->VARIABLE->statusData` |
| Parameter | `res.json(req.body)` | Finds PARAMETER node `req` (then trace through HAS_PROPERTY) | Links to `routes.js->anonymous[1]->PARAMETER->req` |
| Global/external | `res.json(globalConfig)` | Not found in handler scope | Creates stub `VARIABLE#response:N#file#line:col` |
| Object literal | `res.json({ data })` | argType ≠ 'Identifier' | Creates `OBJECT_LITERAL#response:N#...` (unchanged) |
| Call expression | `res.json(transform(x))` | argType ≠ 'Identifier' | Creates `CALL#response:N#...` (unchanged) |
| Same variable name, different scope | `res.json(userId)` in 2 different handlers | Each finds its own scoped variable | Links to correct scope-specific variable |
| Variable declared after usage | `res.json(x); const x = 1;` | line check fails | Creates stub (correct: forward reference is error) |

---

## Part B: CLI `--from-route` Option

### B.1 Add CLI Option

**File:** `/Users/vadimr/grafema-worker-5/packages/cli/src/commands/trace.ts`

**Location:** Line 87 (after `-t, --to` option)

**Add:**
```typescript
.option('-r, --from-route <pattern>', 'Trace from route response (e.g., "GET /status" or "/status")')
```

**Update interface TraceOptions (line 17-22):**
```typescript
interface TraceOptions {
  project: string;
  json?: boolean;
  depth: string;
  to?: string;
  fromRoute?: string;  // NEW
}
```

**Update help text (after line 88):**
```
  grafema trace --from-route "GET /status"  Trace values from route response
  grafema trace -r "/status"                Trace by path only
```

---

### B.2 Update Main Handler

**File:** `/Users/vadimr/grafema-worker-5/packages/cli/src/commands/trace.ts`

**Location:** Action handler, after line 108 (after sink trace handling)

**Add before "Regular trace requires pattern" check:**
```typescript
// Handle route-based trace if --from-route option is provided
if (options.fromRoute) {
  await handleRouteTrace(backend, options.fromRoute, projectPath, options.json);
  return;
}
```

**Update error message (line 117):**
```typescript
exitWithError('Pattern required', ['Provide a pattern, use --to for sink trace, or --from-route for route trace']);
```

---

### B.3 Implement Route Matching Function

**File:** `/Users/vadimr/grafema-worker-5/packages/cli/src/commands/trace.ts`

**Location:** Add after `handleSinkTrace()` function (after line 744)

**Full implementation:**

```typescript
/**
 * Find route by pattern.
 *
 * Supports:
 * - "METHOD /path" format (e.g., "GET /status")
 * - "/path" format (e.g., "/status")
 *
 * Matching strategy:
 * 1. Try exact "METHOD PATH" match
 * 2. Try "/PATH" only match (any method)
 *
 * @param backend - Graph backend
 * @param pattern - Route pattern (with or without method)
 * @returns Route node or null if not found
 */
async function findRouteByPattern(
  backend: RFDBServerBackend,
  pattern: string
): Promise<NodeInfo | null> {
  const trimmed = pattern.trim();

  for await (const node of backend.queryNodes({ type: 'http:route' })) {
    const method = (node as any).method || '';
    const path = (node as any).path || '';

    // Match "METHOD /path"
    if (`${method} ${path}` === trimmed) {
      return {
        id: node.id,
        type: node.type || 'http:route',
        name: `${method} ${path}`,
        file: node.file || '',
        line: node.line
      };
    }

    // Match "/path" only (ignore method)
    if (path === trimmed) {
      return {
        id: node.id,
        type: node.type || 'http:route',
        name: `${method} ${path}`,
        file: node.file || '',
        line: node.line
      };
    }
  }

  return null;
}
```

**Complexity:** O(R) where R = number of http:route nodes (typically < 100)

---

### B.4 Implement Route Trace Handler

**File:** `/Users/vadimr/grafema-worker-5/packages/cli/src/commands/trace.ts`

**Location:** Add after `findRouteByPattern()` function

**Full implementation:**

```typescript
/**
 * Handle route-based trace (--from-route option).
 *
 * Flow:
 * 1. Find route by pattern
 * 2. Get RESPONDS_WITH edges from route
 * 3. For each response node: call traceValues()
 * 4. Format and display results grouped by response call
 *
 * @param backend - Graph backend
 * @param pattern - Route pattern (e.g., "GET /status" or "/status")
 * @param projectPath - Project root path
 * @param jsonOutput - Whether to output as JSON
 */
async function handleRouteTrace(
  backend: RFDBServerBackend,
  pattern: string,
  projectPath: string,
  jsonOutput?: boolean
): Promise<void> {
  // Find route
  const route = await findRouteByPattern(backend, pattern);

  if (!route) {
    console.log(`Route not found: ${pattern}`);
    console.log('');
    console.log('Hint: Use "grafema query" to list available routes');
    return;
  }

  console.log(`Route: ${route.name} (${route.file}:${route.line || '?'})`);
  console.log('');

  // Get RESPONDS_WITH edges
  const respondsWithEdges = await backend.getOutgoingEdges(route.id, ['RESPONDS_WITH']);

  if (respondsWithEdges.length === 0) {
    console.log('No response data found for this route.');
    console.log('');
    console.log('Hint: Make sure ExpressResponseAnalyzer is in your config.');
    return;
  }

  // Trace each response
  for (let i = 0; i < respondsWithEdges.length; i++) {
    const edge = respondsWithEdges[i];
    const responseNode = await backend.getNode(edge.dst);

    if (!responseNode) continue;

    const responseMethod = edge.metadata?.responseMethod || 'unknown';
    console.log(`Response ${i + 1} (res.${responseMethod} at line ${responseNode.line || '?'}):`);

    // Trace values from this response node
    const traced = await traceValues(backend, responseNode.id, {
      maxDepth: 10,
      followDerivesFrom: true,
      detectNondeterministic: true
    });

    if (traced.length === 0) {
      console.log('  No data sources found (response may be external or complex)');
    } else {
      console.log('  Data sources:');

      // Group by source type
      const literals = traced.filter(t => !t.isUnknown && t.source.type === 'LITERAL');
      const unknowns = traced.filter(t => t.isUnknown);
      const others = traced.filter(t => !t.isUnknown && t.source.type !== 'LITERAL');

      // Show literals
      for (const lit of literals) {
        const relativePath = lit.source.file.startsWith(projectPath)
          ? lit.source.file.substring(projectPath.length + 1)
          : lit.source.file;
        console.log(`    [LITERAL] ${JSON.stringify(lit.value)} at ${relativePath}:${lit.source.line}`);
      }

      // Show other sources (VARIABLE, CALL, etc.)
      for (const other of others) {
        const relativePath = other.source.file.startsWith(projectPath)
          ? other.source.file.substring(projectPath.length + 1)
          : other.source.file;
        console.log(`    [${other.source.type}] ${other.source.name || '<unnamed>'} at ${relativePath}:${other.source.line}`);
      }

      // Show unknowns
      for (const unk of unknowns) {
        const relativePath = unk.source.file.startsWith(projectPath)
          ? unk.source.file.substring(projectPath.length + 1)
          : unk.source.file;
        console.log(`    [UNKNOWN] ${unk.reason || 'runtime input'} at ${relativePath}:${unk.source.line}`);
      }
    }

    console.log('');
  }

  if (jsonOutput) {
    // TODO: JSON output format (future enhancement)
    console.log('JSON output not yet implemented for --from-route');
  }
}
```

**Complexity:**
- Route lookup: O(R) where R = http:route nodes
- Edge queries: O(1) per edge (indexed)
- Value tracing: O(D * E) where D = depth (10), E = ASSIGNED_FROM edges per node (typically 1-3)
- Total: O(R + N * D * E) where N = number of response nodes per route (typically 1-3)

---

### B.5 Output Examples

**Case 1: Simple literal response**
```
Route: GET /status (backend/routes.js:21)

Response 1 (res.json at line 23):
  Data sources:
    [VARIABLE] statusData at backend/routes.js:22
    [LITERAL] {"status":"ok","uptime":12345} at backend/routes.js:22

```

**Case 2: Database query response**
```
Route: GET /users (backend/routes.js:45)

Response 1 (res.json at line 48):
  Data sources:
    [CALL] db.all at backend/routes.js:47
    [UNKNOWN] database query result at backend/routes.js:47

```

**Case 3: Route not found**
```
Route not found: GET /nonexistent

Hint: Use "grafema query" to list available routes
```

**Case 4: No response data**
```
Route: GET /health (backend/routes.js:10)

No response data found for this route.

Hint: Make sure ExpressResponseAnalyzer is in your config.
```

---

## Part C: Add ExpressResponseAnalyzer to DEFAULT_CONFIG

**File:** `/Users/vadimr/grafema-worker-5/packages/core/src/config/ConfigLoader.ts`

**Location:** Line 73-80 (analysis array in DEFAULT_CONFIG)

**Current:**
```typescript
analysis: [
  'JSASTAnalyzer',
  'ExpressRouteAnalyzer',
  'SocketIOAnalyzer',
  'DatabaseAnalyzer',
  'FetchAnalyzer',
  'ServiceLayerAnalyzer',
],
```

**New:**
```typescript
analysis: [
  'JSASTAnalyzer',
  'ExpressRouteAnalyzer',
  'ExpressResponseAnalyzer',  // ADD after ExpressRouteAnalyzer
  'SocketIOAnalyzer',
  'DatabaseAnalyzer',
  'FetchAnalyzer',
  'ServiceLayerAnalyzer',
],
```

**Why after ExpressRouteAnalyzer:** ExpressResponseAnalyzer has priority 74, which is 1 less than ExpressRouteAnalyzer (75). Array order in config should match execution order.

---

## Complexity Analysis Summary

### Part A: ExpressResponseAnalyzer Changes

| Operation | Complexity | Notes |
|-----------|------------|-------|
| `extractScopePrefix()` | O(1) | String split and join |
| `findIdentifierInScope()` | O(V + C + P) | Full scan of VARIABLE, CONSTANT, PARAMETER nodes |
| `resolveOrCreateResponseNode()` | O(V + C + P) | Calls `findIdentifierInScope()` once |
| Per-route analysis | O(N * (V + C + P)) | N = response calls per route (typically 1-3) |
| Overall plugin execution | O(R * N * (V + C + P)) | R = routes, N = responses per route |

**Typical numbers:**
- R = 50 routes
- N = 2 responses per route
- V + C + P = 1500 nodes
- Total: 50 * 2 * 1500 = 150,000 operations (< 1 second)

**Future optimization:** Add `parentScopeId` index to reduce O(V + C + P) to O(log n) or O(1).

### Part B: CLI `--from-route` Option

| Operation | Complexity | Notes |
|-----------|------------|-------|
| `findRouteByPattern()` | O(R) | Linear scan of http:route nodes |
| `getOutgoingEdges()` | O(1) | Indexed edge lookup |
| `traceValues()` | O(D * E) | D = depth (10), E = edges per node (~3) |
| Overall | O(R + N * D * E) | N = responses per route (1-3) |

**Typical numbers:**
- R = 50 routes
- N = 2 responses per route
- D * E = 10 * 3 = 30
- Total: 50 + 2 * 30 = 110 operations (< 10ms)

### Part C: Config Change

No runtime complexity impact (static configuration).

---

## Test Plan

### A. Unit Tests for ExpressResponseAnalyzer

**File:** Create `/Users/vadimr/grafema-worker-5/test/unit/analysis/ExpressResponseAnalyzer.test.ts`

**Test cases:**

1. **Test: Local variable linking**
   - Input: `res.json(statusData)` where `statusData` is local variable
   - Expected: RESPONDS_WITH edge points to existing `VARIABLE->statusData` node
   - Verify: No stub node created

2. **Test: Parameter linking**
   - Input: `res.json(req)` where `req` is function parameter
   - Expected: RESPONDS_WITH edge points to existing `PARAMETER->req` node
   - Verify: No stub node created

3. **Test: External variable fallback**
   - Input: `res.json(globalConfig)` where `globalConfig` is not in handler scope
   - Expected: Stub node created with type VARIABLE
   - Verify: Stub node name is `<response>`

4. **Test: Object literal (unchanged behavior)**
   - Input: `res.json({ status: 'ok' })`
   - Expected: Stub node created with type OBJECT_LITERAL
   - Verify: Existing behavior preserved

5. **Test: Call expression (unchanged behavior)**
   - Input: `res.json(transform(data))`
   - Expected: Stub node created with type CALL
   - Verify: Existing behavior preserved

6. **Test: Multiple routes, same variable name**
   - Input: Two handlers each with `res.json(userId)` in different scopes
   - Expected: Each route links to its own scoped `userId` variable
   - Verify: No cross-scope pollution

7. **Test: Variable declared after usage**
   - Input: `res.json(x); const x = 1;`
   - Expected: Stub node created (forward reference should fail)
   - Verify: Correctness check (line <= useLine)

8. **Test: extractScopePrefix() edge cases**
   - Input: `"routes.js->anonymous[1]->FUNCTION->anonymous[1]"`
   - Expected: `"routes.js->anonymous[1]->"`
   - Input: `"app.js->MODULE->app.js"` (edge case)
   - Expected: `"app.js->MODULE->"` or handle gracefully

### B. Unit Tests for CLI `--from-route` Option

**File:** Create `/Users/vadimr/grafema-worker-5/test/unit/commands/trace-route.test.ts`

**Test cases:**

1. **Test: findRouteByPattern() - exact match**
   - Input: Pattern `"GET /status"`, route exists
   - Expected: Route node returned with matching method and path

2. **Test: findRouteByPattern() - path-only match**
   - Input: Pattern `"/status"`, route `GET /status` exists
   - Expected: Route node returned (ignores method)

3. **Test: findRouteByPattern() - not found**
   - Input: Pattern `"GET /nonexistent"`
   - Expected: null

4. **Test: handleRouteTrace() - route with responses**
   - Input: Route with 2 RESPONDS_WITH edges
   - Expected: Output shows 2 response sections with traced values

5. **Test: handleRouteTrace() - route without responses**
   - Input: Route with no RESPONDS_WITH edges
   - Expected: Helpful hint about ExpressResponseAnalyzer

6. **Test: handleRouteTrace() - route not found**
   - Input: Non-existent route pattern
   - Expected: Helpful hint to use `grafema query`

### C. Integration Test

**File:** Use existing `/Users/vadimr/grafema-worker-5/test/fixtures/09-cross-service`

**Test scenario:**
1. Ensure fixture has Express route with `res.json(variable)`
2. Run `grafema analyze` on fixture
3. Verify graph contains:
   - http:route node
   - RESPONDS_WITH edge
   - Edge points to existing VARIABLE node (not stub)
4. Run `grafema trace --from-route "GET /status"` (or whatever route exists)
5. Verify output shows:
   - Route info
   - Response call info
   - Traced value sources

**Success criteria:**
- No stub nodes created for local variables
- `traceValues()` reaches actual data sources
- CLI output is clear and actionable

---

## Files to Modify

| File | Lines Changed | Complexity |
|------|---------------|------------|
| `/Users/vadimr/grafema-worker-5/packages/core/src/plugins/analysis/ExpressResponseAnalyzer.ts` | ~150 lines | Medium |
| `/Users/vadimr/grafema-worker-5/packages/cli/src/commands/trace.ts` | ~120 lines | Medium |
| `/Users/vadimr/grafema-worker-5/packages/core/src/config/ConfigLoader.ts` | 1 line | Trivial |

**Total:** ~270 lines of new/modified code

---

## Implementation Order

1. **Part A** (ExpressResponseAnalyzer changes):
   - A.1: Extend ResponseCallInfo interface
   - A.2: Modify analyzeRouteResponses() call site
   - A.3: Implement resolveOrCreateResponseNode()
   - A.4: Implement findIdentifierInScope() and extractScopePrefix()
   - A.5: Write unit tests

2. **Part B** (CLI option):
   - B.1: Add CLI option to trace command
   - B.2: Update main handler
   - B.3: Implement findRouteByPattern()
   - B.4: Implement handleRouteTrace()
   - B.5: Write unit tests

3. **Part C** (Config):
   - C.1: Add ExpressResponseAnalyzer to DEFAULT_CONFIG

4. **Integration:**
   - Run integration test on fixture
   - Verify end-to-end flow works

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Full scan of VARIABLE nodes is slow | Low | Medium | Add parentScopeId index (future) |
| Scope prefix extraction breaks on edge cases | Low | High | Extensive unit tests, fallback logic |
| False matches (same name, different file) | Low | High | File check in findIdentifierInScope() |
| Forward references not handled | Low | Low | Line check (line <= useLine) |
| Route pattern matching ambiguous | Medium | Low | Clear error messages, examples in help text |

---

## Success Criteria

1. ✅ `res.json(variable)` links to existing VARIABLE node (not stub)
2. ✅ `traceValues()` from response node reaches actual data sources
3. ✅ `grafema trace --from-route "GET /status"` shows meaningful output
4. ✅ ExpressResponseAnalyzer runs by default (in DEFAULT_CONFIG)
5. ✅ All existing tests pass
6. ✅ New unit tests cover edge cases
7. ✅ Integration test demonstrates end-to-end flow

---

## Out of Scope / Deferred Issues

| Issue | Reason | Future Ticket |
|-------|--------|---------------|
| ASSIGNED_FROM for ObjectExpression | Pre-existing JSASTAnalyzer gap | Create separate Linear issue |
| HAS_PROPERTY edges for response objects | Complex, low ROI for MVP | Defer to v0.3+ |
| Optimize scope queries with index | Performance not critical yet | Tech debt if needed |
| JSON output for --from-route | Low priority, can add later | Enhancement ticket |

**Recommendation:** Create Linear issue for "ASSIGNED_FROM edges missing for ObjectExpression initializers"
- Team: Reginaflow
- Project: Grafema
- Labels: `Bug`, `v0.2`
- Description: Variables initialized with object literals (`const x = { ... }`) have no ASSIGNED_FROM edges. Add handler in `JSASTAnalyzer.trackVariableAssignment()` for `ObjectExpression` AST nodes.

---

## Estimated Effort

| Component | Effort | Notes |
|-----------|--------|-------|
| Part A: ExpressResponseAnalyzer | 2.5 days | Implementation + unit tests |
| Part B: CLI option | 1.5 days | Implementation + unit tests |
| Part C: Config change | 0.1 days | Trivial |
| Integration testing | 0.5 days | End-to-end verification |
| **Total** | **4.5 days** | Matches Don's estimate |

---

*Technical specification by Joel Spolsky, Implementation Planner*
*Ready for Kent Beck (tests) and Rob Pike (implementation)*
