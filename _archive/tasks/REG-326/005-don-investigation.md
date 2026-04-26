# Don Melton - Investigation Report for REG-326

## Investigation Summary

Linus is **correct**. The response nodes created by ExpressResponseAnalyzer are disconnected from the data flow graph. My original plan overlooked this fundamental architectural gap.

---

## Finding 1: ExpressResponseAnalyzer Not in Default Config

**Root cause of "no RESPONDS_WITH edges" in CLI analysis:**

In `/packages/core/src/config/ConfigLoader.ts`, lines 69-80:

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

**ExpressResponseAnalyzer is registered in BUILTIN_PLUGINS but NOT included in DEFAULT_CONFIG.analysis.**

This is why running `grafema analyze` on a fixture produces no RESPONDS_WITH edges - the plugin never executes unless explicitly added via config or test helpers.

**Fix required:** Add `ExpressResponseAnalyzer` to DEFAULT_CONFIG.analysis.

---

## Finding 2: Response Nodes Are Disconnected

Looking at `ExpressResponseAnalyzer.ts` lines 318-398, when processing `res.json(obj)`:

### Case A: Object Literal `res.json({ users: [] })`
```typescript
case 'ObjectExpression': {
  const id = `OBJECT_LITERAL#response:${counter}#${file}#${line}:${column}`;
  await graph.addNode({
    id,
    type: 'OBJECT_LITERAL',
    name: '<response>',
    file, line, column,
    parentRouteId: routeId
  });
  return id;
}
```

Creates a new OBJECT_LITERAL node with **no HAS_PROPERTY edges** to the actual property values.

### Case B: Variable Reference `res.json(users)`
```typescript
case 'Identifier': {
  const id = `VARIABLE#response:${counter}#${file}#${line}:${column}`;
  await graph.addNode({
    id,
    type: 'VARIABLE',
    name: '<response>',
    file, line, column
  });
  return id;
}
```

Creates a **NEW** VARIABLE node with `name: '<response>'` instead of:
1. Resolving the identifier `users` to its existing VARIABLE node
2. Creating an ASSIGNED_FROM edge

**Result:** The response node is a stub with location info but no graph connections.

---

## Finding 3: traceValues Behavior

In `traceValues.ts`:

```typescript
// Terminal: OBJECT_LITERAL - a valid structured value
if (nodeType === 'OBJECT_LITERAL') {
  results.push({
    value: node.value,
    source,
    isUnknown: false,
  });
  return;  // <-- Returns immediately, no edge traversal
}

// No edges case - unknown
if (edges.length === 0) {
  results.push({
    value: undefined,
    source,
    isUnknown: true,
    reason: 'no_sources',  // <-- This is what we'll get
  });
  return;
}
```

For Case A: OBJECT_LITERAL is terminal - returns the literal value (works for inline objects).

For Case B: The new VARIABLE node has no ASSIGNED_FROM edges - returns `no_sources` immediately.

---

## Finding 4: Cross-Service Tracing Works Differently

The existing cross-service tests pass because they trace from **frontend to backend**:

```
Frontend:
VARIABLE(data) --ASSIGNED_FROM--> CALL(response.json()) --HTTP_RECEIVES--> OBJECT_LITERAL

Tracing starts from data variable, follows to CALL, then HTTP_RECEIVES crosses to backend.
```

**REG-326 requires the reverse:**
```
Backend:
http:route --RESPONDS_WITH--> ??? --ASSIGNED_FROM--> db.query() result
```

Starting from the route's response node and tracing backward to find data sources.

---

## Verified via Tests

**Unit tests pass** because they explicitly add ExpressResponseAnalyzer:
```typescript
const orchestrator = createTestOrchestrator(backend, {
  extraPlugins: [new ExpressResponseAnalyzer()]
});
```

**CLI analysis fails** because DEFAULT_CONFIG doesn't include it.

**Test with `res.json(variable)`** would fail to trace to the variable's source because no ASSIGNED_FROM edge exists.

---

## Revised Assessment

### What Works Today
1. `http:route --RESPONDS_WITH--> OBJECT_LITERAL` edge creation (when plugin runs)
2. Cross-service tracing: frontend variable → HTTP_RECEIVES → backend response
3. Response location tracking (file, line, column)

### What Doesn't Work (Required for REG-326)
1. ExpressResponseAnalyzer not in default config
2. Response nodes have no ASSIGNED_FROM edges to actual data sources
3. For `res.json(variable)`: no link from response node to the variable
4. For `res.json({ key: val })`: no HAS_PROPERTY edges to property values
5. Cannot trace from response node backward to db:query

---

## Revised Plan Options

### Option A: Fix ExpressResponseAnalyzer Properly (Recommended)

When processing response arguments:

1. **For Identifiers (`res.json(users)`):**
   - Resolve `users` to existing VARIABLE node in same scope
   - Create `response_node --ASSIGNED_FROM--> variable_node`

2. **For Object Literals (`res.json({ key: val })`):**
   - Create HAS_PROPERTY edges to property value nodes
   - Or create ASSIGNED_FROM to inline literal nodes

**Effort estimate:** 2-3 days
- Identifier resolution within handler scope
- Test coverage for all patterns
- Integration with existing data flow edges

### Option B: AST Re-parse Workaround (Not Recommended)

Parse file again when tracing to find actual argument expression.

**Why not:**
- Duplicates analysis work
- Not reusable
- Doesn't fix the underlying graph gap

### Option C: Scope Reduction for MVP

Ship `--from-route` with limited functionality:
- Only works for inline object literals `res.json({ ... })`
- Returns "unknown source" for variable references
- Document the limitation

**Effort estimate:** 1 day
**Honest assessment:** This provides limited value. "What data does this API return?" works, but "Where does that data come from?" doesn't.

---

## Recommendation

**Split REG-326 into two tasks:**

### REG-326a: Fix ExpressResponseAnalyzer Data Flow
- Add ExpressResponseAnalyzer to DEFAULT_CONFIG
- Create ASSIGNED_FROM edge for identifier arguments
- Resolve identifiers to existing VARIABLE nodes in handler scope

### REG-326b: Add `--from-route` to trace command
- Depends on REG-326a completion
- Route matching logic
- Output formatting

This ensures we fix the graph structure before building features on top of it.

---

## Apology

Linus was right. My "80% done" claim was based on a flawed assumption that ASSIGNED_FROM chains exist from response nodes. They don't. The integration tests pass via HTTP_RECEIVES, which is a different flow direction.

I should have verified the graph structure empirically before planning. The plan was architecturally naive.

---

*Investigation by Don Melton, Tech Lead*
*Based on Linus Torvalds' critical review*
