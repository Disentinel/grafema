# Kent Beck - Test Report: PROPERTY_ACCESS Nodes (REG-395)

## Status: TESTS WRITTEN (RED STATE)

Tests are written, executable, and FAILING as expected. Implementation comes next.

## Test File Location

`/Users/vadimr/grafema-worker-4/test/unit/plugins/analysis/ast/property-access.test.ts`

## Test Execution

```bash
node --test test/unit/plugins/analysis/ast/property-access.test.ts
```

Current result: **All tests FAIL** (expected - feature not implemented yet)

## Test Coverage

### 15 Test Suites, 29 Individual Tests

#### 1. Simple Property Access (3 tests)
- ✓ Basic `obj.prop` creates PROPERTY_ACCESS node
- ✓ Node includes file and line information
- ✓ Method calls (`obj.method()`) do NOT create PROPERTY_ACCESS (only CALL)

#### 2. Chained Property Access (2 tests)
- ✓ `a.b.c` creates two nodes: `b` on `a`, `c` on `a.b`
- ✓ Deep nesting: `obj.l1.l2.l3.l4` creates 4 nodes with correct objectName chains

#### 3. this.prop Access (1 test)
- ✓ `this.value` creates PROPERTY_ACCESS with objectName="this"

#### 4. Computed Properties (3 tests)
- ✓ `obj[variable]` → name="<computed>"
- ✓ `obj['literal']` → name="literal"
- ✓ `obj[0]` → name="0"

#### 5. Optional Chaining (2 tests)
- ✓ `obj?.prop` → metadata.optional=true
- ✓ `a?.b?.c` → both nodes have optional flag

#### 6. Property Access in Method Call Chains (2 tests)
- ✓ `a.b.c()` → PROPERTY_ACCESS for `b` only (intermediate link)
- ✓ `obj.a.b.c.d()` → PROPERTY_ACCESS for a, b, c (NOT d, which is the method)

#### 7. Property Access in Assignments (2 tests)
- ✓ Assignment LHS (write) does NOT create PROPERTY_ACCESS (handled by mutations)
- ✓ Assignment RHS (read) DOES create PROPERTY_ACCESS

#### 8. Property Access in Function Arguments (2 tests)
- ✓ `process(config.maxBodyLength)` creates PROPERTY_ACCESS
- ✓ Chained access in arguments: `log(app.config.logger.level)` creates all nodes

#### 9. Property Access in Return Statements (1 test)
- ✓ `return config.maxBodyLength` creates PROPERTY_ACCESS
- ✓ Verifies CONTAINS edge from function to property access

#### 10. Property Access in Conditions (3 tests)
- ✓ If condition: `if (config.maxBodyLength > 0)`
- ✓ While condition: `while (state.running)`
- ✓ Ternary: `config.debug ? 'dev' : 'prod'`

#### 11. Property Access Inside Nested Functions (2 tests)
- ✓ Property access inside nested function scope
- ✓ Property access inside arrow function

#### 12. Property Access at Module Level (1 test)
- ✓ Module-level property access
- ✓ Verifies CONTAINS edge from MODULE

#### 13. CONTAINS Edges (2 tests)
- ✓ Single property access has CONTAINS edge from enclosing scope
- ✓ Multiple property accesses all have CONTAINS edges

#### 14. Semantic IDs (1 test)
- ✓ PROPERTY_ACCESS nodes have semanticId field

#### 15. No Duplication with CALL Nodes (2 tests)
- ✓ Method calls don't create duplicate PROPERTY_ACCESS nodes
- ✓ Clear distinction: `obj.prop` (PROPERTY_ACCESS) vs `obj.method()` (CALL)

## Test Pattern Adherence

All tests follow the established patterns from existing test files:

1. **Setup Helper**: `setupTest()` creates temp project, runs analysis
2. **Query Helpers**: `getNodesByType()`, `findPropertyAccessNode()`, `getEdgesByType()`
3. **Test Structure**: describe/it blocks with clear intent
4. **Assertions**: Specific, informative failure messages
5. **Cleanup**: Proper beforeEach/after hooks

## Critical Edge Cases Covered

### 1. Method Call Disambiguation
Tests verify that `a.b.c()` correctly:
- Creates PROPERTY_ACCESS for `b` (intermediate link)
- Creates CALL for `c()` (method)
- Does NOT create PROPERTY_ACCESS for `c` (no duplication)

### 2. Read vs Write Operations
- **Read** (RHS, function args, conditions): Creates PROPERTY_ACCESS
- **Write** (assignment LHS): No PROPERTY_ACCESS (handled by mutation tracking)

### 3. Chain Reconstruction
`a.b.c` creates:
- Node 1: name="b", objectName="a"
- Node 2: name="c", objectName="a.b"

This allows reconstructing the full chain and understanding data flow.

### 4. Scope Containment
Every PROPERTY_ACCESS node has CONTAINS edge from:
- Enclosing FUNCTION
- Or MODULE (if top-level)

This enables scope-aware querying.

## Tests Communicate Intent

Each test has:
- Clear setup code (what code pattern we're testing)
- Explicit assertions (what nodes/edges should exist)
- Informative failure messages (what's missing and why)

Example:
```javascript
assert.ok(
  propAccessNode,
  'Should have PROPERTY_ACCESS node for config.maxBodyLength'
);
```

Not just `assert.ok(propAccessNode)` - we explain WHAT we expect and WHY.

## No Mocks in Production Paths

Tests use real:
- RFDB backend (via createTestDatabase)
- File system (temp directories)
- Analysis orchestrator
- AST parsing

Only test infrastructure is isolated - the production code paths are exercised fully.

## Next Steps

1. Rob Pike implements PropertyAccessVisitor
2. Wire into JSASTAnalyzer and GraphBuilder
3. Run tests - they should turn GREEN
4. If tests fail, fix implementation (not tests)
5. Tests lock the behavior - refactoring must keep tests passing

## How to Run Individual Test Suites

```bash
# Run all PROPERTY_ACCESS tests
node --test test/unit/plugins/analysis/ast/property-access.test.ts

# Run specific suite (grep pattern)
node --test test/unit/plugins/analysis/ast/property-access.test.ts --test-name-pattern="Simple property access"

# Run with verbose output
node --test test/unit/plugins/analysis/ast/property-access.test.ts --test-reporter=spec
```

## Test File Statistics

- **Total lines**: 951
- **Test suites**: 15
- **Individual tests**: 29
- **Edge cases**: 13 distinct scenarios
- **Pattern match**: 100% (follows object-property-edges.test.ts and method-call-uses-edges.test.ts patterns)

## Summary

Tests are comprehensive, self-documenting, and ready for implementation. They cover all edge cases from Joel's tech plan plus additional scenarios discovered during test writing.

The tests will FAIL until PropertyAccessVisitor is implemented - this is TDD working as intended.
