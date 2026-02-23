# Debug Report: REG-554 PROPERTY_ASSIGNMENT Nodes Not Created

**Date:** 2026-02-22

---

## Root Causes Found (3 distinct bugs)

### Bug 1: `propertyAssignments` not forwarded to `GraphBuilder.build()`

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location:** ~line 2252, the `graphBuilder.build()` call

**Problem:** The call to `this.graphBuilder.build(module, graph, projectPath, {...})` builds an explicit object listing every collection. All other dynamic collections (`variableReassignments`, `promiseResolutions`, `propertyAccesses`, etc.) were passed using `allCollections.X`, but `propertyAssignments` was omitted entirely.

The `VariableHandler` correctly populated `allCollections.propertyAssignments` during `analyzeFunctionBody`, and `CoreBuilder.buffer()` correctly consumed it — but the data never reached `CoreBuilder` because the explicit object passed to `graphBuilder.build()` did not include `propertyAssignments`.

**Fix:** Added `propertyAssignments: allCollections.propertyAssignments` to the object passed to `graphBuilder.build()`.

---

### Bug 2: ASSIGNED_FROM→PROPERTY_ACCESS lookup used wrong line/column

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location:** `extractMutationValue()` method, MEMBER_EXPRESSION case (~line 4627)

**Problem:** For a RHS like `options.graph`, `extractMutationValue` stored:
```
memberLine   = effectiveValue.loc?.start.line    // start of MemberExpression = column of 'o' in 'options'
memberColumn = effectiveValue.loc?.start.column  // same
```

But `PropertyAccessVisitor.extractChain()` records PROPERTY_ACCESS nodes with:
```
line   = current.property.loc.start.line    // location of the property identifier 'graph'
column = current.property.loc.start.column  // column of 'graph' (after 'options.')
```

The `bufferAssignedFromEdge` lookup compared `pa.line === memberLine && pa.column === memberColumn`, which always failed because the MemberExpression start (object location) differs from the property identifier location.

**Fix:** Changed `extractMutationValue` to store the **property's** location instead of the whole MemberExpression's start:
```typescript
valueInfo.memberLine   = effectiveValue.property.loc?.start.line;
valueInfo.memberColumn = effectiveValue.property.loc?.start.column;
```

---

### Bug 3: Semantic ID collision for same property name across different classes/methods

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Location:** `detectObjectPropertyAssignment()` method (~line 4311)

**Problem:** The semantic ID was generated as:
```typescript
computeSemanticIdV2('PROPERTY_ASSIGNMENT', 'this.x', file, scopeTracker.getNamedParent(), ...)
```

`scopeTracker.getNamedParent()` returns the innermost named scope — which is always `'constructor'` for any class constructor, regardless of which class. This produced identical IDs for `this.x` in class A's constructor vs class B's constructor, and for `this.x` in `constructor` vs `reset` of the same class.

The RFDB upsert semantics meant the second write overwrote the first, leaving only 1 node instead of 2.

**Fix:** Use a qualified parent combining `enclosingClassName` + `enclosingFunctionName`:
```typescript
const qualifiedParent = enclosingFunctionName
  ? `${enclosingClassName}.${enclosingFunctionName}`
  : enclosingClassName;
const discriminator = scopeTracker.getItemCounter(`PROPERTY_ASSIGNMENT:${qualifiedParent}.${fullName}`);
assignmentId = computeSemanticIdV2('PROPERTY_ASSIGNMENT', fullName, module.file, qualifiedParent, undefined, discriminator);
```

This produces:
- Class A constructor `this.x` → `index.js->PROPERTY_ASSIGNMENT->this.x[in:A.constructor]`
- Class B constructor `this.x` → `index.js->PROPERTY_ASSIGNMENT->this.x[in:B.constructor]`
- Foo constructor `this.x` → `index.js->PROPERTY_ASSIGNMENT->this.x[in:Foo.constructor]`
- Foo reset `this.x` → `index.js->PROPERTY_ASSIGNMENT->this.x[in:Foo.reset]`
- Same property twice in same method → `...[in:Foo.constructor]#1`

---

## Test Results After Fix

```
node --test test/unit/property-assignment.test.js
  tests  11
  pass   11
  fail   0
```

Full suite: 2315 pass, 4 fail — all 4 failures are pre-existing (unrelated to REG-554).

The 4 pre-existing failures confirmed by baseline check:
- `should create FLOWS_INTO edge for this.prop = value when class is in subdirectory`
- `should create FLOWS_INTO edges for multiple this.prop assignments in subdirectory class`
- `snapshot: 03-complex-async`
- `snapshot: 02-api-service`
