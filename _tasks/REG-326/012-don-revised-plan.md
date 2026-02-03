# Don Melton - Revised Plan for REG-326 (Take 2)

**Date:** 2026-02-03

## Summary of Changes from Previous Plan

The previous plan was blocked by REG-327 (function-local variables not in graph). That blocker is now resolved:
- Local variables ARE in the graph (verified: `statusData` exists as `routes.js->anonymous[1]->VARIABLE->statusData`)
- Local variables have proper `parentScopeId` linking them to their function scope

However, during verification I discovered additional issues:

### Issue 1: ASSIGNED_FROM edges missing for ObjectExpression initializers

When a variable is initialized with an object literal:
```javascript
const statusData = { status: 'ok', timestamp: Date.now() };
```

The variable node is created, but `trackVariableAssignment()` in JSASTAnalyzer doesn't have a handler for `ObjectExpression`. This means no ASSIGNED_FROM edge is created.

**Scope:** This is a pre-existing gap, NOT specific to REG-326. Should be tracked as separate issue.

### Issue 2: ExpressResponseAnalyzer creates disconnected response nodes (Original Issue)

When ExpressResponseAnalyzer finds `res.json(statusData)`:
1. It creates a NEW stub node with ID like `VARIABLE#response:0#file#line:col`
2. This stub has name `<response>`, NOT `statusData`
3. NO ASSIGNED_FROM edge connects the stub to the existing `statusData` variable

**Result:** `traceValues()` from the response node dead-ends immediately.

---

## Task Scope

Per user's previous decision, REG-326 includes:

1. **Part A**: Fix ExpressResponseAnalyzer to link response nodes to existing variables
2. **Part B**: Add `--from-route` option to trace command
3. **Part C**: Add ExpressResponseAnalyzer to DEFAULT_CONFIG

---

## Part A: Fix ExpressResponseAnalyzer Response-Variable Linking

### Problem Analysis

Current flow in `ExpressResponseAnalyzer.createResponseArgumentNode()`:

```typescript
case 'Identifier': {
  const counter = this.responseNodeCounter++;
  const id = `VARIABLE#response:${counter}#${file}#${line}:${column}`;
  await graph.addNode({
    id,
    type: 'VARIABLE',
    name: '<response>',  // NOT the actual variable name
    file, line, column
  });
  return id;  // No ASSIGNED_FROM edge to actual variable
}
```

### Solution Design

When the response argument is an Identifier (e.g., `res.json(statusData)`):

1. **Don't create a new stub node** - instead, find the existing variable
2. **Query the graph** for VARIABLE/PARAMETER matching:
   - Same name as identifier
   - Same file
   - Within handler function scope (use handler's semantic ID prefix)
3. **If found**: Return the existing variable's ID directly (no new node needed)
4. **If not found**: Fall back to creating stub node (external/global variables)

### Implementation Details

**A1. Capture identifier name during AST traversal**

In `findResponseCalls()`, when the argument is Identifier, capture its name:

```typescript
interface ResponseCallInfo {
  method: string;
  argLine: number;
  argColumn: number;
  argType: string;
  line: number;
  identifierName?: string;  // NEW: actual variable name for Identifier args
}

// In the CallExpression visitor:
if (arg.type === 'Identifier') {
  calls.push({
    method: responseInfo.method,
    argLine,
    argColumn,
    argType: arg.type,
    line: getLine(callNode),
    identifierName: (arg as Identifier).name  // NEW
  });
}
```

**A2. Modify analyzeRouteResponses() to pass handler context**

```typescript
private async analyzeRouteResponses(
  route: NodeRecord,
  graph: PluginContext['graph']
): Promise<number> {
  // ... existing code to get handlerNode ...

  // Pass handler's semantic ID for scope resolution
  const handlerSemanticId = handlerNode.id; // or handlerNode.semanticId

  for (const call of responseCalls) {
    const dstNodeId = await this.resolveOrCreateResponseNode(
      graph,
      handlerNode.file,
      call,
      route.id,
      handlerSemanticId  // NEW parameter
    );
    // ... create RESPONDS_WITH edge ...
  }
}
```

**A3. New method: resolveOrCreateResponseNode()**

Replace `createResponseArgumentNode()` with smarter resolution:

```typescript
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
      graph, file, identifierName, handlerSemanticId, argLine
    );

    if (existingNodeId) {
      return existingNodeId;  // Use existing node, no stub needed
    }
    // Fall through to create stub if not found
  }

  // For non-Identifier or not-found, create stub node (existing logic)
  return this.createResponseArgumentNode(graph, file, argLine, argColumn, argType, routeId);
}
```

**A4. New method: findIdentifierInScope()**

```typescript
private async findIdentifierInScope(
  graph: PluginContext['graph'],
  file: string,
  name: string,
  handlerSemanticId: string,
  useLine: number
): Promise<string | null> {
  // Strategy: Find VARIABLE/PARAMETER/CONSTANT where:
  // 1. name matches
  // 2. file matches
  // 3. Either: semantic ID starts with handler prefix (in handler scope)
  //    Or: is a PARAMETER of the handler function

  // Parse handler semantic ID to get scope prefix
  // Example: "routes.js->anonymous[1]->FUNCTION->anonymous[1]"
  // Variables in scope: "routes.js->anonymous[1]->VARIABLE->statusData"
  const handlerScopePrefix = this.extractScopePrefix(handlerSemanticId);

  // Query VARIABLE nodes
  for await (const node of graph.queryNodes({ type: 'VARIABLE' })) {
    if (node.name === name && node.file === file) {
      // Check if in handler scope
      if (node.id.startsWith(handlerScopePrefix) && node.line <= useLine) {
        return node.id;
      }
    }
  }

  // Query CONSTANT nodes
  for await (const node of graph.queryNodes({ type: 'CONSTANT' })) {
    if (node.name === name && node.file === file) {
      if (node.id.startsWith(handlerScopePrefix) && node.line <= useLine) {
        return node.id;
      }
    }
  }

  // Query PARAMETER nodes
  for await (const node of graph.queryNodes({ type: 'PARAMETER' })) {
    if (node.name === name && node.file === file) {
      // Parameters belong to the function directly
      if (node.parentFunctionId === handlerSemanticId) {
        return node.id;
      }
    }
  }

  return null;  // Not found - will create stub
}

private extractScopePrefix(semanticId: string): string {
  // "routes.js->anonymous[1]->FUNCTION->anonymous[1]"
  // -> "routes.js->anonymous[1]->"
  const parts = semanticId.split('->');
  // Keep file and function name parts for scope matching
  if (parts.length >= 2) {
    return `${parts[0]}->${parts[1]}->`;
  }
  return semanticId;
}
```

### Edge Cases

| Case | Behavior |
|------|----------|
| `res.json(statusData)` where `statusData` is local | Links to existing VARIABLE |
| `res.json(req.body)` (parameter access) | Links to existing PARAMETER |
| `res.json(globalConfig)` (external variable) | Creates stub (can't trace) |
| `res.json({ data })` (object literal) | Creates OBJECT_LITERAL (existing behavior) |
| `res.json(transform(x))` (call expression) | Creates CALL stub (existing behavior) |

---

## Part B: CLI `--from-route` Option

### Specification

```bash
grafema trace --from-route "GET /status"
grafema trace --from-route "/status"
grafema trace -r "GET /status"
```

### Implementation

**B1. Add option to trace command** (`packages/cli/src/commands/traceCommand.ts`):

```typescript
.option('-r, --from-route <pattern>', 'Trace from route response (e.g., "GET /api/users")')
```

**B2. Route matching logic**:

```typescript
async function findRouteByPattern(
  backend: RFDBServerBackend,
  pattern: string
): Promise<NodeRecord | null> {
  for await (const node of backend.queryNodes({ type: 'http:route' })) {
    const method = node.method || '';
    const path = node.path || '';

    // Match "METHOD /path"
    if (`${method} ${path}` === pattern) return node;

    // Match "/path" only
    if (path === pattern) return node;
  }
  return null;
}
```

**B3. Main handler flow**:

1. Find route by pattern
2. Get RESPONDS_WITH edges from route
3. For each response node: call existing `traceValues()`
4. Format and display results grouped by source type

### Output Format

```
Route: GET /status (backend/routes.js:21)

Response 1 (res.send at line 23):
  Data sources:
    [VARIABLE] statusData (backend/routes.js:22)
      <- [LITERAL] { status: 'ok' }  (no further trace)

  OR:
    [CALL] db.all() (backend/routes.js:22)
      <- [db:query] SELECT * FROM users WHERE id = ?
```

---

## Part C: Add ExpressResponseAnalyzer to DEFAULT_CONFIG

Single line change in `packages/core/src/config/ConfigLoader.ts`:

```typescript
analysis: [
  'JSASTAnalyzer',
  'ExpressRouteAnalyzer',
  'ExpressResponseAnalyzer',  // ADD
  'SocketIOAnalyzer',
  // ...
],
```

---

## Out of Scope / Deferred

| Item | Reason |
|------|--------|
| ASSIGNED_FROM for ObjectExpression | Pre-existing gap, not REG-326 specific. Track separately. |
| HAS_PROPERTY edges for response objects | Complex, low value for MVP |
| Tracing through transform functions | Requires deeper call graph analysis |

### Recommendation: Create Issue

Create a new Linear issue for: "ASSIGNED_FROM edges missing for ObjectExpression initializers"
- Affects: `const x = { ... }` pattern
- Location: `JSASTAnalyzer.trackVariableAssignment()` missing `ObjectExpression` handler
- Impact: Variables initialized with object literals have no data flow edges

---

## Complexity Analysis

| Component | Effort | Risk |
|-----------|--------|------|
| A1: Capture identifier name | 0.5 day | Low |
| A2-A3: Resolve existing nodes | 1 day | Medium (graph queries) |
| A4: Scope prefix extraction | 0.5 day | Low |
| B: --from-route CLI | 1 day | Low |
| C: Config change | 5 min | None |
| Tests | 1 day | Low |

**Total: 4-5 days**

---

## Test Plan

### Unit Tests

**ExpressResponseAnalyzer:**
1. `res.json(localVar)` - links to existing VARIABLE node
2. `res.json(param)` - links to existing PARAMETER (e.g., `req.body`)
3. `res.json(external)` - creates stub (variable not in handler scope)
4. `res.json({ ... })` - creates OBJECT_LITERAL (unchanged)
5. `res.json(fn())` - creates CALL stub (unchanged)

**CLI --from-route:**
1. Find by "METHOD /path"
2. Find by "/path" only
3. No route found - helpful error
4. Route with response - shows trace
5. Route without RESPONDS_WITH - shows hint about ExpressResponseAnalyzer

### Integration Test

Use `test/fixtures/09-cross-service`:
1. Analyze fixture
2. Run `grafema trace --from-route "GET /status"`
3. Verify output shows `statusData` variable

---

## Success Criteria

1. `res.json(variable)` links to existing VARIABLE node (not stub)
2. `traceValues()` from response node reaches the actual data sources
3. `grafema trace --from-route "GET /status"` shows meaningful output
4. ExpressResponseAnalyzer runs by default
5. All existing tests pass

---

*Revised plan by Don Melton, Tech Lead*
