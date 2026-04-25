# Kent Beck - Test Report for Array Mutation Tracking (REG-113)

## Summary

Tests for Array Mutation Tracking feature have been written following TDD principles. All tests compile successfully and fail as expected (since implementation does not exist yet).

## Existing Test Patterns Analyzed

I studied the following existing test files to understand the patterns used in this codebase:

### 1. `/Users/vadimr/grafema/test/unit/DataFlowTracking.test.js`
- Uses `node:test` with `describe`, `it`, `before`, `after`
- Creates temporary directories with test files
- Uses `RFDBServerBackend` for graph storage
- Pattern: `setupTest(files)` helper to create test projects
- Queries nodes with `backend.getAllNodes()` and edges with `backend.getAllEdges()`
- Assertions use `assert.ok()` and `assert.strictEqual()`

### 2. `/Users/vadimr/grafema/test/unit/ParameterDataFlow.test.js`
- Uses `createTestBackend()` from `../helpers/TestRFDB.js`
- Uses `createTestOrchestrator()` from `../helpers/createTestOrchestrator.js`
- Pattern: `beforeEach` to create fresh backend, `after` to cleanup
- Fixture path for reusable test files

### 3. `/Users/vadimr/grafema/test/unit/PassesArgument.test.js`
- Same patterns as ParameterDataFlow
- Tests edge creation with metadata (`argIndex`, etc.)
- Uses `backend.checkGuarantee()` for Datalog queries

## Test File Created

**Location:** `/Users/vadimr/grafema/test/unit/ArrayMutationTracking.test.js`

## Test Cases

### 1. `arr.push(obj)` Tests
| Test | What it verifies |
|------|-----------------|
| `should create FLOWS_INTO edge from pushed variable to array` | Basic push creates edge with correct src/dst and `mutationMethod: 'push'`, `argIndex: 0` |
| `should create multiple FLOWS_INTO edges for multiple arguments` | `arr.push(a, b, c)` creates 3 edges with `argIndex: 0, 1, 2` |
| `should handle spread: arr.push(...items) with isSpread metadata` | Spread creates edge with `isSpread: true` |

### 2. `arr.unshift(obj)` Tests
| Test | What it verifies |
|------|-----------------|
| `should create FLOWS_INTO edge from unshifted object to array` | Unshift creates edge with `mutationMethod: 'unshift'` |

### 3. `arr.splice(i, 0, obj)` Tests
| Test | What it verifies |
|------|-----------------|
| `should create FLOWS_INTO edge for inserted elements only` | Only insertion args (from index 2+) create edges, `argIndex` is rebased to 0 |
| `should NOT create FLOWS_INTO for splice start and deleteCount arguments` | First two splice args don't create edges |

### 4. `arr[i] = obj` (Indexed Assignment) Tests
| Test | What it verifies |
|------|-----------------|
| `should create FLOWS_INTO edge from assigned object to array` | Indexed assignment creates edge with `mutationMethod: 'indexed'` |
| `should handle computed index: arr[index] = obj` | Works with variable as index |

### 5. Edge Direction Verification
| Test | What it verifies |
|------|-----------------|
| `should create edge with correct direction: source -> array (src=value, dst=array)` | Edge direction is value --FLOWS_INTO--> array |

### 6. Integration with NodeCreationValidator
| Test | What it verifies |
|------|-----------------|
| `should allow tracing objects through arrays to addNodes` | FLOWS_INTO enables tracing pushed objects to find their origins |

## Test Fixtures Created

**Location:** `/Users/vadimr/grafema/test/fixtures/array-mutation/`

Files:
- `package.json` - ESM configuration
- `index.js` - Basic array mutations for integration testing

## Test Execution Results

All tests compile successfully and **fail as expected**:

```
not ok 1 - should create FLOWS_INTO edge from pushed variable to array
  error: 'Expected FLOWS_INTO edge from "obj" to "arr". Found edges: []'

not ok 2 - should create multiple FLOWS_INTO edges for multiple arguments
  error: 'Expected 3 FLOWS_INTO edges, got 0'
```

This confirms:
1. Tests are syntactically correct
2. Test infrastructure works (backend connects, orchestrator runs analysis)
3. Nodes are created correctly (VARIABLE/CONSTANT for variables)
4. FLOWS_INTO edges don't exist yet (as expected before implementation)

## Technical Notes

### Edge Metadata Access
The tests access edge metadata as direct properties (`edge.mutationMethod`, `edge.argIndex`, `edge.isSpread`) following the pattern from existing tests. This matches how other edge types work in the codebase.

### Pattern Match with Existing Tests
- Used exact same imports as `ParameterDataFlow.test.js`
- Used same `beforeEach`/`after` lifecycle pattern
- Used same `createTestBackend()` and `createTestOrchestrator()` helpers
- Used same assertion style with detailed error messages

## Questions / Issues

None. Tests are ready for implementation.

## Next Steps

Rob Pike should implement:
1. Add `FLOWS_INTO` edge type to `packages/types/src/edges.ts`
2. Add `ArrayMutationInfo` type to `packages/core/src/plugins/analysis/ast/types.ts`
3. Implement detection in `CallExpressionVisitor.ts` (for push/unshift/splice)
4. Implement detection in `JSASTAnalyzer.ts` (for indexed assignment)
5. Create edges in `GraphBuilder.ts`
6. Update `NodeCreationValidator.ts` to use FLOWS_INTO for array content tracing
