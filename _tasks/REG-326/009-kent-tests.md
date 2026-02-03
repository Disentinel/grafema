# Kent Beck - Test Report for REG-326

## Summary

TDD tests created for REG-326: Backend value tracing from res.json() to data source.

Two test files created following the approved plan from Linus's review:

1. **Part A Tests**: `test/unit/plugins/analysis/ExpressResponseAnalyzer-dataflow.test.ts`
2. **Part B Tests**: `test/unit/cli/trace-from-route.test.ts`

---

## Test File 1: ExpressResponseAnalyzer Data Flow Tests

**File**: `/test/unit/plugins/analysis/ExpressResponseAnalyzer-dataflow.test.ts`

### Test Structure

```
ExpressResponseAnalyzer - Data Flow (REG-326)
├── res.json(paramName) - handler parameter
│   ├── should create ASSIGNED_FROM edge from response node to PARAMETER node
│   └── should resolve res.json(req.body) through parameter
├── res.json(moduleVar) - module-level variable
│   ├── should create ASSIGNED_FROM edge from response node to module-level CONSTANT
│   └── should create ASSIGNED_FROM edge from response node to module-level VARIABLE
├── res.json(localVar) - function-local variable (documented limitation)
│   ├── should NOT create ASSIGNED_FROM edge for function-local variable
│   └── should document limitation: const users = await db.all(); res.json(users)
├── res.json(transform(data)) - CallExpression linking
│   ├── should create ASSIGNED_FROM edge from response CALL to existing CALL node
│   └── should handle res.json(await asyncFn()) - AwaitExpression wrapping CallExpression
├── res.json({ literal: true }) - OBJECT_LITERAL terminal
│   ├── should NOT create ASSIGNED_FROM edge for object literal response
│   └── should handle res.json({ ...spread }) as terminal
└── Additional edge cases
    ├── should handle res.send(identifier) same as res.json(identifier)
    ├── should handle res.status(200).json(data) chained call
    ├── should resolve identifier declared BEFORE use
    └── should NOT resolve identifier declared AFTER use (if checking line numbers)
```

### Key Test Cases (from Linus's review)

| Test Case | Expected Behavior | Status |
|-----------|-------------------|--------|
| `res.json(paramName)` | ASSIGNED_FROM edge to PARAMETER node using parentFunctionId | Will FAIL until implementation |
| `res.json(moduleVar)` | ASSIGNED_FROM edge to module-level CONSTANT/VARIABLE using scope path | Will FAIL until implementation |
| `res.json(localVar)` | NO ASSIGNED_FROM edge (documented limitation) | Should PASS (limitation documented) |
| `res.json(transform(data))` | ASSIGNED_FROM edge to existing CALL node at same location | Will FAIL until implementation |
| `res.json({ literal: true })` | NO ASSIGNED_FROM edge (OBJECT_LITERAL is terminal) | Should PASS (existing behavior) |

### Critical Insight from Tests

Function-local variables are NOT in the graph. JSASTAnalyzer only creates nodes for module-level variables. This is explicitly tested as a documented limitation, not a bug to fix.

---

## Test File 2: CLI --from-route Tests

**File**: `/test/unit/cli/trace-from-route.test.ts`

### Test Structure

```
trace --from-route (REG-326)
├── findRouteByPattern
│   ├── should find route by exact node ID
│   ├── should find route by "METHOD /path" pattern
│   ├── should find route by "METHOD /path" case-insensitively
│   ├── should find route by path only
│   ├── should find route by path without leading slash
│   ├── should return null for non-existent route
│   ├── should find first match when multiple routes exist
│   ├── should handle route with path parameters
│   ├── should handle empty pattern gracefully
│   └── should handle whitespace-only pattern gracefully
├── handleRouteTrace behavior
│   ├── should detect when route has no RESPONDS_WITH edges
│   ├── should find RESPONDS_WITH edges when they exist
│   ├── should be able to trace from response node to data sources
│   ├── should handle multiple response points (conditional)
│   ├── should trace to PARAMETER for unknown values
│   └── should trace to CALL for function return values
└── JSON output format
    └── should produce valid JSON structure for route trace
```

### Route Pattern Matching Tests

| Pattern | Expected Match |
|---------|----------------|
| `http:route#GET /api/users#routes.js` | Exact ID match |
| `GET /api/users` | Method + path |
| `get /api/users` | Case-insensitive method |
| `/api/users` | Path only |
| `api/users` | Path without leading slash |

### Data Flow Trace Tests

The tests verify:
1. Route -> RESPONDS_WITH -> Response node chain exists
2. Response node -> ASSIGNED_FROM -> Source node chain can be followed
3. Source types are correctly identified (LITERAL, PARAMETER, CALL)
4. Multiple response points (conditional) are handled
5. Unknown values (parameters, call results) are properly reported

---

## Test Helpers Used

Both test files use the standard project test infrastructure:

- `createTestBackend()` from `test/helpers/TestRFDB.js` - Creates temporary RFDB backend
- `createTestOrchestrator()` from `test/helpers/createTestOrchestrator.js` - Standard plugin orchestration
- `TestBackend` class - Extended backend with cleanup support

### Part A Test Helper Functions

```typescript
async function setupTest(backend, files) // Create temp project and run analysis
async function getAllEdges(backend)       // Get all edges from graph
async function getEdgesByType(backend, type) // Filter edges by type
async function findRouteNode(backend, method, path) // Find http:route node
async function getResponseNodeFromRoute(backend, routeId) // Get response via RESPONDS_WITH
```

### Part B Test Helper Functions

```typescript
async function mockFindRouteByPattern(backend, pattern) // Mock route finder
// Tests also directly manipulate graph nodes/edges to test trace behavior
```

---

## TDD Status

All tests are written **before implementation**. Expected status:

| Test Category | Expected Result |
|--------------|-----------------|
| Parameter resolution tests | FAIL (not yet implemented) |
| Module-level variable tests | FAIL (not yet implemented) |
| Function-local variable limitation | PASS (documents limitation) |
| CallExpression linking tests | FAIL (not yet implemented) |
| OBJECT_LITERAL terminal tests | PASS (existing behavior) |
| CLI pattern matching tests | Some PASS (mock matches expected behavior) |
| CLI trace behavior tests | PASS (tests graph traversal) |

---

## Notes for Rob Pike (Implementation)

### Part A Implementation Guide

1. **Modify `createResponseArgumentNode()` signature** to accept `handlerFunctionId` and `identifierName`

2. **For Identifier case (`res.json(varName)`):**
   - Resolve using `resolveIdentifierInScope()`
   - For parameters: check `parentFunctionId` field
   - For module-level variables: use scope path matching
   - Create ASSIGNED_FROM edge if resolved

3. **For CallExpression case (`res.json(fn())`):**
   - Find existing CALL node at same file/line/column
   - Create ASSIGNED_FROM edge to that node

4. **Key insight**: Use `parseSemanticId()` for scope matching (existing infrastructure)

### Part B Implementation Guide

1. Add `--from-route` option to trace command
2. Implement `findRouteByPattern()` with three match modes
3. Implement `handleRouteTrace()` that:
   - Finds route by pattern
   - Gets RESPONDS_WITH edges
   - Calls `traceValues()` on each response node
   - Formats output (human-readable and JSON)

---

## Files Created

| File | Lines | Purpose |
|------|-------|---------|
| `test/unit/plugins/analysis/ExpressResponseAnalyzer-dataflow.test.ts` | ~450 | Part A unit tests |
| `test/unit/cli/trace-from-route.test.ts` | ~350 | Part B unit tests |

---

## Verification

Both test files verified:
- **Syntax check**: Both files parse correctly with tsx
- **Test runner**: Tests execute with node:test
- **Expected failures**: Some tests fail as expected (TDD - implementation not done yet)

```bash
# Run Part A tests
node --import tsx --test test/unit/plugins/analysis/ExpressResponseAnalyzer-dataflow.test.ts

# Run Part B tests
node --import tsx --test test/unit/cli/trace-from-route.test.ts
```

---

*Test report by Kent Beck, Test Engineer*
*Status: Tests written and verified, ready for implementation*
