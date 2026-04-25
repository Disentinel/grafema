# Kent Beck: Test Report for REG-200

## Summary

Created TDD tests for REG-200: CONSTRUCTOR_CALL nodes and ASSIGNED_FROM edges for NewExpression.

**File created:** `/Users/vadimr/grafema-worker-3/test/unit/ConstructorCallTracking.test.js`

## Test Structure

Tests follow existing patterns from `ObjectMutationTracking.test.js` and `DataFlowTracking.test.js`:
- Uses `createTestBackend()` and `createTestOrchestrator()` helpers
- Proper cleanup in `beforeEach`/`after` hooks
- Clear assertions with helpful error messages

## Test Scenarios Covered

### 1. Built-in constructors (3 tests)

```javascript
// Test: should create CONSTRUCTOR_CALL node for new Date() with isBuiltin=true
const date = new Date();
// Expected: VARIABLE(date) --ASSIGNED_FROM--> CONSTRUCTOR_CALL(className=Date, isBuiltin=true)

// Test: should create CONSTRUCTOR_CALL node for new Map() with isBuiltin=true
const cache = new Map();
// Expected: VARIABLE(cache) --ASSIGNED_FROM--> CONSTRUCTOR_CALL(className=Map, isBuiltin=true)

// Test: should recognize all standard built-in constructors
// Tests: Date, Map, Set, WeakMap, WeakSet, Array, Object, RegExp, Error, Promise
```

### 2. User-defined class constructors (2 tests)

```javascript
// Test: should create CONSTRUCTOR_CALL node for user-defined class with isBuiltin=false
class Database {}
const db = new Database();
// Expected: VARIABLE(db) --ASSIGNED_FROM--> CONSTRUCTOR_CALL(className=Database, isBuiltin=false)

// Test: should handle class with constructor parameters
class HttpClient {
  constructor(config) { this.config = config; }
}
const client = new HttpClient(config);
// Expected: Same pattern
```

### 3. Multiple constructors in same file (1 test)

```javascript
// Test: should create distinct CONSTRUCTOR_CALL nodes for multiple new expressions
const d1 = new Date();
const d2 = new Date();
const m = new Map();
// Expected: 3 distinct CONSTRUCTOR_CALL nodes (different line/column)
```

### 4. Data flow query (1 test)

```javascript
// Test: should allow tracing variable value source to CONSTRUCTOR_CALL
const client = new HttpClient(config);
// Query: trace ASSIGNED_FROM edge from client
// Expected: Returns CONSTRUCTOR_CALL node with className=HttpClient
```

### 5. CONSTRUCTOR_CALL node attributes (2 tests)

```javascript
// Test: should include file path in CONSTRUCTOR_CALL node
// Test: should include correct line and column numbers
```

### 6. Edge cases (5 tests)

- `new` inside function
- `new` inside arrow function
- `new` inside class method
- `new` with member expression callee (`new module.Database()`)
- Chained new expression (`new Builder().build()`)

### 7. Integration with existing patterns (2 tests)

- Coexistence with LITERAL assignments
- Coexistence with CALL assignments

### 8. No INVOKES edges (1 test)

```javascript
// Test: should NOT create INVOKES edge from CONSTRUCTOR_CALL to CLASS
// Per simplified spec - no INVOKES edges for constructor calls
```

## Total: 17 Tests

| Category | Count |
|----------|-------|
| Built-in constructors | 3 |
| User-defined constructors | 2 |
| Multiple constructors | 1 |
| Data flow query | 1 |
| Node attributes | 2 |
| Edge cases | 5 |
| Integration | 2 |
| No INVOKES | 1 |

## Expected State: RED

Tests are designed to **FAIL** until Rob implements:
1. `CONSTRUCTOR_CALL` node type
2. `isBuiltin` field detection
3. ASSIGNED_FROM edge from VARIABLE to CONSTRUCTOR_CALL
4. Proper line/column/file metadata

## Key Assertions

Each test verifies:
1. Variable exists (`n.type === 'VARIABLE' || n.type === 'CONSTANT'`)
2. ASSIGNED_FROM edge exists from variable
3. Edge destination is CONSTRUCTOR_CALL node
4. CONSTRUCTOR_CALL has correct attributes:
   - `className` (e.g., "Date", "HttpClient")
   - `isBuiltin` (true for Date/Map/Set, false for user classes)
   - `file` (source file path)
   - `line` and `column` (position)

## Notes

- Tests cannot run in current environment (RFDB server binary not available)
- Tests match existing patterns and will work when server is available
- All assertions include helpful error messages for debugging
