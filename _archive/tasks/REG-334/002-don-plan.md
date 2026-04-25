# Don Melton - High-Level Plan: REG-334 Promise Dataflow Tracking

## Problem Summary

Variable tracing stops at `new Promise()` constructor, losing the data flow through `resolve(value)` calls inside the executor callback.

```javascript
const gigs = await new Promise((resolve, reject) => {
  database.getDb().all('SELECT * FROM gigs', (err, rows) => {
    if (err) reject(err);
    else resolve(rows);  // <- Data comes from HERE
  });
});
```

Current: `gigs <- CONSTRUCTOR_CALL(Promise)` (dead end)
Expected: `gigs <- resolve(rows) <- database.all() callback <- SQL query`

## Prior Art Research

### Academic Foundation

The **Promise Graph** model from academic research ([Modeling JavaScript Promises](https://blog.acolyer.org/2017/11/10/a-model-for-reasoning-about-javascript-promises/)) provides the right theoretical foundation:

- **Value nodes**: represent value allocation sites
- **Promise nodes**: represent promise allocation sites
- **Function nodes**: represent executor/reaction functions
- **Settlement edges**: value -> promise (labeled 'resolve' or 'reject')
- **Registration edges**: promise -> function (for .then/.catch handlers)

This aligns with Grafema's graph model. We can model Promise resolution as a **settlement edge** from the resolved value to the Promise (or more practically, to the awaited variable).

### Static Analysis Limitations (Why Current Tools Miss This)

Most JavaScript static analysis tools (SonarJS, StandardJS, XO) explicitly cannot:
- Analyze data flow through promises
- Track callback argument propagation
- Handle async control flow

**This is a real gap we can fill.** Grafema's graph-based approach is better suited for this than pattern-based tools.

### Existing Patterns in Codebase

1. **HTTP_RECEIVES** in `traceValues.ts`: Already extends tracing across async boundaries (frontend -> backend). Same pattern applies to Promise resolution.

2. **SQLiteAnalyzer**: Already detects Promise-wrapped database calls but doesn't create dataflow edges - just marks `promiseWrapped: true`. This shows we know WHERE the data is, but don't connect it.

3. **DERIVES_FROM edges**: Used for complex dataflow (loops, destructuring). Promise resolution is semantically similar.

## Architecture Analysis

### Current Graph Structure for `await new Promise(executor)`

```
VARIABLE[gigs] --ASSIGNED_FROM--> CONSTRUCTOR_CALL[new Promise]
                                       |
                                       +--PASSES_ARGUMENT--> FUNCTION[executor]
                                                                  |
                                                                  +--HAS_PARAMETER--> PARAMETER[resolve]
                                                                  +--HAS_PARAMETER--> PARAMETER[reject]
```

The executor function (arrow function or function expression) is tracked. The `resolve` and `reject` parameters are tracked. What's missing is:

1. **CALLS edge from resolve() invocation to resolve PARAMETER** (or special handling)
2. **Data flow edge from resolve argument to Promise/awaited variable**

### The Missing Link: `resolve(value)` Calls

When `resolve(rows)` is called inside the executor:
- `resolve` is an Identifier referencing the executor's first parameter
- The argument `rows` is the data that flows into the Promise

The key insight: **resolve() is not a normal function call - it's a channel that carries data out of the Promise executor**.

## Proposed Approach: Settlement Edge Pattern

### New Edge Type: `RESOLVES_TO`

Create edges that explicitly mark Promise settlement data flow:

```
CALL[resolve(rows)] --RESOLVES_TO--> CONSTRUCTOR_CALL[new Promise]
         |
         +--PASSES_ARGUMENT--> VARIABLE[rows]
```

Then in `traceValues.ts`, when hitting a `CONSTRUCTOR_CALL` for Promise, follow `RESOLVES_TO` edges backward to find the actual data sources.

### Why This Approach

1. **Forward registration**: Analyzer marks data during analysis phase (resolve calls create edges)
2. **No O(n) scanning**: We don't scan all nodes - we follow specific edges
3. **Extends existing pattern**: Similar to HTTP_RECEIVES for cross-boundary tracing
4. **Plugin-compatible**: Can be a standalone enricher or analyzer extension

## Integration Point Analysis

### Option A: Extend JSASTAnalyzer (Recommended for MVP)

The JSASTAnalyzer already:
- Creates CONSTRUCTOR_CALL nodes for `new Promise()`
- Tracks function parameters including `resolve`/`reject`
- Creates PASSES_ARGUMENT edges for arguments

Add: When processing CallExpression where callee is `resolve`/`reject` parameter of a Promise executor, create RESOLVES_TO edge.

**Complexity**: Medium. Requires tracking executor scope context.

### Option B: New PromiseDataFlowEnricher (Cleaner Architecture)

Create enrichment plugin that runs after JSASTAnalyzer:
1. Find all CONSTRUCTOR_CALL nodes where `name === 'Promise'`
2. Find executor callback via PASSES_ARGUMENT edge (argIndex 0)
3. Find resolve parameter via HAS_PARAMETER
4. Find all CALL nodes inside executor that invoke `resolve`
5. Create RESOLVES_TO edges from those calls to CONSTRUCTOR_CALL

**Complexity**: Medium-High. Requires AST re-traversal or graph-based scope tracking.

### Option C: Extend traceValues.ts Only (Quickest but Incomplete)

Modify traceValues to recognize Promise CONSTRUCTOR_CALL and attempt to find resolve calls dynamically.

**Complexity**: Low, but violates "forward registration" principle. Would require expensive graph traversal on every trace.

**NOT RECOMMENDED** - would create O(n) complexity on trace operations.

## Recommended Plan: Option A (MVP) + Path to B

### Phase 1: MVP in JSASTAnalyzer (3-5 days)

1. In `analyzeFunctionBody` or `CallExpressionVisitor`:
   - Detect when we're inside a Promise executor (first arg to `new Promise()`)
   - Track `resolve` and `reject` parameter names in scope
   - When processing CallExpression with callee matching these names, create RESOLVES_TO edge

2. In `traceValues.ts`:
   - When hitting CONSTRUCTOR_CALL with `name === 'Promise'`:
     - Look for incoming RESOLVES_TO edges
     - Follow the argument of the resolve call to continue tracing

3. Tests:
   - Simple: `new Promise((resolve) => resolve(42))`
   - Callback: `new Promise((resolve) => api.call((data) => resolve(data)))`
   - Multiple resolves (conditional): `new Promise((resolve) => condition ? resolve(a) : resolve(b))`

### Phase 2: Enricher Refactor (Future)

Extract Promise logic to dedicated PromiseDataFlowEnricher for cleaner separation. This allows:
- Supporting `.then()` chains
- Supporting `Promise.resolve()` / `Promise.reject()` static methods
- Better composability with future async tracking

## Scope Boundaries

### IN SCOPE (MVP)
- `new Promise((resolve, reject) => { ... resolve(value) ... })`
- Direct resolve calls inside executor
- Nested callbacks inside executor (e.g., `db.query((err, data) => resolve(data))`)

### OUT OF SCOPE (Future Work)
- `.then()` / `.catch()` chains (REG-XXX)
- `Promise.all()` / `Promise.race()` (REG-XXX)
- `Promise.resolve(value)` static method (REG-XXX)
- `async/await` sugar (already somewhat handled by unwrapAwaitExpression)
- Reject paths (for now, focus on resolve)

## Complexity Analysis

### Time Complexity
- Analysis: O(1) per CallExpression (checking if callee is resolve parameter)
- No new O(n) iterations - integrates into existing analysis pass

### Space Complexity
- Need to track executor scope context (resolve/reject names) during function body analysis
- Minimal: Just tracking two string names per Promise executor

### Edge Count Impact
- One RESOLVES_TO edge per resolve() call
- Typical: 1-2 edges per Promise instance

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| resolve passed to external function | MVP: don't track. Future: alias tracking |
| Multiple resolve calls | Create edge for each - traceValues handles multiple sources |
| Dynamically constructed executor | Requires executor as literal function expression |
| Performance regression | Integrated into existing pass - no new iteration |

## Acceptance Criteria Mapping

| Criteria | Approach |
|----------|----------|
| Identify Promise executor callback | Check NewExpression callee === 'Promise', get arg[0] |
| Track resolve(value) as resolution value | RESOLVES_TO edge from CALL to CONSTRUCTOR_CALL |
| Create data flow edge to awaited variable | traceValues follows RESOLVES_TO to find actual sources |
| Handle callback-based APIs | Works naturally - nested callbacks create normal dataflow |

## Recommendation

**Proceed with Option A (MVP in JSASTAnalyzer)** with a clear path to enricher extraction later.

This approach:
1. Aligns with Grafema's forward-registration principle
2. Maintains O(1) per-node analysis complexity
3. Extends existing patterns (HTTP_RECEIVES precedent)
4. Delivers immediate value for the common Promise wrapper pattern
5. Sets up clean architecture for future async tracking

## Files to Modify

1. `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Executor detection and RESOLVES_TO edge creation
2. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Potentially needs RESOLVES_TO buffering
3. `/packages/core/src/queries/traceValues.ts` - Follow RESOLVES_TO edges for Promise CONSTRUCTOR_CALL
4. `/packages/core/src/storage/backends/typeValidation.ts` - Add RESOLVES_TO to valid edge types

## Questions for User

1. Should we track `reject(error)` paths in MVP or defer to future?
2. Is the SQLite analyzer's Promise detection (promiseWrapped flag) something we should leverage or replace?
3. Priority: trace accuracy vs. trace performance? (affects how many edge types we follow)
