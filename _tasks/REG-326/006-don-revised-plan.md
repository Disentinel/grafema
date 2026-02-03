# Don Melton - Revised Plan for REG-326

## Decision Summary

Per user's decision, we keep everything in REG-326 (no split). The task now includes:

1. **Part A**: Fix ExpressResponseAnalyzer to create proper data flow edges
2. **Part B**: Add `--from-route` option to trace command
3. **Part C**: Add ExpressResponseAnalyzer to DEFAULT_CONFIG

---

## Part A: Fix ExpressResponseAnalyzer Data Flow

### Problem Statement

Currently, ExpressResponseAnalyzer creates disconnected response nodes:

```typescript
// For res.json(users):
case 'Identifier': {
  const id = `VARIABLE#response:${counter}#${file}#${line}:${column}`;
  await graph.addNode({
    id,
    type: 'VARIABLE',
    name: '<response>',  // <-- NOT the actual variable name
    file, line, column
  });
  return id;  // <-- No ASSIGNED_FROM edge to the actual `users` variable
}
```

**Result:** Response node is a stub with no edges to actual data sources.

### Design: Identifier Resolution

When we encounter `res.json(identifier)`, we need to:

1. Find the existing VARIABLE/PARAMETER node for `identifier` in the handler's scope
2. Create an ASSIGNED_FROM edge from response node to that existing node

**Key insight:** ExpressResponseAnalyzer runs AFTER JSASTAnalyzer. The handler function already exists in the graph. Variables declared inside the handler are also in the graph (under the handler's scope).

### Approach: Graph Query-Based Resolution

Since ExpressResponseAnalyzer runs after JSASTAnalyzer, we can query the graph:

```typescript
// Step 1: We already have the handler function node
const handlerNode = await graph.getNode(handlerEdge.dst);

// Step 2: Find variables/parameters in handler's scope
// Query: VARIABLE/PARAMETER where parentScopeId = handlerNode.id OR in handler's scope chain

// Step 3: Match by name and position (within handler's line range)
// The identifier `users` must be defined at or before the res.json() call
```

### Implementation Details

**A1. Modify `createResponseArgumentNode()` to accept identifier info:**

```typescript
private async createResponseArgumentNode(
  graph: PluginContext['graph'],
  file: string,
  line: number,
  column: number,
  astType: string,
  routeId: string,
  handlerFunctionId: string,       // NEW: For scope resolution
  identifierName?: string           // NEW: The actual identifier name (for Identifier case)
): Promise<string>
```

**A2. For Identifier case:**

```typescript
case 'Identifier': {
  // Create the response node (unchanged)
  const counter = this.responseNodeCounter++;
  const responseId = `VARIABLE#response:${counter}#${file}#${line}:${column}`;
  await graph.addNode({
    id: responseId,
    type: 'VARIABLE',
    name: identifierName || '<response>',  // Use actual name
    file, line, column
  });

  // NEW: Resolve identifier to existing variable/parameter in handler scope
  const existingNodeId = await this.resolveIdentifierInHandler(
    graph,
    identifierName,
    file,
    handlerFunctionId,
    line  // Response call line (identifier must be defined before this)
  );

  if (existingNodeId) {
    // Create ASSIGNED_FROM edge: response node <- existing variable
    await graph.addEdge({
      type: 'ASSIGNED_FROM',
      src: responseId,
      dst: existingNodeId
    });
  }

  return responseId;
}
```

**A3. New method `resolveIdentifierInHandler()`:**

```typescript
private async resolveIdentifierInHandler(
  graph: PluginContext['graph'],
  name: string,
  file: string,
  handlerFunctionId: string,
  useLine: number
): Promise<string | null> {
  // 1. Check parameters of the handler function (req, res, next)
  // Skip res param - that's the response object, not a value
  for await (const param of graph.queryNodes({ type: 'PARAMETER' })) {
    if (param.name === name && param.file === file) {
      // Check if param belongs to handler function via semanticId or parentFunctionId
      const semanticId = param.semanticId || param.id;
      if (semanticId.includes(handlerFunctionId) || param.parentFunctionId === handlerFunctionId) {
        return param.id;
      }
    }
  }

  // 2. Check variables declared in handler's scope
  for await (const variable of graph.queryNodes({ type: 'VARIABLE' })) {
    if (variable.name === name && variable.file === file) {
      // Check if variable is within handler function
      // Approach: compare semanticId scope path with handler's scope
      const semanticId = variable.id;
      // Also check: variable.line <= useLine (must be declared before use)
      if (this.isInHandlerScope(semanticId, handlerFunctionId) && variable.line <= useLine) {
        return variable.id;
      }
    }
  }

  // 3. Check CONSTANT declarations
  for await (const constant of graph.queryNodes({ type: 'CONSTANT' })) {
    if (constant.name === name && constant.file === file) {
      if (this.isInHandlerScope(constant.id, handlerFunctionId) && constant.line <= useLine) {
        return constant.id;
      }
    }
  }

  return null;
}
```

**A4. Helper for scope checking:**

```typescript
private isInHandlerScope(nodeSemanticId: string, handlerFunctionId: string): boolean {
  // Parse semantic ID to check scope path
  // Handler function semantic ID example: "file->handler->FUNCTION->handler"
  // Variable in handler: "file->handler->VARIABLE->users"
  // Variable in inner scope: "file->handler->if#0->VARIABLE->result"

  // Simple check: semantic ID should contain handler function name in scope path
  // Better: use parseSemanticId() from @grafema/core
  const parsed = parseSemanticId(nodeSemanticId);
  if (!parsed) return false;

  // Check if handler's name is in the scope path
  // This needs the handler function name extracted from handlerFunctionId
  // ... implementation details
}
```

### Edge Cases and Complex Patterns

**Case 1: `res.json(transform(data))`**

AST type is `CallExpression`, not `Identifier`. Current code creates a CALL node.

**Solution:** The CALL node for `transform(data)` should already have ASSIGNED_FROM edges to its arguments (via JSASTAnalyzer). Our response node gets ASSIGNED_FROM to the CALL node, and traceValues follows from there.

No change needed - but we should verify CALL nodes created by ExpressResponseAnalyzer get proper edges. May need to resolve the call site similarly.

**Case 2: `res.status(200).json(data)`**

Already handled - `extractResponseInfo()` unwraps the chain correctly.

**Case 3: `res.json({ key: value })`**

AST type is `ObjectExpression`. Current code creates OBJECT_LITERAL without HAS_PROPERTY edges.

**Question:** Should we create HAS_PROPERTY edges?

**Analysis:**
- traceValues treats OBJECT_LITERAL as terminal (returns literal value)
- This is correct for inline objects - the "value" IS the object structure
- For `{ key: variable }`, the property value nodes need ASSIGNED_FROM to resolve `variable`

**Recommendation:** Consider this out of scope for MVP. Document as limitation. If needed, add in Phase 2.

**Reason:** This requires deeper AST analysis during response node creation, essentially duplicating ObjectLiteralVisitor logic in ExpressResponseAnalyzer. High complexity, moderate value.

---

## Part B: CLI `--from-route` Option

### Specification

```bash
# Usage
grafema trace --from-route "GET /api/invitations"
grafema trace --from-route "http:route#GET /api/invitations#routes.js"
```

### Implementation

**B1. Add option to traceCommand:**

```typescript
.option('-r, --from-route <pattern>', 'Trace from route response (e.g., "GET /api/users")')
```

**B2. Route resolution logic:**

```typescript
async function findRouteByPattern(
  backend: RFDBServerBackend,
  pattern: string
): Promise<string | null> {
  // Pattern can be:
  // 1. Full ID: "http:route#GET /api/users#file.js"
  // 2. Method + path: "GET /api/users"
  // 3. Just path: "/api/users"

  for await (const node of backend.queryNodes({ type: 'http:route' })) {
    const nodeMethod = node.method || '';
    const nodePath = node.path || '';

    // Match by full ID
    if (node.id === pattern) return node.id;

    // Match by "METHOD /path"
    if (`${nodeMethod} ${nodePath}` === pattern) return node.id;

    // Match by path only
    if (nodePath === pattern) return node.id;
  }

  return null;
}
```

**B3. Main handler:**

```typescript
async function handleRouteTrace(
  backend: RFDBServerBackend,
  routePattern: string,
  projectPath: string,
  jsonOutput?: boolean,
  maxDepth: number = 10
): Promise<void> {
  // 1. Find route
  const routeId = await findRouteByPattern(backend, routePattern);
  if (!routeId) {
    console.error(`No route found matching: ${routePattern}`);
    return;
  }

  // 2. Get route node info
  const routeNode = await backend.getNode(routeId);
  console.log(`Route: ${routeNode.method} ${routeNode.path}`);
  console.log(`File: ${routeNode.file}:${routeNode.line}`);
  console.log('');

  // 3. Follow RESPONDS_WITH edge to get response node
  const respondsWithEdges = await backend.getOutgoingEdges(routeId, ['RESPONDS_WITH']);

  if (respondsWithEdges.length === 0) {
    console.log('No response patterns found for this route');
    console.log('Hint: Ensure ExpressResponseAnalyzer is enabled');
    return;
  }

  console.log(`Found ${respondsWithEdges.length} response point(s):`);
  console.log('');

  // 4. For each response, trace to data sources
  for (const edge of respondsWithEdges) {
    const responseNode = await backend.getNode(edge.dst);
    const method = edge.metadata?.responseMethod || 'json';

    console.log(`res.${method}() at line ${responseNode.line}:`);

    // 5. Call traceValues on the response node
    const traced = await traceValues(backend, responseNode.id, { maxDepth });

    if (traced.length === 0) {
      console.log('  No data sources found');
      continue;
    }

    // Group by source type
    const byType = new Map<string, typeof traced>();
    for (const t of traced) {
      const type = t.isUnknown ? 'unknown' : (t.source.type || 'unknown');
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push(t);
    }

    // Display results
    for (const [type, items] of byType) {
      if (type === 'LITERAL') {
        console.log('  Literal values:');
        for (const item of items) {
          console.log(`    - ${JSON.stringify(item.value)}`);
        }
      } else if (type === 'PARAMETER') {
        console.log('  From request parameters:');
        for (const item of items) {
          console.log(`    - ${item.source.name} (${item.source.file}:${item.source.line})`);
        }
      } else if (type === 'CALL') {
        console.log('  From function calls:');
        for (const item of items) {
          console.log(`    - ${item.source.name || 'call'}() (${item.source.file}:${item.source.line})`);
        }
      } else if (type === 'db:query') {
        console.log('  From database queries:');
        for (const item of items) {
          console.log(`    - ${item.source.query || item.source.name}`);
          console.log(`      ${item.source.file}:${item.source.line}`);
        }
      } else if (type === 'unknown') {
        console.log('  Unknown sources (runtime values):');
        for (const item of items) {
          const reason = (item as any).reason || 'undetermined';
          console.log(`    - <${reason}>`);
        }
      }
    }
    console.log('');
  }
}
```

---

## Part C: Add ExpressResponseAnalyzer to DEFAULT_CONFIG

### Change

In `/packages/core/src/config/ConfigLoader.ts`:

```typescript
analysis: [
  'JSASTAnalyzer',
  'ExpressRouteAnalyzer',
  'ExpressResponseAnalyzer',    // <-- ADD THIS
  'SocketIOAnalyzer',
  'DatabaseAnalyzer',
  'FetchAnalyzer',
  'ServiceLayerAnalyzer',
],
```

**Order matters:** ExpressResponseAnalyzer (priority 74) runs after ExpressRouteAnalyzer (priority 75), which is correct.

---

## Complexity Analysis

| Component | Effort | Risk | Notes |
|-----------|--------|------|-------|
| A: Identifier resolution | 1-2 days | Medium | Graph queries may need optimization |
| A: Scope resolution helper | 0.5 day | Low | parseSemanticId exists |
| B: CLI option + route finder | 0.5 day | Low | Pattern matching |
| B: Route trace handler | 1 day | Low | Follows existing patterns |
| C: Config change | 5 min | None | Single line change |
| Tests | 1-2 days | Low | Need coverage for all patterns |

**Total estimate:** 4-6 days

---

## Test Plan

### Unit Tests

**ExpressResponseAnalyzer:**
1. `res.json(variable)` creates ASSIGNED_FROM to existing VARIABLE
2. `res.json(param)` creates ASSIGNED_FROM to PARAMETER (e.g., req.body)
3. `res.json({ key: value })` creates OBJECT_LITERAL (HAS_PROPERTY deferred)
4. `res.json(transform(data))` creates ASSIGNED_FROM to CALL node
5. `res.status(200).json(data)` chains work correctly

**CLI trace --from-route:**
1. Find route by "METHOD /path" pattern
2. Find route by path only
3. Find route by full ID
4. No route found - helpful error
5. Route with no RESPONDS_WITH - helpful message
6. Route with single response - trace output
7. Route with multiple responses - all traced

### Integration Tests

1. End-to-end: analyze fixture with Express routes, run `trace --from-route`, verify output
2. Cross-service: frontend -> backend trace still works after changes

---

## Success Criteria

1. `grafema trace --from-route "GET /api/users"` shows data sources
2. Response nodes have ASSIGNED_FROM edges to actual variables
3. traceValues reaches LITERAL/PARAMETER/CALL nodes from response
4. ExpressResponseAnalyzer runs by default (in DEFAULT_CONFIG)
5. Existing tests continue to pass

---

## Open Questions Resolved

| Question | Decision | Rationale |
|----------|----------|-----------|
| Scope resolution approach | Graph query | ExpressResponseAnalyzer runs after JSASTAnalyzer, nodes exist |
| HAS_PROPERTY for ObjectExpression | Defer to Phase 2 | High complexity, OBJECT_LITERAL terminal is acceptable for MVP |
| CallExpression handling | No change | CALL nodes already have proper edges from JSASTAnalyzer |

---

## Deferred Work (Phase 2)

1. **HAS_PROPERTY edges for response objects:** When `res.json({ key: val })`, create edges to property values
2. **db:query linking:** Trace from CALL (db.all) to db:query node for SQL display
3. **MCP tool:** `trace_route_response` for agent use

---

*Revised plan by Don Melton, Tech Lead*
*Based on investigation findings and Linus Torvalds' review*
