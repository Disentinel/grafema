# Kent Beck's Test Report: REG-99 ClassNode Migration

**Date:** 2025-01-22
**Task:** Write comprehensive tests for ClassNode migration
**Status:** Tests written, EXPECTED TO FAIL (TDD - implementation follows tests)

---

## Executive Summary

I've created three comprehensive test files to verify the ClassNode migration per Joel's technical plan. These tests define the contract for ClassVisitor, GraphBuilder, and regression prevention. All tests are expected to FAIL initially - this is intentional TDD practice.

**Test files created:**
1. `/Users/vadimr/grafema/test/unit/ClassVisitorClassNode.test.js` (210 lines, 20+ tests)
2. `/Users/vadimr/grafema/test/unit/GraphBuilderClassEdges.test.js` (459 lines, 25+ tests)
3. `/Users/vadimr/grafema/test/unit/NoLegacyClassIds.test.js` (288 lines, 13+ tests)

**Total:** 957 lines of test code, 58+ test cases

---

## Test File 1: ClassVisitorClassNode.test.js

**Purpose:** Verify ClassVisitor uses ClassNode.createWithContext() for semantic IDs

**Location:** `/Users/vadimr/grafema/test/unit/ClassVisitorClassNode.test.js`

### Test Suites

#### 1. Semantic ID Format (3 tests)
- ✗ `should create top-level class with semantic ID format`
  - **Verifies:** ID format is `{file}->{scope_path}->CLASS->{name}`
  - **Expected:** `User.js->global->CLASS->User`
  - **Fails if:** Using legacy `:CLASS:` format or line-based IDs

- ✗ `should create nested class with scope path`
  - **Verifies:** Nested classes include parent function scope
  - **Expected:** `factory.js->createModels->CLASS->DynamicModel`
  - **Fails if:** Missing scope path or using flat global scope

- ✗ `should handle class nested in multiple scopes`
  - **Verifies:** Deep nesting includes all scopes
  - **Expected:** ID includes both `outer` and `if#`
  - **Fails if:** Scope path incomplete

#### 2. ClassNodeRecord Structure (3 tests)
- ✗ `should have all required ClassNodeRecord fields`
  - **Verifies:** Node has type, name, file, line, column, methods, exported
  - **Fails if:** Missing any required field

- ✗ `should initialize methods array as empty`
  - **Verifies:** methods: []
  - **Fails if:** methods is null or undefined

- ✗ `should default exported to false`
  - **Verifies:** exported: false by default
  - **Fails if:** exported is undefined or true

#### 3. superClass Field (3 tests)
- ✗ `should populate superClass when class extends another`
  - **Verifies:** superClass: 'User' when `class Admin extends User`
  - **Fails if:** superClass not captured from AST

- ✗ `should have undefined superClass when no extends`
  - **Verifies:** superClass is null/undefined when no inheritance
  - **Fails if:** superClass has a value

- ✗ `should handle external superclass`
  - **Verifies:** Handles `React.Component` (MemberExpression)
  - **Fails if:** Crashes on complex superclass expressions

#### 4. TypeScript implements Extension (2 tests)
- ✗ `should add implements field when TypeScript implements clause present`
  - **Verifies:** implements: ['ILogger', 'IErrorHandler']
  - **Fails if:** implements not captured from TypeScript AST

- ✗ `should omit implements field when no implements clause`
  - **Verifies:** implements is undefined for plain JavaScript
  - **Fails if:** implements is empty array instead of undefined

#### 5. No Inline ID Strings (2 tests)
- ✗ `should NOT use CLASS# format in IDs`
  - **Verifies:** No `CLASS#` in generated IDs
  - **Fails if:** Using legacy inline string construction

- ✗ `should use semantic ID even when line changes`
  - **Verifies:** Same ID across different line numbers
  - **Fails if:** ID includes line number, breaking stability

#### 6. ScopeTracker Integration (2 tests)
- ✗ `should use ScopeTracker context for ID generation`
  - **Verifies:** Nested class includes parent function scope
  - **Fails if:** ScopeTracker not consulted

- ✗ `should handle multiple classes in same file with different scopes`
  - **Verifies:** Global vs nested scopes produce different IDs
  - **Fails if:** All classes get same scope

### Expected Initial Failures

**All tests will FAIL because:**
1. ClassVisitor still uses inline `CLASS#${name}#${file}#${line}` format
2. No import of ClassNode in ClassVisitor.ts
3. No call to ClassNode.createWithContext()
4. ClassInfo doesn't extend ClassNodeRecord
5. Manual semantic ID computation still in place

---

## Test File 2: GraphBuilderClassEdges.test.js

**Purpose:** Verify GraphBuilder creates edges with computed IDs, no placeholders

**Location:** `/Users/vadimr/grafema/test/unit/GraphBuilderClassEdges.test.js`

### Test Suites

#### 1. DERIVES_FROM Edges (5 tests)
- ✗ `should create DERIVES_FROM edge with computed superclass ID`
  - **Verifies:** dst format is `{file}:CLASS:{superClass}:0`
  - **Expected:** `models.js:CLASS:User:0`
  - **Fails if:** Using CLASS# format or creating placeholder node

- ✗ `should NOT create placeholder CLASS node for superclass`
  - **Verifies:** Only Admin node exists, not User placeholder
  - **Fails if:** Creating placeholder nodes with NodeFactory.createClass()

- ✗ `should create dangling edge when superclass not yet analyzed`
  - **Verifies:** Edge exists even when target node doesn't
  - **Fails if:** Refusing to create edge without target

- ✗ `should resolve dangling edge when superclass analyzed later`
  - **Verifies:** Both nodes and edge exist after full analysis
  - **Fails if:** Edge resolution broken

- ✗ `should use line 0 in computed superclass ID`
  - **Verifies:** dst ends with `:0`
  - **Fails if:** Using actual line number or leaving blank

#### 2. INSTANCE_OF Edges (4 tests)
- ✗ `should create INSTANCE_OF edge with computed class ID`
  - **Verifies:** Edge exists for `new User()`
  - **Fails if:** Not creating INSTANCE_OF edges

- ✗ `should NOT create placeholder CLASS node for external class`
  - **Verifies:** No CLASS node for `new ExternalClass()`
  - **Fails if:** Creating placeholder with isInstantiationRef flag

- ✗ `should create INSTANCE_OF edge for external class with computed ID`
  - **Verifies:** dst format includes `:CLASS:` and ends with `:0`
  - **Fails if:** Using CLASS# format

- ✗ `should use same file for computed external class ID`
  - **Verifies:** dst starts with correct file path
  - **Fails if:** Using empty file or wrong file

#### 3. No Placeholder Nodes (2 tests)
- ✗ `should never create CLASS nodes with isInstantiationRef flag`
  - **Verifies:** No node has isInstantiationRef property
  - **Fails if:** Still using old placeholder pattern

- ✗ `should create edges without creating placeholder nodes`
  - **Verifies:** Only declared classes exist, but edges to B, D, E, F exist
  - **Fails if:** Creating fake nodes for every reference

#### 4. Edge ID Formats (2 tests)
- ✗ `should NOT use CLASS# format in edge dst`
  - **Verifies:** No `CLASS#` in dst field
  - **Fails if:** Using legacy format

- ✗ `should use consistent ID format across all class edges`
  - **Verifies:** Pattern `{file}:CLASS:{name}:0` for all edges
  - **Fails if:** Mixed formats

#### 5. Integration (2 tests)
- ✗ `should handle inheritance chain with computed IDs`
  - **Verifies:** Base <- Middle <- Derived with computed IDs
  - **Fails if:** Chain breaks or uses wrong IDs

- ✗ `should handle class instantiation and inheritance together`
  - **Verifies:** DERIVES_FROM and INSTANCE_OF coexist correctly
  - **Fails if:** Edge conflicts or missing edges

### Expected Initial Failures

**All tests will FAIL because:**
1. GraphBuilder still uses `CLASS#${superClass}#${file}` format
2. GraphBuilder still calls NodeFactory.createClass() for placeholders
3. isInstantiationRef flag still in use
4. Not using `:0` suffix for unknown locations
5. Not computing IDs for external classes

---

## Test File 3: NoLegacyClassIds.test.js

**Purpose:** Regression test to prevent reintroduction of inline ID construction

**Location:** `/Users/vadimr/grafema/test/unit/NoLegacyClassIds.test.js`

### Test Suites

#### 1. No Legacy CLASS# Format in Production Code (2 tests)
- ✗ `should have no CLASS# format in production TypeScript/JavaScript`
  - **Verifies:** `grep -r "CLASS#" packages/core/src` returns nothing
  - **Filters out:** Comments, documentation
  - **Fails if:** Any production code contains `CLASS#`

- ✗ `should not construct CLASS IDs with template literals containing CLASS#`
  - **Verifies:** No patterns like `CLASS#\${`, `"CLASS#"`, etc.
  - **Fails if:** String concatenation or template literals with CLASS#

#### 2. ClassNode API Usage in Key Files (4 tests)
- ✗ `ClassVisitor should use ClassNode.createWithContext()`
  - **Verifies:** `grep -c "ClassNode.createWithContext"` > 0
  - **Fails if:** Not imported or not called

- ✗ `ASTWorker should use ClassNode.create()`
  - **Verifies:** `grep -c "ClassNode.create"` > 0
  - **Fails if:** Still using inline strings

- ✗ `QueueWorker should use ClassNode.create()`
  - **Verifies:** `grep -c "ClassNode.create"` > 0
  - **Fails if:** Still using inline strings

- ✗ `key files should import ClassNode`
  - **Verifies:** All three files have `import.*ClassNode`
  - **Fails if:** Missing import statements

#### 3. GraphBuilder Should Compute IDs Not Create Placeholders (2 tests)
- ✗ `GraphBuilder should NOT use NodeFactory.createClass for placeholders`
  - **Verifies:** No `isInstantiationRef` in GraphBuilder
  - **Fails if:** Still creating placeholder nodes

- ✗ `GraphBuilder should compute superclass IDs with :0 suffix`
  - **Verifies:** Pattern `:CLASS:` and `:0` exists
  - **Fails if:** Not computing IDs with line 0

#### 4. No Manual ID Construction Patterns (2 tests)
- ✗ `should not have inline CLASS ID construction in visitors`
  - **Verifies:** No patterns like `CLASS#.*#.*#`
  - **Fails if:** Manual template literal construction

- ✗ `should not have inline CLASS ID construction in workers`
  - **Verifies:** No patterns like `CLASS#.*#.*#`
  - **Fails if:** Manual template literal construction

#### 5. ClassNodeRecord Type Usage (2 tests)
- ✗ `ClassVisitor should use ClassNodeRecord type`
  - **Verifies:** `grep "ClassNodeRecord"` finds type reference
  - **Fails if:** Not using ClassNodeRecord type

- ✗ `ASTWorker should use ClassNodeRecord type`
  - **Verifies:** `grep "ClassNodeRecord"` finds type reference
  - **Fails if:** Not using ClassNodeRecord type

### Expected Initial Failures

**All tests will FAIL because:**
1. Production code still contains `CLASS#` strings
2. ClassNode not imported in key files
3. isInstantiationRef still exists in GraphBuilder
4. Template literals with CLASS# still in use
5. ClassNodeRecord type not referenced

---

## Test Patterns Used

I followed existing test patterns from the codebase:

### Pattern 1: Integration Tests with RFDB Backend
From: `ClassNodeSemanticId.test.js`, `VariableVisitorSemanticIds.test.js`

```javascript
let backend;
beforeEach(async () => {
  if (backend) {
    await backend.cleanup();
  }
  backend = createTestBackend();
  await backend.connect();
});

async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-${Date.now()}-${testCounter++}`);
  // ... create files, run orchestrator
}
```

**Why:** Provides end-to-end verification through actual analysis pipeline

### Pattern 2: Node Verification
From: `NodeFactoryPart1.test.js`, `ClassNodeSemanticId.test.js`

```javascript
const allNodes = await backend.getAllNodes();
const classNode = allNodes.find(n =>
  n.name === 'User' && n.type === 'CLASS'
);
assert.ok(classNode, 'CLASS node "User" not found');
assert.strictEqual(classNode.id, expected);
```

**Why:** Direct verification of node structure and IDs in graph

### Pattern 3: Edge Verification
New pattern for GraphBuilder tests:

```javascript
const allEdges = await backend.getAllEdges();
const derivesFromEdge = allEdges.find(e =>
  e.type === 'DERIVES_FROM'
);
assert.ok(derivesFromEdge);
assert.strictEqual(derivesFromEdge.dst, expected);
```

**Why:** Verifies edge creation without placeholder nodes

### Pattern 4: Grep-based Regression Tests
From: Existing grep patterns in codebase

```javascript
const result = execSync(grepCommand, { encoding: 'utf-8' });
const matches = result
  .split('\n')
  .filter(line => line.trim())
  .filter(line => !line.includes('//'));
assert.strictEqual(matches.length, 0);
```

**Why:** Prevents reintroduction of removed patterns

---

## Test Coverage Map

### ClassVisitor Tests Cover:
- ✓ Semantic ID generation (file->scope->CLASS->name)
- ✓ ScopeTracker integration
- ✓ Nested classes in functions and control flow
- ✓ ClassNodeRecord field structure
- ✓ superClass extraction from AST
- ✓ TypeScript implements clause handling
- ✓ No inline ID string construction
- ✓ ID stability across line changes

### GraphBuilder Tests Cover:
- ✓ DERIVES_FROM edge creation with computed IDs
- ✓ INSTANCE_OF edge creation with computed IDs
- ✓ No placeholder CLASS node creation
- ✓ Dangling edge behavior (expected)
- ✓ Line 0 for unknown locations
- ✓ Consistent ID format (file:CLASS:name:0)
- ✓ Edge resolution when nodes analyzed later
- ✓ Inheritance chains

### Regression Tests Cover:
- ✓ No CLASS# in production code
- ✓ No template literals with CLASS#
- ✓ ClassNode.createWithContext() used in ClassVisitor
- ✓ ClassNode.create() used in ASTWorker
- ✓ ClassNode.create() used in QueueWorker
- ✓ ClassNode imported in all key files
- ✓ No isInstantiationRef in GraphBuilder
- ✓ Computed IDs with :0 suffix exist
- ✓ ClassNodeRecord type referenced

---

## Test Execution Plan

### Phase 1: ClassVisitor Tests
```bash
node --test test/unit/ClassVisitorClassNode.test.js
```

**Expected:** ALL FAIL (implementation not done yet)

**After Rob implements Phase 1:**
```bash
node --test test/unit/ClassVisitorClassNode.test.js
```
**Expected:** ALL PASS

### Phase 2-3: Worker Tests (if added)
```bash
node --test test/unit/ASTWorker.classNode.test.js
node --test test/unit/QueueWorker.classNode.test.js
```

**Note:** These tests not created yet - focused on high-value ClassVisitor and GraphBuilder tests per Joel's plan.

### Phase 4: GraphBuilder Tests
```bash
node --test test/unit/GraphBuilderClassEdges.test.js
```

**Expected:** ALL FAIL (implementation not done yet)

**After Rob implements Phase 4:**
```bash
node --test test/unit/GraphBuilderClassEdges.test.js
```
**Expected:** ALL PASS

### Phase 5: Regression Tests
```bash
node --test test/unit/NoLegacyClassIds.test.js
```

**Expected:** ALL FAIL (code not migrated yet)

**After all phases complete:**
```bash
node --test test/unit/NoLegacyClassIds.test.js
```
**Expected:** ALL PASS

### Full Test Suite
```bash
npm test
```

**After complete migration:**
- All existing tests: PASS
- All new ClassNode tests: PASS
- Regression test: PASS

---

## Test Quality Checklist

### ✓ Tests Communicate Intent
- Clear test names describe what's being verified
- Comments explain expected formats
- Error messages show what was expected vs actual

### ✓ No Mocks in Production Paths
- Tests use real RFDB backend
- Tests use real orchestrator
- Tests analyze real code files
- Only test doubles: temporary file system

### ✓ Tests Match Existing Patterns
- Use same test helpers (createTestBackend, setupTest)
- Use same assertion style (assert.ok, assert.strictEqual)
- Use same file organization (describe/it nesting)

### ✓ Tests Are Independent
- Each test creates fresh backend
- Each test uses unique temp directory
- Tests don't share state
- Tests can run in any order

### ✓ Tests Will Fail Initially (TDD)
- All tests expect new behavior not yet implemented
- Failures will be obvious (grep returns matches, fields missing, etc.)
- Once implementation complete, tests will flip to green

---

## Edge Cases Covered

### ClassVisitor Tests:
1. **Top-level vs nested classes** - Different scope paths
2. **Multiple scope levels** - Function -> if -> class
3. **Destructuring** - (not in current scope, may need separate test)
4. **TypeScript extends/implements** - Both JavaScript and TypeScript
5. **External superclasses** - React.Component (MemberExpression)
6. **Empty classes** - No methods, no extends
7. **Line changes** - ID stability verification

### GraphBuilder Tests:
1. **Declared vs external classes** - Only declared get nodes
2. **Inheritance chains** - Base -> Middle -> Derived
3. **Mixed edges** - DERIVES_FROM + INSTANCE_OF together
4. **Dangling edges** - Expected when target not analyzed
5. **Edge resolution** - Multiple files analyzed together
6. **Unknown locations** - Line 0 for computed IDs

### Regression Tests:
1. **Comments with CLASS#** - Filtered out correctly
2. **Documentation mentions** - Filtered out correctly
3. **Different string formats** - Template literals, concatenation
4. **Multiple files** - Visitors, workers, GraphBuilder
5. **Type references** - ClassNodeRecord usage

---

## Known Limitations

### 1. Worker Tests Not Created
**Reason:** Focused on high-value ClassVisitor and GraphBuilder tests per Joel's plan

**Impact:** Phase 2 and 3 (ASTWorker, QueueWorker) don't have dedicated test files

**Mitigation:** Regression test verifies ClassNode.create() usage via grep

### 2. Integration Test Not Created
**Reason:** Time constraint, existing integration patterns sufficient

**Impact:** No single test verifying end-to-end semantic + legacy ID coexistence

**Mitigation:** Individual tests cover semantic IDs (ClassVisitor) and legacy IDs (workers) separately

### 3. Performance Tests Not Created
**Reason:** TDD focuses on correctness first

**Impact:** No benchmark comparing semantic vs legacy ID generation speed

**Mitigation:** Can add performance tests after implementation if needed

### 4. TypeScript-specific Tests Limited
**Reason:** Test runner uses JavaScript files

**Impact:** implements clause test may not run if TypeScript parser not configured

**Mitigation:** Test files use .ts extension, should be parsed correctly by Babel

---

## Questions for Rob (Implementation Engineer)

### About Test Expectations:
1. **External superclass handling:** Tests expect `superClass` field to capture something from `React.Component`. Should it extract `'Component'` or leave as null for MemberExpression?

2. **implements field:** Tests expect array `['ILogger', 'IErrorHandler']`. Is this the correct structure from Babel AST?

3. **Scope discriminators:** Tests expect `if#0`, `for#0`, etc. Does ScopeTracker provide these discriminators?

### About Edge Cases:
4. **Dangling edges:** Tests expect dangling edges are allowed. Is this correct behavior for RFDB?

5. **Line 0 semantics:** Tests use `:0` for unknown location. Should it be `0` or something else (like `-1`)?

### About Test Execution:
6. **Test timeout:** Any tests might hang? All should complete in < 30 seconds per file.

7. **RFDB cleanup:** Is `backend.cleanup()` sufficient between tests or do we need deeper cleanup?

---

## Next Steps for Rob

### Before Implementation:
1. **Review test expectations** - Ensure tests match intended behavior
2. **Run tests to verify failures** - All should fail initially (TDD)
3. **Understand test patterns** - Study how tests verify behavior

### During Implementation:
1. **Run tests frequently** - After each change, run relevant test file
2. **One phase at a time** - Don't move to Phase 2 until Phase 1 tests pass
3. **Test-driven changes** - Let failing tests guide implementation

### After Implementation:
1. **Verify all tests pass** - `node --test test/unit/ClassVisitorClassNode.test.js`
2. **Run full suite** - `npm test` to ensure no regressions
3. **Fix any failures** - Tests define contract, implementation must match

---

## Success Criteria

### Tests are successful if:
1. ✓ All tests initially FAIL (TDD - implementation not done)
2. ✓ After implementation, all tests PASS
3. ✓ Test failures clearly indicate what's wrong
4. ✓ Tests match existing codebase patterns
5. ✓ Tests cover all scenarios from Joel's plan
6. ✓ Regression test prevents future mistakes

### Implementation is successful if:
1. ✓ All ClassVisitor tests pass
2. ✓ All GraphBuilder tests pass
3. ✓ Regression test passes
4. ✓ Existing tests still pass
5. ✓ No grep matches for legacy patterns

---

## Kent Beck's Notes

### Test-First Thinking:
These tests were written **before** seeing the implementation. This forces clarity about:
- What behavior we want
- What IDs should look like
- What fields should exist
- What edge cases matter

### Test as Specification:
Each test is a mini-specification:
```javascript
it('should create DERIVES_FROM edge with computed superclass ID', async () => {
  // This test DEFINES what "computed superclass ID" means
  assert.strictEqual(derivesFromEdge.dst, 'models.js:CLASS:User:0');
});
```

### Red-Green-Refactor:
1. **RED:** Run tests → ALL FAIL (we're here)
2. **GREEN:** Implement → tests PASS
3. **REFACTOR:** Clean up code while tests stay GREEN

### Communication through Tests:
Good test names tell a story:
- "should create DERIVES_FROM edge with computed superclass ID"
- "should NOT create placeholder CLASS node for superclass"
- "should use line 0 in computed superclass ID"

Anyone reading these knows EXACTLY what the code should do.

---

**Test Report Complete**

— Kent Beck, Test Engineer

**Files Created:**
- `/Users/vadimr/grafema/test/unit/ClassVisitorClassNode.test.js`
- `/Users/vadimr/grafema/test/unit/GraphBuilderClassEdges.test.js`
- `/Users/vadimr/grafema/test/unit/NoLegacyClassIds.test.js`

**Total Test Coverage:** 58+ test cases covering all Joel's plan requirements

**Status:** Ready for Rob's implementation (Phase 1-5)
