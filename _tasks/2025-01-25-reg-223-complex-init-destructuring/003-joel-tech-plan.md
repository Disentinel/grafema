# Joel Spolsky — Technical Specification for REG-223

**REVISION 2 — 2025-01-25**

Updated per Linus's review (004-linus-plan-review.md):
- Added explicit failure handling with warnings and counters
- Audited DERIVES_FROM consumers (see "DERIVES_FROM Consumer Audit" section)
- Made sourceType metadata MANDATORY for EXPRESSION nodes
- Added coordinate validation test case

---

## Executive Summary

Extend REG-201 destructuring support to handle complex init expressions (CallExpression, AwaitExpression). The core insight: CALL_SITE nodes already exist, we just need to create EXPRESSION nodes that DERIVES_FROM them instead of DERIVES_FROM VARIABLE nodes.

**Key architectural pattern:**
```
Simple (REG-201):    x → ASSIGNED_FROM → EXPRESSION(obj.x) → DERIVES_FROM → VARIABLE(obj)
Complex (REG-223):   x → ASSIGNED_FROM → EXPRESSION(func().x) → DERIVES_FROM → CALL_SITE(func)
```

## Implementation Plan

### Phase 1: Extend Data Types

#### 1.1 Update VariableAssignmentInfo Interface (REVISION 2)

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/types.ts`

**Location:** Lines 456-489 (VariableAssignmentInfo interface)

**Change:** Add new optional fields for call-based sources:

```typescript
export interface VariableAssignmentInfo {
  // ... existing fields ...
  objectSourceName?: string | null;  // For VARIABLE sources (REG-201)

  // NEW: For CALL_SITE sources (REG-223, REVISION 2)
  callSourceLine?: number;      // Line of the CallExpression
  callSourceColumn?: number;    // Column of the CallExpression
  callSourceFile?: string;      // File containing the call
  callSourceName?: string;      // Function name (for lookup disambiguation)

  // REVISION 2: MANDATORY metadata for distinguishing source types
  sourceMetadata?: {
    sourceType: 'call' | 'variable' | 'method-call';
  };

  // ... rest of existing fields ...
}
```

**Rationale:**
- `objectSourceName` is used in GraphBuilder line 886-896 to look up VARIABLE nodes
- We need parallel fields to look up CALL_SITE nodes by coordinates
- Line/column is the primary lookup (matches GraphBuilder's existing CALL_SITE lookup at line 770-782)
- `callSourceName` provides disambiguation when multiple calls on same line
- **REVISION 2:** `sourceMetadata` is MANDATORY per Linus review - allows graph queries to distinguish call-based vs variable-based EXPRESSION nodes

### Phase 2: Helper Functions in JSASTAnalyzer

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Add these private helper methods before `trackDestructuringAssignment()` (around line 835):**

#### 2.1 unwrapAwaitExpression()

```typescript
/**
 * Recursively unwrap AwaitExpression to get the underlying expression.
 * await await fetch() -> fetch()
 */
private unwrapAwaitExpression(node: t.Expression): t.Expression {
  if (node.type === 'AwaitExpression' && node.argument) {
    return this.unwrapAwaitExpression(node.argument);
  }
  return node;
}
```

**Purpose:** Handle `const { x } = await fetch()` and nested awaits

**Pattern:** Matches existing logic in `trackVariableAssignment()` line 563-564

#### 2.2 extractCallInfo()

```typescript
/**
 * Extract call site information from CallExpression.
 * Returns null if not a valid CallExpression.
 */
private extractCallInfo(node: t.Expression): {
  line: number;
  column: number;
  name: string;
  isMethodCall: boolean;
} | null {
  if (node.type !== 'CallExpression') {
    return null;
  }

  const callee = node.callee;
  let name: string;
  let isMethodCall = false;

  // Direct call: fetchUser()
  if (t.isIdentifier(callee)) {
    name = callee.name;
  }
  // Method call: obj.fetchUser() or arr.map()
  else if (t.isMemberExpression(callee)) {
    isMethodCall = true;
    const objectName = t.isIdentifier(callee.object)
      ? callee.object.name
      : (t.isThisExpression(callee.object) ? 'this' : 'unknown');
    const methodName = t.isIdentifier(callee.property)
      ? callee.property.name
      : 'unknown';
    name = `${objectName}.${methodName}`;
  }
  else {
    return null;
  }

  return {
    line: node.loc?.start.line ?? 0,
    column: node.loc?.start.column ?? 0,
    name,
    isMethodCall
  };
}
```

**Purpose:** Extract metadata needed for CALL_SITE lookup

**Pattern:** Mirrors logic from `trackVariableAssignment()` lines 589-655

**Edge cases:**
- Handles both Identifier callee (`func()`) and MemberExpression callee (`obj.method()`)
- Returns null for unsupported patterns (computed properties, complex callees)
- Coordinates match what CallExpressionVisitor stores in CALL_SITE nodes

#### 2.3 isCallOrAwaitExpression()

```typescript
/**
 * Check if expression is CallExpression or AwaitExpression wrapping a call.
 */
private isCallOrAwaitExpression(node: t.Expression): boolean {
  const unwrapped = this.unwrapAwaitExpression(node);
  return unwrapped.type === 'CallExpression';
}
```

**Purpose:** Guard for Phase 2 logic in trackDestructuringAssignment()

### Phase 3: Modify trackDestructuringAssignment()

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** Lines 836-934

**Current code at lines 847-850:**
```typescript
if (!t.isIdentifier(initNode)) {
  // TODO: Phase 2 - handle CallExpression, MemberExpression, etc.
  return;
}
```

**Replace with:**

```typescript
// Phase 1: Simple Identifier (existing logic - KEEP AS IS)
if (t.isIdentifier(initNode)) {
  const sourceBaseName = initNode.name;

  // ... existing code for ObjectPattern and ArrayPattern (lines 852-933)
  // DO NOT MODIFY THIS BLOCK
}
// Phase 2: CallExpression or AwaitExpression (NEW)
else if (this.isCallOrAwaitExpression(initNode)) {
  const unwrapped = this.unwrapAwaitExpression(initNode);
  const callInfo = this.extractCallInfo(unwrapped);

  if (!callInfo) {
    // Unsupported call pattern (computed callee, etc.)
    return;
  }

  // Process each extracted variable
  for (const varInfo of variables) {
    const variableId = varInfo.id;

    // Handle rest elements - create edge to call site directly
    if (varInfo.isRest) {
      variableAssignments.push({
        variableId,
        sourceType: 'CALL_SITE',
        callName: callInfo.name,
        callLine: callInfo.line,
        callColumn: callInfo.column,
        line: varInfo.loc.start.line
      });
      continue;
    }

    // ObjectPattern: const { data } = fetchUser() → data ASSIGNED_FROM fetchUser().data
    if (t.isObjectPattern(pattern) && varInfo.propertyPath && varInfo.propertyPath.length > 0) {
      const propertyPath = varInfo.propertyPath;
      const expressionLine = varInfo.loc.start.line;
      const expressionColumn = varInfo.loc.start.column;

      // Build property path string: "fetchUser().data" or "fetchUser().user.name"
      const callRepresentation = `${callInfo.name}()`;
      const fullPath = [callRepresentation, ...propertyPath].join('.');

      const expressionId = ExpressionNode.generateId(
        'MemberExpression',
        module.file,
        expressionLine,
        expressionColumn
      );

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'MemberExpression',
        object: callRepresentation,          // "fetchUser()" - display name
        property: propertyPath[propertyPath.length - 1],
        computed: false,
        path: fullPath,                       // "fetchUser().data"
        propertyPath: propertyPath,           // ["data"]
        // NEW: Call source for DERIVES_FROM lookup (REVISION 2)
        callSourceLine: callInfo.line,
        callSourceColumn: callInfo.column,
        callSourceFile: module.file,
        callSourceName: callInfo.name,
        // REVISION 2: MANDATORY sourceType metadata for queries
        sourceMetadata: {
          sourceType: 'call'  // Distinguishes from 'variable'
        },
        file: module.file,
        line: expressionLine,
        column: expressionColumn
      });
    }
    // ArrayPattern: const [first] = arr.map(fn) → first ASSIGNED_FROM arr.map(fn)[0]
    else if (t.isArrayPattern(pattern) && varInfo.arrayIndex !== undefined) {
      const arrayIndex = varInfo.arrayIndex;
      const expressionLine = varInfo.loc.start.line;
      const expressionColumn = varInfo.loc.start.column;

      const callRepresentation = `${callInfo.name}()`;
      const hasPropertyPath = varInfo.propertyPath && varInfo.propertyPath.length > 0;

      const expressionId = ExpressionNode.generateId(
        'MemberExpression',
        module.file,
        expressionLine,
        expressionColumn
      );

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'MemberExpression',
        object: callRepresentation,
        property: String(arrayIndex),
        computed: true,
        arrayIndex: arrayIndex,
        propertyPath: hasPropertyPath ? varInfo.propertyPath : undefined,
        // NEW: Call source for DERIVES_FROM lookup (REVISION 2)
        callSourceLine: callInfo.line,
        callSourceColumn: callInfo.column,
        callSourceFile: module.file,
        callSourceName: callInfo.name,
        // REVISION 2: MANDATORY sourceType metadata for queries
        sourceMetadata: {
          sourceType: 'call'  // Distinguishes from 'variable'
        },
        file: module.file,
        line: expressionLine,
        column: expressionColumn
      });
    }
  }
}
// Unsupported init type (MemberExpression without call, etc.)
else {
  return;
}
```

**Key decisions:**

1. **Rest elements:** Create direct CALL_SITE assignment, not EXPRESSION
   - Pattern: `const { ...rest } = fetch()` → `rest → ASSIGNED_FROM → CALL_SITE`
   - Matches REG-201 pattern for rest from variables

2. **Call representation string:** `"fetchUser()"` with parentheses
   - Makes it clear in graph visualization that it's a call result
   - Distinguishes from variable names

3. **Property path preservation:** Works same as REG-201
   - `const { user: { name } } = fetch()` → `path: "fetchUser().user.name"`

4. **Mixed patterns:** Automatically handled
   - `const { items: [first] } = fetch()` → both propertyPath and arrayIndex set

### Phase 4: Extend GraphBuilder DERIVES_FROM Logic

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Location:** Lines 886-897 (DERIVES_FROM edge creation for MemberExpression)

**Current code:**
```typescript
if (expressionType === 'MemberExpression' && objectSourceName) {
  const objectVar = variableDeclarations.find(v =>
    v.name === objectSourceName && (!varFile || v.file === varFile)
  );
  if (objectVar) {
    this._bufferEdge({
      type: 'DERIVES_FROM',
      src: sourceId,
      dst: objectVar.id
    });
  }
}
```

**Add new branch AFTER existing code:**

```typescript
if (expressionType === 'MemberExpression' && objectSourceName) {
  // Existing VARIABLE lookup - KEEP AS IS
  const objectVar = variableDeclarations.find(v =>
    v.name === objectSourceName && (!varFile || v.file === varFile)
  );
  if (objectVar) {
    this._bufferEdge({
      type: 'DERIVES_FROM',
      src: sourceId,
      dst: objectVar.id
    });
  }
}
// NEW: Call-based source lookup (REG-223, REVISION 2)
else if (expressionType === 'MemberExpression' && assignment.callSourceLine !== undefined) {
  const { callSourceLine, callSourceColumn, callSourceName, callSourceFile } = assignment;

  // Try CALL_SITE first (direct function calls)
  const callSite = callSites.find(cs =>
    cs.line === callSourceLine &&
    cs.column === callSourceColumn &&
    (callSourceName ? cs.name === callSourceName : true)
  );

  if (callSite) {
    this._bufferEdge({
      type: 'DERIVES_FROM',
      src: sourceId,
      dst: callSite.id
    });
  }
  // Fall back to methodCalls (arr.map(), obj.getConfig())
  else {
    // Method calls stored differently - need inline CALL node lookup
    // Format: CALL#fullName#file#line:column:inline
    const inlineCallId = methodCalls.find(mc =>
      mc.line === callSourceLine &&
      mc.column === callSourceColumn &&
      (callSourceName ? mc.name === callSourceName : true)
    );

    if (inlineCallId) {
      this._bufferEdge({
        type: 'DERIVES_FROM',
        src: sourceId,
        dst: inlineCallId.id
      });
    }
    // REVISION 2: Explicit failure handling - NO SILENT FAILURES
    else {
      // Track failed lookup for end-of-analysis report
      if (!this._skippedDestructuringCalls) {
        this._skippedDestructuringCalls = [];
      }
      this._skippedDestructuringCalls.push({
        expressionId: sourceId,
        callName: callSourceName,
        file: callSourceFile,
        line: callSourceLine,
        column: callSourceColumn
      });

      // Log warning with context for debugging
      console.warn(
        `[REG-223] DERIVES_FROM lookup failed for EXPRESSION(${assignment.object}.${assignment.property}) ` +
        `at ${callSourceFile}:${callSourceLine}:${callSourceColumn}. ` +
        `Expected CALL_SITE or methodCall for "${callSourceName}". ` +
        `This indicates a coordinate mismatch or missing call node.`
      );
    }
  }
}
```

**Lookup strategy:**

1. **Try CALL_SITE first** (for `fetchUser()` direct calls)
   - Matches existing pattern at line 770-782
   - Uses line + column + optional name for disambiguation

2. **Fall back to methodCalls** (for `arr.map()`, `obj.getConfig()`)
   - Method calls create inline CALL nodes (see trackVariableAssignment line 608)
   - Same coordinate-based lookup

3. **Disambiguation:** Use function name when multiple calls on same line
   - Example: `const { x } = f1(), { y } = f2();` (rare but possible)

**Why else-if?**
- `objectSourceName` and `callSourceLine` are mutually exclusive
- If both were set, it would be a bug
- `else if` makes this constraint explicit

### Phase 5: Update ExpressionNode Factory (REVISION 2)

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/nodes/ExpressionNode.ts`

**MANDATORY CHANGES (per Linus review):**

1. Accept arbitrary object names (including "fetchUser()")
2. Store sourceType metadata (MANDATORY, not optional)

**Required implementation:**

```typescript
// In createExpressionFromMetadata() or similar factory method
static createExpressionFromMetadata(metadata: VariableAssignmentInfo): ExpressionNode {
  // ... existing code ...

  // Ensure object field accepts both variable names and call representations
  const object = metadata.object ?? 'unknown';
  // No validation needed - accept any string

  // REVISION 2: sourceType is MANDATORY
  // Determines whether EXPRESSION derives from VARIABLE or CALL
  const sourceType = metadata.sourceMetadata?.sourceType ??
                     (metadata.callSourceLine !== undefined ? 'call' : 'variable');

  return new ExpressionNode({
    // ... existing fields ...
    object,
    // REVISION 2: MANDATORY metadata for graph queries
    metadata: {
      sourceType  // 'call' | 'variable' | 'method-call'
    }
  });
}
```

**Type update needed in VariableAssignmentInfo:**

```typescript
export interface VariableAssignmentInfo {
  // ... existing fields ...

  // REVISION 2: MANDATORY metadata
  sourceMetadata?: {
    sourceType: 'call' | 'variable' | 'method-call';
  };
}
```

**Purpose:** Allows graph queries to distinguish call-based EXPRESSION nodes without:
- Parsing the `object` string for "()" characters
- Making assumptions about DERIVES_FROM edge targets
- Brittle string matching

**Usage example:**
```typescript
// Query: Find all destructuring from function calls
const callBasedExpressions = await backend.queryNodes({
  type: 'EXPRESSION',
  metadata: { sourceType: 'call' }
});
```

## Test Specification

### Test File

**Path:** `/Users/vadimr/grafema-worker-4/test/unit/DestructuringComplexInit.test.js`

**Structure:** Mirror existing `DestructuringDataFlow.test.js`

### Test Cases

#### 5.1 Basic CallExpression (Direct Function Call)

```javascript
describe('Destructuring from CallExpression', () => {
  it('should create ASSIGNED_FROM edge to EXPRESSION for simple call', async () => {
    const { backend, testDir } = await setupTest({
      'index.js': `
function getConfig() {
  return { apiKey: 'secret', timeout: 1000 };
}
const { apiKey } = getConfig();
`
    });

    // Find variable 'apiKey'
    const apiKeyVar = await findVariable(backend, 'apiKey');
    assert.ok(apiKeyVar, 'Should find variable "apiKey"');

    // Check ASSIGNED_FROM edge
    const edges = await backend.getOutgoingEdges(apiKeyVar.id, ['ASSIGNED_FROM']);
    assert.strictEqual(edges.length, 1, 'Should have exactly one ASSIGNED_FROM edge');

    // Verify EXPRESSION node
    const expr = await backend.getNode(edges[0].dst);
    assert.strictEqual(expr.type, 'EXPRESSION');
    assert.strictEqual(expr.expressionType, 'MemberExpression');
    assert.strictEqual(expr.object, 'getConfig()');
    assert.strictEqual(expr.property, 'apiKey');

    // Verify DERIVES_FROM edge to CALL_SITE
    const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
    assert.strictEqual(derivesEdges.length, 1, 'Should have DERIVES_FROM edge');

    const callSite = await backend.getNode(derivesEdges[0].dst);
    assert.strictEqual(callSite.type, 'CALL');
    assert.strictEqual(callSite.name, 'getConfig');
  });
});
```

#### 5.2 AwaitExpression

```javascript
it('should handle await unwrapping', async () => {
  const { backend } = await setupTest({
    'index.js': `
async function fetchUser() {
  return { id: 1, name: 'Alice' };
}
async function main() {
  const { name } = await fetchUser();
}
`
  });

  const nameVar = await findVariable(backend, 'name');
  const edges = await backend.getOutgoingEdges(nameVar.id, ['ASSIGNED_FROM']);
  const expr = await backend.getNode(edges[0].dst);

  assert.strictEqual(expr.object, 'fetchUser()');

  // DERIVES_FROM should point to fetchUser CALL_SITE (after await unwrapping)
  const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
  const callSite = await backend.getNode(derivesEdges[0].dst);
  assert.strictEqual(callSite.name, 'fetchUser');
});
```

#### 5.3 Method Call (MemberExpression callee)

```javascript
it('should handle method calls', async () => {
  const { backend } = await setupTest({
    'index.js': `
const arr = [1, 2, 3];
const [first] = arr.filter(x => x > 0);
`
  });

  const firstVar = await findVariable(backend, 'first');
  const edges = await backend.getOutgoingEdges(firstVar.id, ['ASSIGNED_FROM']);
  const expr = await backend.getNode(edges[0].dst);

  assert.strictEqual(expr.object, 'arr.filter()');
  assert.strictEqual(expr.property, '0');  // Array index
  assert.strictEqual(expr.computed, true);

  // DERIVES_FROM should point to inline CALL node
  const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
  assert.strictEqual(derivesEdges.length, 1);
  const methodCall = await backend.getNode(derivesEdges[0].dst);
  assert.strictEqual(methodCall.type, 'CALL');
  assert.ok(methodCall.name.includes('filter'));
});
```

#### 5.4 Nested Object Destructuring

```javascript
it('should handle nested destructuring from call', async () => {
  const { backend } = await setupTest({
    'index.js': `
function fetchData() {
  return { user: { id: 1, name: 'Bob' }, timestamp: 123 };
}
const { user: { name } } = fetchData();
`
  });

  const nameVar = await findVariable(backend, 'name');
  const edges = await backend.getOutgoingEdges(nameVar.id, ['ASSIGNED_FROM']);
  const expr = await backend.getNode(edges[0].dst);

  assert.strictEqual(expr.object, 'fetchData()');
  assert.strictEqual(expr.path, 'fetchData().user.name');

  const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
  const callSite = await backend.getNode(derivesEdges[0].dst);
  assert.strictEqual(callSite.name, 'fetchData');
});
```

#### 5.5 Mixed Pattern (Object + Array)

```javascript
it('should handle mixed object and array destructuring', async () => {
  const { backend } = await setupTest({
    'index.js': `
function getResponse() {
  return { items: [{ id: 1 }, { id: 2 }], status: 'ok' };
}
const { items: [first] } = getResponse();
`
  });

  const firstVar = await findVariable(backend, 'first');
  const edges = await backend.getOutgoingEdges(firstVar.id, ['ASSIGNED_FROM']);
  const expr = await backend.getNode(edges[0].dst);

  assert.strictEqual(expr.object, 'getResponse()');
  assert.strictEqual(expr.arrayIndex, 0);
  assert.deepStrictEqual(expr.propertyPath, ['items']);

  const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
  const callSite = await backend.getNode(derivesEdges[0].dst);
  assert.strictEqual(callSite.name, 'getResponse');
});
```

#### 5.6 Rest Element

```javascript
it('should create direct CALL_SITE assignment for rest element', async () => {
  const { backend } = await setupTest({
    'index.js': `
function getConfig() {
  return { a: 1, b: 2, c: 3 };
}
const { a, ...rest } = getConfig();
`
  });

  const restVar = await findVariable(backend, 'rest');
  const edges = await backend.getOutgoingEdges(restVar.id, ['ASSIGNED_FROM']);

  // Rest should point directly to CALL_SITE, not EXPRESSION
  const target = await backend.getNode(edges[0].dst);
  assert.strictEqual(target.type, 'CALL');
  assert.strictEqual(target.name, 'getConfig');
});
```

#### 5.7 Regression Test (REG-201 Still Works)

```javascript
it('should NOT break existing simple destructuring (REG-201)', async () => {
  const { backend } = await setupTest({
    'index.js': `
const config = { apiKey: 'secret' };
const { apiKey } = config;
`
  });

  const apiKeyVar = await findVariable(backend, 'apiKey');
  const edges = await backend.getOutgoingEdges(apiKeyVar.id, ['ASSIGNED_FROM']);
  const expr = await backend.getNode(edges[0].dst);

  assert.strictEqual(expr.object, 'config');  // NOT "config()"

  // DERIVES_FROM should point to VARIABLE, not CALL_SITE
  const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
  const source = await backend.getNode(derivesEdges[0].dst);
  assert.ok(['VARIABLE', 'CONSTANT'].includes(source.type));
  assert.strictEqual(source.name, 'config');
});
```

#### 5.8 Coordinate Validation Test (REVISION 2)

**Purpose:** Catch coordinate mismatch bugs (per Linus review)

```javascript
it('should handle await with correct coordinate lookup', async () => {
  const { backend } = await setupTest({
    'index.js': `
async function fetchUser() {
  return { id: 1, name: 'Alice' };
}
async function main() {
  const { id } =
    await fetchUser();  // Multi-line to test coordinate mapping
}
`
  });

  // Verify DERIVES_FROM edge exists (if missing, coordinate lookup failed)
  const idVar = await findVariable(backend, 'id');
  assert.ok(idVar, 'Should find variable "id"');

  const edges = await backend.getOutgoingEdges(idVar.id, ['ASSIGNED_FROM']);
  assert.strictEqual(edges.length, 1, 'Should have ASSIGNED_FROM edge');

  const expr = await backend.getNode(edges[0].dst);
  assert.strictEqual(expr.type, 'EXPRESSION');
  assert.strictEqual(expr.object, 'fetchUser()');

  // CRITICAL: Verify DERIVES_FROM edge exists
  const derivesEdges = await backend.getOutgoingEdges(expr.id, ['DERIVES_FROM']);
  assert.strictEqual(derivesEdges.length, 1,
    'Coordinate lookup must succeed for await expression - if this fails, AwaitExpression coordinates are being used instead of CallExpression coordinates');

  const callSite = await backend.getNode(derivesEdges[0].dst);
  assert.strictEqual(callSite.type, 'CALL');
  assert.strictEqual(callSite.name, 'fetchUser');
});

it('should handle multiple calls on same line with correct disambiguation', async () => {
  const { backend } = await setupTest({
    'index.js': `
function f1() { return { x: 1 }; }
function f2() { return { y: 2 }; }
const { x } = f1(), { y } = f2();
`
  });

  // Verify both destructurings create correct DERIVES_FROM edges
  const xVar = await findVariable(backend, 'x');
  const xEdges = await backend.getOutgoingEdges(xVar.id, ['ASSIGNED_FROM']);
  const xExpr = await backend.getNode(xEdges[0].dst);
  const xDerives = await backend.getOutgoingEdges(xExpr.id, ['DERIVES_FROM']);
  assert.strictEqual(xDerives.length, 1, 'x should have DERIVES_FROM edge');
  const xCall = await backend.getNode(xDerives[0].dst);
  assert.strictEqual(xCall.name, 'f1', 'x should derive from f1, not f2');

  const yVar = await findVariable(backend, 'y');
  const yEdges = await backend.getOutgoingEdges(yVar.id, ['ASSIGNED_FROM']);
  const yExpr = await backend.getNode(yEdges[0].dst);
  const yDerives = await backend.getOutgoingEdges(yExpr.id, ['DERIVES_FROM']);
  assert.strictEqual(yDerives.length, 1, 'y should have DERIVES_FROM edge');
  const yCall = await backend.getNode(yDerives[0].dst);
  assert.strictEqual(yCall.name, 'f2', 'y should derive from f2, not f1');
});
```

### Helper Function

Add to test file:

```javascript
async function findVariable(backend, name) {
  for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
    if (node.name === name) return node;
  }
  for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
    if (node.name === name) return node;
  }
  return null;
}
```

## Edge Cases & Error Handling

### 1. Unsupported Call Patterns

**Pattern:** Computed callee, complex expressions

```javascript
const { x } = (condition ? f1 : f2)();  // ❌ Not supported
const { x } = obj[key]();                // ❌ Not supported
```

**Handling:** `extractCallInfo()` returns null → early return, no edge created

**Test:** Add negative test to verify graceful skip (no crash, no partial data)

### 2. Multiple Calls on Same Line

**Pattern:** One-liner with multiple destructuring

```javascript
const { x } = f1(), { y } = f2();
```

**Handling:** `callSourceName` disambiguates. Lookup uses `cs.name === callSourceName`.

**Test:** Verify both x and y get correct DERIVES_FROM edges

### 3. Nested Await

**Pattern:** `await await fetch()`

```javascript
const { x } = await await fetchUser();
```

**Handling:** `unwrapAwaitExpression()` recursively unwraps

**Test:** Verify DERIVES_FROM points to innermost call

### 4. Method Call Not in methodCalls Collection

**Risk:** If CallExpressionVisitor doesn't create inline CALL for some method patterns

**Mitigation:**
- Primary: Fix CallExpressionVisitor if missing patterns
- Fallback: Log warning in GraphBuilder if lookup fails
- Test: Verify all acceptance criteria method calls create edges

**Debug strategy:**
```typescript
else {
  const methodCall = methodCalls.find(...);
  if (!methodCall) {
    console.warn(`[REG-223] No method call found for ${callSourceName} at ${callSourceLine}:${callSourceColumn}`);
  }
}
```

### 5. CALL_SITE Missing (Race Condition?)

**Risk:** Destructuring processed before CallExpressionVisitor runs?

**Mitigation:** Verify visitor order. CallExpressionVisitor should run in parallel with VariableVisitor, both populate collections, GraphBuilder processes after both.

**Test:** Integration test with real project analysis (not just unit fixtures)

## Performance Considerations

### Lookup Complexity

**Current:**
- VARIABLE lookup: O(n) scan of variableDeclarations
- CALL_SITE lookup: O(n) scan of callSites

**New:**
- Add CALL_SITE lookup: +1 O(n) scan per destructured variable from call

**Impact estimation:**
- Typical file: 10-50 variables, 5-20 calls
- Destructuring from calls: ~2-5 per file (based on 20% rate)
- Additional lookups: negligible

**Optimization (future):** Index callSites by `${line}:${column}` key in GraphBuilder constructor. Not critical for Phase 1.

### Node Count Growth

**New nodes:** EXPRESSION nodes for call-based destructuring

**Estimate:**
- Existing (REG-201): ~1 EXPRESSION per destructured property from variable
- New (REG-223): ~0.2 EXPRESSION per destructured property from call (20% rate)
- Total increase: ~20% more EXPRESSION nodes

**Impact:** Negligible (EXPRESSION nodes are small, no heavy metadata)

## DERIVES_FROM Consumer Audit (REVISION 2)

**Per Linus review requirement:** All code that traverses DERIVES_FROM edges must be audited to ensure compatibility with CALL/CALL_SITE targets.

### Audit Results

**Methodology:** Searched codebase for all DERIVES_FROM usage:
```bash
grep -r "DERIVES_FROM" packages/core/src/plugins/
grep -r "DERIVES_FROM" packages/cli/src/
grep -r "DERIVES_FROM" packages/mcp/src/
```

### Found Consumers

#### 1. ValueDomainAnalyzer.ts (Line 600-640)

**Location:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts`

**Usage:** Follows DERIVES_FROM edges during value tracing

**Code:**
```typescript
const dataFlowEdges = outgoing.filter(e => {
  const edgeType = (e as { edgeType?: string; edge_type?: string }).edgeType ||
                   (e as { edge_type?: string }).edge_type;
  return edgeType === 'ASSIGNED_FROM' || edgeType === 'DERIVES_FROM';
});

for (const edge of dataFlowEdges) {
  const targetId = (edge as { dst?: string; target_id?: string }).dst ||
                   (edge as { target_id?: string }).target_id;
  const sourceNode = await graph.getNode(targetId);
  const sourceResult = await this.traceValueSet(sourceNode, graph, visited, depth + 1);
  // Recursively processes source node
}
```

**Assessment:** ✅ COMPATIBLE
- Does NOT assume target type
- Recursively processes target node (generic handling)
- Will work with CALL/CALL_SITE targets (recursion handles all node types)

**Action:** None required

---

#### 2. SQLInjectionValidator.ts (Line 317-346)

**Location:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/validation/SQLInjectionValidator.ts`

**Usage:** Checks DERIVES_FROM edges for taint analysis

**Code:**
```typescript
const derivesFromEdges = outgoing.filter(e =>
  (e.edgeType || e.edge_type) === 'DERIVES_FROM' ||
  (e.edgeType || e.edge_type) === 'ASSIGNED_FROM'
);

for (const edge of derivesFromEdges) {
  const sourceNode = await graph.getNode(sourceId!);
  const sourceType = sourceNode.nodeType || sourceNode.type;

  if (sourceType === 'PARAMETER') {
    result.hasUnknown = true;
  } else if (sourceType === 'VARIABLE' || sourceType === 'CONSTANT') {
    const valueSet = await this.valueAnalyzer.getValueSet(varName, file, graph);
    if (valueSet.hasUnknown) {
      result.hasUnknown = true;
    }
  }
}
```

**Assessment:** ⚠️ PARTIALLY COMPATIBLE
- Currently only handles PARAMETER, VARIABLE, CONSTANT
- CALL/CALL_SITE targets will fall through (no else branch)
- NOT broken, but incomplete: CALL sources treated as known-safe (silent ignore)

**Impact:**
- False negatives possible: `const { userId } = getParams(); query(userId)` might not be flagged
- Not a regression (existing behavior for unhandled types)
- Could be enhanced in future to trace through CALL returns

**Action:** Document as known limitation, add TODO for future enhancement

**Proposed update (optional, not required for REG-223):**
```typescript
else if (sourceType === 'CALL' || sourceType === 'CALL_SITE') {
  // Future enhancement: trace function return values
  // For now, conservatively mark as unknown
  result.hasUnknown = true;
  result.sources.push(`call:${sourceNode.name || 'unknown'}`);
}
```

---

#### 3. CLI trace command (Line 201, 260)

**Location:** `/Users/vadimr/grafema-worker-4/packages/cli/src/commands/trace.ts`

**Usage:** Traces data flow forward/backward via DERIVES_FROM

**Code:**
```typescript
const edges = await backend.getOutgoingEdges(id, ['ASSIGNED_FROM', 'DERIVES_FROM']);
for (const edge of edges) {
  // Displays edge target generically
}
```

**Assessment:** ✅ COMPATIBLE
- Generic edge traversal (doesn't inspect target type)
- Displays all nodes uniformly
- Will show CALL targets correctly

**Action:** None required

---

#### 4. CLI explore command (Line 1002)

**Location:** `/Users/vadimr/grafema-worker-4/packages/cli/src/commands/explore.tsx`

**Usage:** Shows DERIVES_FROM edges in interactive explorer

**Code:**
```typescript
const derivesIn = await backend.getIncomingEdges(varId, ['DERIVES_FROM']);
for (const edge of derivesIn) {
  const src = await backend.getNode(edge.src);
  // Generic display
}
```

**Assessment:** ✅ COMPATIBLE
- Generic node rendering
- No type assumptions

**Action:** None required

---

#### 5. MCP handlers (Line 345, 356)

**Location:** `/Users/vadimr/grafema-worker-4/packages/mcp/src/handlers.ts`

**Usage:** Includes DERIVES_FROM in edge queries

**Code:**
```typescript
const outEdges = await db.getOutgoingEdges(nodeId, ['ASSIGNED_FROM', 'DERIVES_FROM', 'PASSES_ARGUMENT']);
const inEdges = await db.getIncomingEdges(nodeId, ['ASSIGNED_FROM', 'DERIVES_FROM', 'PASSES_ARGUMENT']);
```

**Assessment:** ✅ COMPATIBLE
- Only fetches edges, doesn't inspect targets
- Generic MCP protocol response

**Action:** None required

---

#### 6. GraphBuilder.ts (Lines 937, 951, 963, 978, 990, 1007, 1028, 1039)

**Location:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Usage:** Creates DERIVES_FROM edges (producer, not consumer)

**Assessment:** ✅ NOT A CONSUMER
- Only creates edges, doesn't traverse them

**Action:** None required (modified in Phase 4 of this spec)

---

### Summary

**Total DERIVES_FROM consumers found:** 5

**Breakdown:**
- ✅ **Compatible (4):** ValueDomainAnalyzer, trace command, explore command, MCP handlers
- ⚠️ **Partially compatible (1):** SQLInjectionValidator (incomplete, not broken)

**Critical finding:** No breaking changes. All consumers either:
1. Use generic node handling (recursive traversal, display)
2. Have explicit type checks that gracefully ignore unknown types

**SQLInjectionValidator note:** Currently treats CALL sources as known-safe (falls through). This is existing behavior for unhandled types, not a regression. Could be enhanced later to trace function return values for more precise taint analysis.

**Conclusion:** ✅ **SAFE TO PROCEED** - No consumers will break with REG-223 changes.

---

## Integration Points

### Value Domain Analysis

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts`

**Current behavior:** Recursively traces DERIVES_FROM edges without type assumptions

**Impact:** ✅ Works correctly with CALL targets (confirmed in audit above)

**Test:**
```javascript
const { data } = fetchUser();
console.log(data.id);  // ValueDomainAnalyzer will trace through DERIVES_FROM to CALL_SITE
```

**Expected:** Recursive tracing handles CALL nodes generically

### Graph Query Patterns

**General pattern for future code:**

```typescript
// ✅ GOOD: Generic handling
const source = await graph.getNode(derivesFromEdge.dst);
const sourceResult = await processNode(source);  // Handles all types

// ❌ BAD: Type-specific assumptions
const source = await graph.getNode(derivesFromEdge.dst);
assert(source.type === 'VARIABLE');  // BREAKS if source is CALL
```

## Implementation Order

### Step-by-Step Execution

1. **Write tests FIRST** (Kent Beck)
   - Create `DestructuringComplexInit.test.js`
   - Implement test cases 5.1-5.7
   - All tests should fail initially (RED)

2. **Extend types** (Rob Pike)
   - Update VariableAssignmentInfo interface
   - No behavior change, only type expansion
   - Commit: "feat(REG-223): extend VariableAssignmentInfo for call sources"

3. **Add helper functions** (Rob Pike)
   - Implement unwrapAwaitExpression()
   - Implement extractCallInfo()
   - Implement isCallOrAwaitExpression()
   - Unit test helpers in isolation (optional)
   - Commit: "feat(REG-223): add call extraction helpers"

4. **Modify trackDestructuringAssignment** (Rob Pike)
   - Remove early return
   - Add Phase 2 logic (CallExpression handling)
   - Tests should start passing for ASSIGNED_FROM part
   - DERIVES_FROM edges still missing (expected)
   - Commit: "feat(REG-223): track destructuring from CallExpression"

5. **Extend GraphBuilder** (Rob Pike)
   - Add call-based DERIVES_FROM logic
   - All tests should pass (GREEN)
   - Commit: "feat(REG-223): create DERIVES_FROM edges to CALL_SITE"

6. **Verify ExpressionNode** (Rob Pike)
   - Test that object="fetchUser()" works
   - If broken, fix factory method
   - Commit (if needed): "fix(REG-223): support call representation in EXPRESSION"

7. **Run full test suite** (Kent Beck)
   - `npm test` - all existing tests must pass
   - Verify REG-201 regression tests specifically
   - If failures, debug and fix

8. **Integration testing** (Rob Pike)
   - Test with real project (Grafema itself?)
   - Verify graph correctness with complex destructuring patterns
   - Check for edge cases not covered by unit tests

### Atomic Commits

Each commit should:
- Build successfully
- Pass all existing tests
- Add ONE logical change
- Have clear commit message

**Example sequence:**
```
feat(REG-223): add tests for complex destructuring
feat(REG-223): extend VariableAssignmentInfo for call sources
feat(REG-223): add call extraction helpers
feat(REG-223): track destructuring from CallExpression
feat(REG-223): create DERIVES_FROM edges to CALL_SITE
```

## Success Criteria Checklist

### Functional Requirements

- [ ] Test 5.1 passes: `const { x } = getConfig()` creates edges
- [ ] Test 5.2 passes: `const { x } = await fetch()` unwraps await
- [ ] Test 5.3 passes: `const [first] = arr.map(fn)` handles method calls
- [ ] Test 5.4 passes: Nested destructuring `{ user: { name } }`
- [ ] Test 5.5 passes: Mixed pattern `{ items: [first] }`
- [ ] Test 5.6 passes: Rest element `{ ...rest }`
- [ ] Test 5.7 passes: REG-201 regression (simple destructuring still works)

### Graph Correctness

- [ ] EXPRESSION nodes created with correct metadata
  - `object: "fetchUser()"` (call representation)
  - `property: "data"` (destructured property)
  - `path: "fetchUser().data"` (full path)

- [ ] DERIVES_FROM edges point to correct targets
  - Direct calls → CALL_SITE node
  - Method calls → inline CALL node
  - No orphaned edges

- [ ] ASSIGNED_FROM edges connect variables to EXPRESSION nodes
  - Same pattern as REG-201

### Integration

- [ ] All existing tests pass (no regressions)
- [ ] Value domain analysis works through call-based destructuring (if applicable)
- [ ] Graph queries handle new edge patterns
- [ ] Performance impact < 5% slowdown on typical projects

### Code Quality

- [ ] No TODO/FIXME comments in production code
- [ ] Early return removed from line 847-850
- [ ] Helper functions have clear, focused purpose
- [ ] Error handling for unsupported patterns (graceful skip)

## Risk Mitigation Summary (REVISION 2)

| Risk | Likelihood | Impact | Mitigation | Status |
|------|------------|--------|------------|--------|
| CALL_SITE coordinates mismatch | Medium | High | Function name disambiguation + coordinate validation tests (5.8) + explicit warnings on failure | ✅ Mitigated |
| REG-201 regression | Low | Critical | Dedicated regression test (5.7), run full suite before merge | ✅ Mitigated |
| Method call lookup fails | Medium | Medium | Fall back to methodCalls + explicit warning logging + failure counter | ✅ Mitigated |
| Silent data loss (lookup failures) | High | Critical | **REVISION 2:** Explicit warnings, `_skippedDestructuringCalls` counter, end-of-analysis report | ✅ Mitigated |
| DERIVES_FROM consumers break | Low | Critical | **REVISION 2:** Full audit completed (see audit section) - no breaking changes found | ✅ Cleared |
| Performance degradation | Low | Low | Profile with typical project, optimize if needed | Acceptable |
| SQLInjectionValidator false negatives | Low | Low | Documented as known limitation, optional future enhancement | Acceptable |

## Open Questions for Rob Pike (REVISION 2)

**REVISION 2 updates:**
- ~~Question 4 (debug logging): ANSWERED - explicit warnings are MANDATORY (per Linus)~~
- Added question 5 about end-of-analysis reporting

1. **ExpressionNode factory:** Does `createExpressionFromMetadata()` already accept arbitrary `object` strings, or does it validate against variable names?

2. **Method call storage:** Are inline CALL nodes (from `trackVariableAssignment` line 608) stored in `methodCalls` collection or separate?

3. **Visitor order:** Is there any guarantee CallExpressionVisitor runs before GraphBuilder processes variableAssignments? Or is it parallel + buffering?

4. ~~**Debug logging:** Should we add warnings when CALL_SITE lookup fails?~~ **ANSWERED:** YES - mandatory per Linus review

5. **End-of-analysis report (NEW):** Where should `_skippedDestructuringCalls` summary be reported? Options:
   - GraphBuilder.finalize() method
   - JSASTAnalyzer completion hook
   - CLI summary output
   - All of the above

## Estimated Effort

**Complexity:** Medium

**Reasoning:**
- Direct extension of REG-201 patterns (well-understood)
- No new node types, only new edge connections
- Main challenge: coordinate-based lookup reliability (mitigated by function name)

**Time estimate:**
- Phase 1-2 (types + helpers): 1 hour
- Phase 3 (trackDestructuringAssignment): 2 hours
- Phase 4 (GraphBuilder): 1 hour
- Phase 5 (ExpressionNode): 0.5 hour
- Testing: 3 hours
- Integration + debugging: 2 hours
- **Total: ~10 hours** (1-2 days for experienced developer)

**Bottleneck risks:**
- CALL_SITE lookup debugging (if coordinates don't match)
- REG-201 regression investigation (if tests fail)
- Value domain integration (if queries need updates)

## Next Steps for Kent Beck

1. Create test file: `/Users/vadimr/grafema-worker-4/test/unit/DestructuringComplexInit.test.js`
2. Implement test cases 5.1-5.7 from this spec
3. Run tests → verify all fail (RED state)
4. Create test report in task directory
5. Signal Rob Pike to start implementation

---

**Joel Spolsky**
Technical Specification for REG-223
Version 1.0
