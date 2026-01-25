# Don Melton — High-Level Plan for REG-223

## Analysis

### Current State (REG-201)
REG-201 implemented ASSIGNED_FROM edges for simple destructuring:
```javascript
const { x } = obj;  // ✅ Works
// Creates: x -> ASSIGNED_FROM -> EXPRESSION(obj.x) -> DERIVES_FROM -> obj
```

Implementation in `JSASTAnalyzer.trackDestructuringAssignment()`:
- Lines 836-934
- Currently returns early at line 847-850 for any non-Identifier init
- Creates EXPRESSION nodes via VariableAssignmentInfo
- GraphBuilder (lines 830-951) creates actual EXPRESSION nodes and DERIVES_FROM edges

### The Problem
~20% of destructuring uses CallExpression as init:
```javascript
const { data } = await fetchUser();  // ❌ Skipped (AwaitExpression)
const { x } = getConfig();           // ❌ Skipped (CallExpression)
const [first] = arr.filter(fn);      // ❌ Skipped (CallExpression)
```

Current code at line 847-850:
```typescript
if (!t.isIdentifier(initNode)) {
  // TODO: Phase 2 - handle CallExpression, MemberExpression, etc.
  return;  // ❌ Silently skips these cases
}
```

### Key Architectural Discovery
The system already handles CallExpression assignments in `trackVariableAssignment()`:
- Line 563-564: AwaitExpression unwrapping (recursively calls itself with argument)
- Line 589-599: CallExpression with Identifier callee → creates CALL_SITE assignment
- Line 602-655: CallExpression with MemberExpression callee → creates CALL assignment

But `trackDestructuringAssignment()` doesn't use this logic — it returns early.

### The Pattern We Need
For `const { data } = await fetchUser()`:
1. Create CALL_SITE for `fetchUser()` at line/column (already done by CallExpressionVisitor)
2. Create EXPRESSION node representing `fetchUser().data`
3. Create edges:
   - `data` → ASSIGNED_FROM → `EXPRESSION(fetchUser().data)`
   - `EXPRESSION(fetchUser().data)` → DERIVES_FROM → `CALL_SITE(fetchUser())`

This is analogous to how REG-201 works:
```javascript
const { x } = obj;
// x -> ASSIGNED_FROM -> EXPRESSION(obj.x) -> DERIVES_FROM -> obj
```

But instead of DERIVES_FROM pointing to a VARIABLE, it points to a CALL_SITE.

## Key Insight

**We don't need to create CallExpression nodes — they already exist as CALL_SITE nodes.**

The solution is NOT about creating new call nodes. It's about:
1. Creating EXPRESSION nodes that represent "call result property access"
2. Connecting those EXPRESSION nodes to existing CALL_SITE nodes via DERIVES_FROM

This is similar to how MemberExpression assignments work (line 694-721):
```typescript
// const x = obj.prop; creates EXPRESSION(obj.prop) -> DERIVES_FROM -> obj
```

For destructuring from calls:
```typescript
// const { data } = fetchUser(); creates EXPRESSION(fetchUser().data) -> DERIVES_FROM -> CALL_SITE
```

The critical difference:
- REG-201: EXPRESSION derives from VARIABLE (simple identifier)
- REG-223: EXPRESSION derives from CALL_SITE (call result)

## High-Level Plan

### Step 1: Extend VariableAssignmentInfo Type
Add field to support call-based destructuring source:
```typescript
interface VariableAssignmentInfo {
  // Existing fields...
  objectSourceName?: string;  // For VARIABLE sources

  // NEW: For CALL_SITE sources
  callSourceLine?: number;
  callSourceColumn?: number;
  callSourceFile?: string;
  callSourceName?: string;  // function name for lookup
}
```

### Step 2: Modify trackDestructuringAssignment()
Remove early return at line 847-850. Instead:

```typescript
// Phase 1: Simple Identifier (existing logic)
if (t.isIdentifier(initNode)) {
  // ... existing code ...
}
// Phase 2: CallExpression or AwaitExpression (NEW)
else if (isCallOrAwaitExpression(initNode)) {
  const callInfo = extractCallInfo(initNode);
  // For each destructured variable, create VariableAssignmentInfo
  // with callSourceLine/callSourceColumn for DERIVES_FROM lookup
}
```

Helper functions:
- `unwrapAwaitExpression(node)` - recursively unwrap await
- `extractCallInfo(node)` - get line/column/name from CallExpression
- `createCallBasedAssignment(varInfo, callInfo, pattern)` - build assignment metadata

### Step 3: Extend GraphBuilder.createVariableAssignmentEdges()
In EXPRESSION node creation (lines 830-951), add branch:

```typescript
if (expressionType === 'MemberExpression' && objectSourceName) {
  // Existing: lookup VARIABLE by name
  const objectVar = variableDeclarations.find(v => v.name === objectSourceName && ...);
  if (objectVar) {
    this._bufferEdge({ type: 'DERIVES_FROM', src: sourceId, dst: objectVar.id });
  }
}
// NEW: Handle call-based source
else if (expressionType === 'MemberExpression' && callSourceLine && callSourceColumn) {
  // Lookup CALL_SITE by coordinates
  const callSite = callSites.find(cs =>
    cs.line === callSourceLine &&
    cs.column === callSourceColumn &&
    (callSourceName ? cs.name === callSourceName : true)
  );
  if (callSite) {
    this._bufferEdge({ type: 'DERIVES_FROM', src: sourceId, dst: callSite.id });
  }
}
```

### Step 4: Update ExpressionNode Metadata
Ensure `NodeFactory.createExpressionFromMetadata()` can represent:
- `object: "fetchUser()"` (display name for call result)
- `baseName: "fetchUser()"` (for path representation)
- Store call metadata for graph queries

### Step 5: Tests
Create `test/unit/DestructuringComplexInit.test.js`:
- `const { data } = await fetchUser()` → EXPRESSION → CALL_SITE
- `const { x } = getConfig()` → EXPRESSION → CALL_SITE
- `const [first] = arr.filter(fn)` → EXPRESSION → CALL (method)
- `const { x } = obj.getConfig()` → EXPRESSION → CALL (method)
- Nested: `const { user: { name } } = await fetchData()`
- Mixed: `const { items: [first] } = getResponse()`

## Risks

### 1. CALL_SITE Lookup Reliability
**Risk:** Line/column-based lookup might fail if:
- CallExpression coordinates don't match CALL_SITE coordinates
- Multiple calls on same line
- AwaitExpression changes reported position

**Mitigation:**
- Test with real-world code patterns
- Add function name to lookup criteria (disambiguate)
- Consider adding unique call IDs during AST traversal

### 2. EXPRESSION Node Representation
**Risk:** How to represent "fetchUser().data" in EXPRESSION node?
- `object: "fetchUser()"` looks odd (not a variable name)
- `baseName` field might confuse queries expecting variable names

**Mitigation:**
- Keep `object` field as call representation string
- Add `sourceType: 'CALL'` flag to EXPRESSION node metadata
- Document clearly in ExpressionNode contract

### 3. Graph Query Patterns
**Risk:** Existing queries might break:
- Queries that assume DERIVES_FROM always points to VARIABLE
- Value domain analysis expecting simple variable chains

**Mitigation:**
- Audit existing DERIVES_FROM queries in codebase
- Update ValueDomainAnalyzer if needed
- Add integration tests with value tracing

### 4. Nested Destructuring Edge Case
**Risk:** `const { user: { name } } = await fetchData()`
- Should create: `name` → EXPRESSION(fetchData().user.name) → CALL_SITE
- Need to preserve full property path through call result

**Mitigation:**
- Test nested patterns explicitly
- Ensure `propertyPath` field works with call sources

### 5. Method Call Ambiguity
**Risk:** `arr.filter(fn)` is a METHOD_CALL, not CALL_SITE
- Lookup logic needs to handle both `callSites` and `methodCalls` collections
- Different ID schemes, different node types

**Mitigation:**
- Pass both collections to GraphBuilder
- Try CALL_SITE first, fall back to METHOD_CALL
- Test method calls explicitly

## Success Criteria

✅ All acceptance criteria from Linear issue:
- `const { data } = await fetch()` creates ASSIGNED_FROM edge to EXPRESSION
- `const { x } = getConfig()` creates ASSIGNED_FROM edge to EXPRESSION
- `const [first] = arr.map(fn)` creates ASSIGNED_FROM edge to EXPRESSION
- Works with MemberExpression init: `const { x } = obj.getConfig()`
- All existing REG-201 tests still pass

✅ Graph correctness:
- EXPRESSION nodes created with proper metadata
- DERIVES_FROM edges point to correct CALL/CALL_SITE nodes
- No orphaned nodes or dangling edges

✅ Integration:
- Value domain analysis works through call-based destructuring
- Graph queries handle new edge patterns
- Performance impact negligible (<5% slowdown)

## Implementation Strategy

**Incremental approach:**
1. Start with simplest case: `const { x } = func()` (direct CallExpression)
2. Add AwaitExpression unwrapping
3. Add MemberExpression call support: `obj.method()`
4. Add nested destructuring
5. Add mixed patterns

**Each step:**
- Write test FIRST (TDD)
- Implement minimal change
- Run full test suite
- Commit atomically

**Estimated complexity:** Medium
- Builds directly on REG-201 patterns
- No new node types, only new edge connections
- Main challenge: coordinate-based CALL_SITE lookup reliability
