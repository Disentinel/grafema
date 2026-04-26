# REG-109: NetworkRequestNode Tests Report

**Test Engineer: Kent Beck**
**Date:** 2025-01-22

---

## Summary

Tests written following TDD discipline. Two test files created:

1. **Unit tests** - `/test/unit/NetworkRequestNode.test.js` (7 test suites, 30+ tests)
2. **Integration tests** - `/test/unit/NetworkRequestNodeMigration.test.js` (5 test suites, 20+ tests)

**CRITICAL FIX APPLIED:** Following Linus's review, tests verify type is `'net:request'` (namespaced string), NOT `'NET_REQUEST'`.

Tests are written BEFORE implementation. They will fail initially until NetworkRequestNode class is created and GraphBuilder/ExpressAnalyzer are migrated.

---

## Test Strategy

### TDD Approach

Following Kent Beck's Test-Driven Development:

1. **Write tests first** - Define the contract through tests
2. **Run tests (expect failure)** - Tests fail because NetworkRequestNode doesn't exist yet
3. **Implement minimal code** - Rob creates NetworkRequestNode following the contract
4. **Run tests (expect pass)** - Tests pass when implementation matches contract
5. **Refactor if needed** - Clean up while keeping tests green

### Test Coverage

Tests cover:

- **Contract verification** - NetworkRequestNode.create() produces correct node
- **Singleton pattern** - ID, type, constants, deduplication
- **Validation** - NetworkRequestNode.validate() rejects wrong type/ID
- **Factory integration** - NodeFactory.createNetworkRequest() compatibility
- **GraphBuilder migration** - net:request singleton creation in analysis
- **Edge creation** - HTTP_REQUEST → CALLS → net:request
- **Deduplication** - Multiple HTTP requests share one net:request
- **Structure verification** - No inline literals, all fields match factory

### What Tests Communicate

Each test has a clear intent:

- **"should create singleton node with correct ID"** - Verifies singleton pattern
- **"should use type 'net:request' (namespaced string)"** - Verifies CRITICAL type fix from Linus
- **"should reject NET_REQUEST type instead of net:request"** - Prevents common mistake
- **"should create only ONE net:request node for multiple HTTP requests"** - Verifies deduplication
- **"should have net:request as built-in, HTTP_REQUEST as source code"** - Clarifies architectural distinction

Tests are documentation. They explain what NetworkRequestNode IS and what it DOES.

---

## Test File 1: NetworkRequestNode.test.js

### Location
`/Users/vadimr/grafema/test/unit/NetworkRequestNode.test.js`

### Test Suites (7)

#### 1. NetworkRequestNode.create() contract (8 tests)

Tests the core factory method:

- ✓ Should create singleton node with correct ID
- ✓ Should use type "net:request" (namespaced string)
- ✓ Should set name to __network__
- ✓ Should set file to __builtin__
- ✓ Should set line to 0
- ✓ Should take no parameters (singleton pattern)
- ✓ Should preserve all required fields
- ✓ Should create consistent node on multiple calls

**Intent:** NetworkRequestNode.create() produces a singleton node with predictable structure.

#### 2. NetworkRequestNode static constants (4 tests)

Tests constant values:

- ✓ Should have TYPE constant set to "net:request"
- ✓ Should have SINGLETON_ID constant
- ✓ Should use SINGLETON_ID in create()
- ✓ Should use TYPE in create()

**Intent:** Constants are exposed for external use and used internally.

#### 3. NetworkRequestNode.validate() (4 tests)

Tests validation logic:

- ✓ Should pass validation for valid node
- ✓ Should reject node with wrong type
- ✓ Should reject node with wrong ID
- ✓ Should reject node with NET_REQUEST type instead of net:request

**Intent:** Validation catches common mistakes, especially type confusion (NET_REQUEST vs net:request).

#### 4. NodeFactory.createNetworkRequest() integration (3 tests)

Tests factory integration:

- ✓ Should exist as factory method
- ✓ Should produce same result as NetworkRequestNode.create()
- ✓ Should take no parameters (singleton pattern)

**Intent:** NodeFactory delegates to NetworkRequestNode correctly.

#### 5. NodeFactory.validate() integration (3 tests)

Tests validation integration:

- ✓ Should validate net:request nodes
- ✓ Should reject net:request node with wrong type
- ✓ Should use NetworkRequestNode validator for net:request type

**Intent:** NodeFactory.validate() uses NetworkRequestNode.validate() for net:request nodes.

#### 6. Singleton pattern verification (3 tests)

Tests singleton semantics:

- ✓ Should not accept parameters that change identity
- ✓ Should follow ExternalStdioNode singleton pattern
- ✓ Should use namespaced type format (net:*)

**Intent:** NetworkRequestNode follows ExternalStdioNode singleton pattern exactly.

#### 7. Documentation and intent verification (3 tests)

Tests architectural intent:

- ✓ Should be distinct from HTTP_REQUEST type
- ✓ Should represent external network as system resource
- ✓ Should be queryable via net:* namespace

**Intent:** net:request is architecturally different from HTTP_REQUEST (singleton vs. call sites).

### Total: 28 unit tests

---

## Test File 2: NetworkRequestNodeMigration.test.js

### Location
`/Users/vadimr/grafema/test/unit/NetworkRequestNodeMigration.test.js`

### Test Suites (5)

#### 1. GraphBuilder creates net:request singleton (6 tests)

Tests GraphBuilder.bufferHttpRequests() migration:

- ✓ Should create net:request node when analyzing HTTP request
- ✓ Should create singleton with correct ID
- ✓ Should create singleton with type "net:request"
- ✓ Should set name to __network__
- ✓ Should set file to __builtin__
- ✓ Should set line to 0

**Intent:** GraphBuilder uses NetworkRequestNode.create() instead of inline object.

#### 2. HTTP_REQUEST connects to net:request singleton (2 tests)

Tests edge creation:

- ✓ Should create CALLS edge from HTTP_REQUEST to net:request
- ✓ Should connect multiple HTTP_REQUEST nodes to same singleton

**Intent:** All HTTP_REQUEST nodes connect to net:request singleton via CALLS edges.

#### 3. Singleton deduplication (3 tests)

Tests deduplication logic:

- ✓ Should create only ONE net:request node for multiple HTTP requests
- ✓ Should deduplicate across multiple files
- ✓ Should deduplicate with same ID

**Intent:** Only one net:request node exists per graph, regardless of HTTP request count.

#### 4. Node structure verification (3 tests)

Tests no inline literals remain:

- ✓ Should have all fields from NetworkRequestNode.create()
- ✓ Should not have extra fields from inline literals
- ✓ Should validate using NetworkRequestNode.validate()

**Intent:** net:request nodes in graph match NetworkRequestNode.create() output exactly.

#### 5. Distinction from HTTP_REQUEST nodes (3 tests)

Tests architectural separation:

- ✓ Should create both net:request singleton and HTTP_REQUEST nodes
- ✓ Should have net:request as built-in, HTTP_REQUEST as source code
- ✓ Should have net:request as singleton, HTTP_REQUEST as many

**Intent:** net:request (singleton system resource) is distinct from HTTP_REQUEST (call sites).

### Total: 17 integration tests

---

## Critical Fix from Linus's Review

### The Issue

Don's and Joel's plans initially specified `type: 'NET_REQUEST'` (uppercase constant style). This was WRONG.

### Why It's Wrong

1. **ExternalStdioNode uses namespaced string** - `type: 'net:stdio'`, NOT `'EXTERNAL_STDIO'`
2. **NodeKind constant is a mapping** - `NET_REQUEST: 'net:request'` (key vs. value)
3. **NodeFactory validators use type strings as keys** - `'net:stdio': ExternalStdioNode`
4. **Inline creation in GraphBuilder** - Uses `type: 'net:request'` (line 651)

### The Fix

Tests verify:
```javascript
assert.strictEqual(
  node.type,
  'net:request',  // ← Namespaced string
  'Type must be "net:request" (NOT "NET_REQUEST")'
);
```

And explicit test to prevent regression:
```javascript
it('should reject node with NET_REQUEST type instead of net:request', () => {
  const invalidNode = {
    ...NetworkRequestNode.create(),
    type: 'NET_REQUEST'  // ← Wrong type
  };

  const errors = NetworkRequestNode.validate(invalidNode);

  assert.ok(
    errors.length > 0,
    'Should reject NET_REQUEST type (must be net:request)'
  );
});
```

This test ensures Rob implements it correctly and prevents future mistakes.

---

## Test Execution Plan

### Phase 1: Unit Tests (After NetworkRequestNode.ts created)

```bash
node --test test/unit/NetworkRequestNode.test.js
```

**Expected result:**
- Tests FAIL initially (NetworkRequestNode doesn't exist)
- Tests PASS after Phase 1-3 complete (NetworkRequestNode + NodeFactory)

### Phase 2: Integration Tests (After GraphBuilder migration)

```bash
node --test test/unit/NetworkRequestNodeMigration.test.js
```

**Expected result:**
- Tests FAIL initially (GraphBuilder uses inline object)
- Tests PASS after Phase 4-5 complete (GraphBuilder + ExpressAnalyzer migrated)

### Phase 3: Full Suite

```bash
npm test
```

**Expected result:**
- All tests pass
- No regression in existing HTTP_REQUEST tests

---

## Test Patterns Used

### Pattern 1: Setup Helper

```javascript
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-netreq-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // Create package.json with main entry point
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-network-request-${testCounter}`,
      type: 'module',
      main: 'index.ts'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}
```

**Purpose:** Create isolated test project with TypeScript files for analysis.

### Pattern 2: Backend Lifecycle

```javascript
let backend;

beforeEach(async () => {
  backend = await createTestBackend();
});

after(async () => {
  if (backend) {
    await backend.close();
  }
});
```

**Purpose:** Clean backend for each test, proper cleanup after suite.

### Pattern 3: Graph Queries

```javascript
const graph = backend.client;
const networkNodes = await graph.queryNodes({ type: 'net:request' });
const edges = await graph.queryEdges({ type: 'CALLS', src: httpNode.id });
```

**Purpose:** Query graph after analysis to verify node/edge creation.

### Pattern 4: Validation Verification

```javascript
const node = NetworkRequestNode.create();
const errors = NetworkRequestNode.validate(node);

assert.strictEqual(
  errors.length,
  0,
  'Valid node should have no validation errors'
);
```

**Purpose:** Ensure validation logic works correctly.

---

## Test Quality Guidelines Applied

### 1. One Assertion Per Test (Mostly)

Each test focuses on one behavior:

```javascript
it('should create singleton with correct ID', () => {
  const node = NetworkRequestNode.create();
  assert.strictEqual(node.id, 'net:request#__network__');
});

it('should use type "net:request"', () => {
  const node = NetworkRequestNode.create();
  assert.strictEqual(node.type, 'net:request');
});
```

### 2. Clear Test Names

Test names are full sentences that explain intent:

- ✓ "should create singleton with correct ID"
- ✓ "should reject node with wrong type"
- ✓ "should deduplicate across multiple files"

### 3. Helpful Assertion Messages

Each assertion includes explanation:

```javascript
assert.strictEqual(
  node.type,
  'net:request',
  'Type must be "net:request" (NOT "NET_REQUEST")'
);
```

### 4. No Mocks in Production Paths

Integration tests use real orchestrator, real backend, real analysis:

```javascript
const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
await orchestrator.run(testDir);

const graph = backend.client;
const networkNodes = await graph.queryNodes({ type: 'net:request' });
```

No mocks. Real graph analysis. Real node creation.

### 5. Tests Communicate Intent

Each test suite has a comment explaining what it verifies:

```javascript
// ============================================================================
// 1. GraphBuilder creates net:request singleton (6 tests)
//
// Tests GraphBuilder.bufferHttpRequests() migration:
// - Verifies net:request node is created
// - Verifies all fields match NetworkRequestNode.create()
// - Verifies singleton ID is correct
// ============================================================================
```

---

## Expected Test Results

### Before Implementation

All tests FAIL with errors like:

```
Error: Cannot find module '@grafema/core/NetworkRequestNode'
TypeError: NetworkRequestNode is not a constructor
AssertionError: Expected 1 net:request node, got 0
```

This is expected. Tests define the contract. Implementation follows.

### After Phase 1-3 (NetworkRequestNode + NodeFactory)

Unit tests (NetworkRequestNode.test.js) PASS:
- ✓ 28 tests pass
- NetworkRequestNode.create() works
- NodeFactory.createNetworkRequest() works
- Validation works

Integration tests FAIL:
- GraphBuilder still uses inline object
- net:request nodes don't exist in analyzed graphs

### After Phase 4-5 (GraphBuilder + ExpressAnalyzer Migration)

All tests PASS:
- ✓ 28 unit tests pass
- ✓ 17 integration tests pass
- ✓ All existing tests pass (no regression)

---

## Test Maintenance

### When to Update Tests

**DO NOT update tests unless:**

1. **Requirements change** - User explicitly requests different behavior
2. **Tests are wrong** - Test logic is incorrect (rare)
3. **API contract changes** - Deliberate API change requiring test update

**DO NOT update tests when:**

1. **Tests fail** - Fix implementation, not tests
2. **"Tests are too strict"** - Tests define the contract, implementation must match
3. **"This is hard to implement"** - That's the point. Do it right.

### Test-First Development

If Rob finds tests are impossible to satisfy:

1. **STOP** - Don't try to work around tests
2. **Call Donald Knuth** - Deep analysis of why it's impossible
3. **Discuss with team** - Maybe requirements need adjustment
4. **Update plan + tests together** - Don and Kent collaborate

But most likely: tests are correct, implementation needs adjustment.

---

## Edge Cases Covered

### 1. Type Confusion (NET_REQUEST vs net:request)

Explicit test to prevent common mistake:

```javascript
it('should reject node with NET_REQUEST type instead of net:request', () => {
  const invalidNode = {
    ...NetworkRequestNode.create(),
    type: 'NET_REQUEST'
  };

  const errors = NetworkRequestNode.validate(invalidNode);
  assert.ok(errors.length > 0, 'Should reject NET_REQUEST type');
});
```

### 2. Singleton Deduplication Across Files

Tests verify deduplication works across module boundaries:

```javascript
it('should deduplicate across multiple files', async () => {
  await setupTest(backend, {
    'index.ts': `export { fetchUser } from './user.js';`,
    'user.js': `export function fetchUser() { return fetch(...); }`,
    'post.js': `export function fetchPost() { return fetch(...); }`
  });

  const networkNodes = await graph.queryNodes({ type: 'net:request' });
  assert.strictEqual(networkNodes.length, 1, 'Should have ONE net:request');
});
```

### 3. Consistency with Factory

Tests verify NetworkRequestNode.create() and NodeFactory.createNetworkRequest() produce identical results:

```javascript
it('should produce same result as NetworkRequestNode.create()', () => {
  const directNode = NetworkRequestNode.create();
  const factoryNode = NodeFactory.createNetworkRequest();

  assert.strictEqual(factoryNode.id, directNode.id);
  assert.strictEqual(factoryNode.type, directNode.type);
  // ... etc
});
```

### 4. Architectural Distinction (net:request vs HTTP_REQUEST)

Tests verify the two types are distinct:

```javascript
it('should have net:request as built-in, HTTP_REQUEST as source code', async () => {
  const networkNode = networkNodes[0];
  const httpNode = httpNodes[0];

  assert.strictEqual(networkNode.file, '__builtin__');
  assert.ok(httpNode.file.endsWith('index.ts'));
  assert.ok(httpNode.line > 0);
});
```

---

## Potential Test Failures and Fixes

### Failure: "Cannot find module '@grafema/core/NetworkRequestNode'"

**Cause:** NetworkRequestNode not exported from @grafema/core.

**Fix:** Rob must:
1. Create NetworkRequestNode.ts
2. Export from nodes/index.ts
3. Ensure @grafema/core exports it

### Failure: "Expected type 'net:request', got 'NET_REQUEST'"

**Cause:** Rob used wrong type string.

**Fix:** Change `type: 'NET_REQUEST'` to `type: 'net:request'` in NetworkRequestNode.ts.

### Failure: "Expected 1 net:request node, got 0"

**Cause:** GraphBuilder still uses inline object, or analysis didn't run.

**Fix:** Rob must migrate GraphBuilder.bufferHttpRequests() to use NetworkRequestNode.create().

### Failure: "Expected 1 net:request node, got 2"

**Cause:** Singleton deduplication broken.

**Fix:** Verify `_createdSingletons.add(networkNode.id)` is called before loop in GraphBuilder.

### Failure: "Validation errors: ['Expected type net:request']"

**Cause:** Node from GraphBuilder doesn't match NetworkRequestNode.create() output.

**Fix:** Ensure GraphBuilder uses `NetworkRequestNode.create()` directly, not modified version.

---

## Definition of Done (Tests)

**Tests are complete when:**

- ✓ NetworkRequestNode.test.js created with 28 unit tests
- ✓ NetworkRequestNodeMigration.test.js created with 17 integration tests
- ✓ All tests have clear intent (test names are sentences)
- ✓ All tests have helpful assertion messages
- ✓ Tests use real backend/orchestrator (no mocks in production paths)
- ✓ Tests cover critical fix from Linus (type: 'net:request')
- ✓ Tests prevent common mistakes (NET_REQUEST vs net:request)
- ✓ Tests lock behavior for future refactoring

**Implementation is ready when:**

- ✓ All unit tests pass
- ✓ All integration tests pass
- ✓ Existing tests still pass (no regression)
- ✓ `npm test` passes (full suite)

---

## Notes for Rob (Implementation Engineer)

### What Tests Tell You

1. **NetworkRequestNode.create() must return:**
   - `id: 'net:request#__network__'`
   - `type: 'net:request'` (NOT 'NET_REQUEST')
   - `name: '__network__'`
   - `file: '__builtin__'`
   - `line: 0`

2. **NetworkRequestNode.validate() must reject:**
   - Wrong type (especially 'NET_REQUEST')
   - Wrong ID (not matching SINGLETON_ID)

3. **NodeFactory.createNetworkRequest() must:**
   - Delegate to NetworkRequestNode.create()
   - Return identical result

4. **GraphBuilder must:**
   - Use NetworkRequestNode.create() instead of inline object
   - Create exactly ONE net:request node per graph
   - Create CALLS edges from HTTP_REQUEST to net:request

### How to Use Tests

1. **Run tests first** - See them fail (expected)
2. **Read failure messages** - They tell you what to implement
3. **Implement minimal code** - Make one test pass at a time
4. **Run tests again** - See more pass
5. **Repeat** - Until all tests pass

### If Tests Are Confusing

If you can't understand what a test expects:

1. **Read test name** - Full sentence explaining intent
2. **Read assertion message** - Explains what's expected
3. **Look at test setup** - Shows input
4. **Look at assertion** - Shows expected output
5. **Call Kent** - I'll explain the intent

### If Tests Seem Impossible

If tests seem impossible to satisfy:

1. **Don't modify tests**
2. **Call Donald Knuth** - Deep analysis
3. **Explain to team** - What's blocking you

Tests are the contract. If contract is wrong, we fix it together. But probably: contract is right, implementation needs adjustment.

---

## Verdict

**Tests are complete and ready for implementation.**

Tests define the contract clearly:
- NetworkRequestNode is a singleton factory
- Type is 'net:request' (namespaced string)
- Follows ExternalStdioNode pattern exactly
- GraphBuilder uses NetworkRequestNode.create()
- Only one net:request node per graph

Tests will fail initially (expected). Implementation follows.

Rob: Run tests, read failures, implement to make them pass. Tests are your guide.

---

*"I'm not a great programmer; I'm just a good programmer with great habits."* - Kent Beck

The habit is TDD. Tests first. Always.
