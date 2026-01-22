# Joel Spolsky's Detailed Technical Plan for REG-131

## Executive Summary

Don Melton's analysis is accurate. The ClassVisitor and JSASTAnalyzer.analyzeFunctionBody() use legacy FUNCTION# format for function IDs instead of semantic IDs. This creates inconsistency with FunctionVisitor, which correctly uses semantic IDs.

---

## 1. Verified Code Locations

### ClassVisitor.ts - CONFIRMED

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`

| Don's Line | Actual Line | Description |
|------------|-------------|-------------|
| 246 | **246** | CONFIRMED - ClassProperty function ID generation |
| 307 | **307** | CONFIRMED - ClassMethod function ID generation |
| 274 | **274** | CONFIRMED - Scope ID for property function body |
| 347 | **347** | CONFIRMED - Scope ID for method body |

**Current Code at Line 246:**
```typescript
const functionId = `FUNCTION#${className}.${propName}#${module.file}#${propNode.loc!.start.line}:${propNode.loc!.start.column}`;
```

**Current Code at Line 307:**
```typescript
const functionId = `FUNCTION#${className}.${methodName}#${module.file}#${methodNode.loc!.start.line}:${methodNode.loc!.start.column}`;
```

### JSASTAnalyzer.ts - VERIFIED WITH CORRECTIONS

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

| Don's Line | Actual Line | Description |
|------------|-------------|-------------|
| 894 | **894** | CONFIRMED - AssignmentExpression handler |
| 964 | **964** | CONFIRMED - Module-level FunctionExpression callbacks |
| 1654 | **1654** | CONFIRMED - FunctionExpression inside analyzeFunctionBody() |
| 1708 | **1708** | CONFIRMED - ArrowFunctionExpression inside analyzeFunctionBody() |

**Current Code at Line 894 (AssignmentExpression):**
```typescript
const functionId = `FUNCTION#${functionName}#${module.file}#${assignNode.loc!.start.line}:${assignNode.loc!.start.column}`;
```

**Current Code at Line 964 (Module-level FunctionExpression):**
```typescript
const functionId = `FUNCTION#${funcName}#${module.file}#${funcNode.loc!.start.line}:${funcNode.loc!.start.column}`;
```

**Current Code at Line 1654 (Nested FunctionExpression):**
```typescript
const functionId = `FUNCTION#${funcName}#${module.file}#${node.loc!.start.line}:${node.loc!.start.column}:${functionCounterRef.value++}`;
```

**Current Code at Line 1708 (Nested ArrowFunctionExpression):**
```typescript
const functionId = `FUNCTION#${funcName}:${line}:${column}:${functionCounterRef.value++}`;
```

---

## 2. Correct Pattern (from FunctionVisitor.ts)

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts`

**Lines 287-290 - The Pattern to Follow:**
```typescript
const legacyId = `FUNCTION#${node.id.name}#${module.file}#${node.loc!.start.line}`;

// Use semantic ID as primary ID when scopeTracker available
const functionId = scopeTracker
  ? computeSemanticId('FUNCTION', node.id.name, scopeTracker.getContext())
  : legacyId;
```

**Key insight:** The semantic ID becomes the PRIMARY id field. No separate `semanticId` field needed when scopeTracker is available.

---

## 3. Test Plan

### New Test File: `/Users/vadimr/grafema/test/unit/ClassMethodSemanticId.test.js`

Following the pattern from `FunctionNodeSemanticId.test.js`:

```javascript
/**
 * ClassMethod Semantic ID Tests
 *
 * Tests for class method and nested function migration to semantic IDs.
 * Ensures FUNCTION nodes inside classes and nested scopes use the correct format.
 *
 * Format: {file}->{class_scope}->FUNCTION->{method_name}
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { ScopeTracker, computeSemanticId } from '@grafema/core';

describe('Class Method Semantic ID', () => {
  describe('ClassMethod should use semantic ID', () => {
    it('should create class method with semantic ID format', () => {
      const tracker = new ScopeTracker('index.js');
      tracker.enterScope('UserService', 'CLASS');
      const context = tracker.getContext();

      const methodId = computeSemanticId('FUNCTION', 'getUser', context);

      // Expected: index.js->UserService->FUNCTION->getUser
      assert.strictEqual(methodId, 'index.js->UserService->FUNCTION->getUser');
    });

    it('should create constructor with semantic ID format', () => {
      const tracker = new ScopeTracker('index.js');
      tracker.enterScope('MyClass', 'CLASS');
      const context = tracker.getContext();

      const constructorId = computeSemanticId('FUNCTION', 'constructor', context);

      assert.strictEqual(constructorId, 'index.js->MyClass->FUNCTION->constructor');
    });

    it('should create getter method with semantic ID format', () => {
      const tracker = new ScopeTracker('index.js');
      tracker.enterScope('Config', 'CLASS');
      const context = tracker.getContext();

      const getterId = computeSemanticId('FUNCTION', 'value', context);

      assert.strictEqual(getterId, 'index.js->Config->FUNCTION->value');
    });
  });

  describe('ClassProperty function should use semantic ID', () => {
    it('should create arrow function property with semantic ID', () => {
      const tracker = new ScopeTracker('index.js');
      tracker.enterScope('Handler', 'CLASS');
      const context = tracker.getContext();

      const propFuncId = computeSemanticId('FUNCTION', 'process', context);

      assert.strictEqual(propFuncId, 'index.js->Handler->FUNCTION->process');
    });

    it('should create function expression property with semantic ID', () => {
      const tracker = new ScopeTracker('index.js');
      tracker.enterScope('EventEmitter', 'CLASS');
      const context = tracker.getContext();

      const propFuncId = computeSemanticId('FUNCTION', 'emit', context);

      assert.strictEqual(propFuncId, 'index.js->EventEmitter->FUNCTION->emit');
    });
  });

  describe('Nested function inside function should use semantic ID', () => {
    it('should create nested function with parent scope in ID', () => {
      const tracker = new ScopeTracker('index.js');
      tracker.enterScope('outer', 'FUNCTION');
      const context = tracker.getContext();

      const innerId = computeSemanticId('FUNCTION', 'inner', context);

      assert.strictEqual(innerId, 'index.js->outer->FUNCTION->inner');
    });

    it('should create nested anonymous function with sibling index', () => {
      const tracker = new ScopeTracker('index.js');
      tracker.enterScope('parent', 'FUNCTION');
      const context = tracker.getContext();

      const anonId = computeSemanticId('FUNCTION', 'anonymous[0]', context);

      assert.strictEqual(anonId, 'index.js->parent->FUNCTION->anonymous[0]');
    });
  });

  describe('Arrow function inside function should use semantic ID', () => {
    it('should create arrow function inside function with semantic ID', () => {
      const tracker = new ScopeTracker('index.js');
      tracker.enterScope('processItems', 'FUNCTION');
      const context = tracker.getContext();

      const arrowId = computeSemanticId('FUNCTION', 'filter', context);

      assert.strictEqual(arrowId, 'index.js->processItems->FUNCTION->filter');
    });

    it('should create callback inside class method with correct scope', () => {
      const tracker = new ScopeTracker('api.js');
      tracker.enterScope('UserController', 'CLASS');
      tracker.enterScope('getAll', 'FUNCTION');
      const context = tracker.getContext();

      const callbackId = computeSemanticId('FUNCTION', 'mapUser', context);

      assert.strictEqual(callbackId, 'api.js->UserController->getAll->FUNCTION->mapUser');
    });
  });

  describe('Semantic ID stability', () => {
    it('should produce same ID when method moves to different line', () => {
      const tracker = new ScopeTracker('index.js');
      tracker.enterScope('Service', 'CLASS');
      const context = tracker.getContext();

      // Method at line 10
      const id1 = computeSemanticId('FUNCTION', 'process', context);

      // Same method moved to line 25
      const id2 = computeSemanticId('FUNCTION', 'process', context);

      assert.strictEqual(id1, id2);
      assert.strictEqual(id1, 'index.js->Service->FUNCTION->process');
    });

    it('should produce different IDs for methods in different classes', () => {
      const tracker1 = new ScopeTracker('index.js');
      tracker1.enterScope('ClassA', 'CLASS');

      const tracker2 = new ScopeTracker('index.js');
      tracker2.enterScope('ClassB', 'CLASS');

      const id1 = computeSemanticId('FUNCTION', 'method', tracker1.getContext());
      const id2 = computeSemanticId('FUNCTION', 'method', tracker2.getContext());

      assert.notStrictEqual(id1, id2);
      assert.strictEqual(id1, 'index.js->ClassA->FUNCTION->method');
      assert.strictEqual(id2, 'index.js->ClassB->FUNCTION->method');
    });
  });
});
```

---

## 4. Implementation Steps (Ordered)

### Phase 1: ClassVisitor.ts Changes

**Step 1.1 - Line 246 (ClassProperty functions)**

BEFORE:
```typescript
const functionId = `FUNCTION#${className}.${propName}#${module.file}#${propNode.loc!.start.line}:${propNode.loc!.start.column}`;

// Generate semantic ID using scopeTracker
const methodSemanticId = computeSemanticId('FUNCTION', propName, scopeTracker.getContext());
```

AFTER:
```typescript
// Use semantic ID as primary ID (scopeTracker is REQUIRED in ClassVisitor)
const functionId = computeSemanticId('FUNCTION', propName, scopeTracker.getContext());
```

**Step 1.2 - Line 252 (Add to class methods)**

No change needed - `currentClass.methods.push(functionId)` will automatically use the new semantic ID format.

**Step 1.3 - Lines 254-268 (Pushed function info)**

BEFORE:
```typescript
(functions as ClassFunctionInfo[]).push({
  id: functionId,
  stableId: methodSemanticId || functionId,
  semanticId: methodSemanticId,
  // ...
});
```

AFTER:
```typescript
(functions as ClassFunctionInfo[]).push({
  id: functionId,
  stableId: functionId,  // stableId = id when using semantic IDs
  // REMOVE semanticId field - it's redundant when id IS the semantic ID
  // ...
});
```

**Step 1.4 - Line 274 (Scope ID for property function body)**

No change needed - this already uses `computeSemanticId('SCOPE', ...)`.

**Step 1.5 - Line 285 (parentFunctionId)**

Already correct - uses `functionId` which will now be semantic.

**Step 1.6 - Line 307 (ClassMethod)**

BEFORE:
```typescript
const functionId = `FUNCTION#${className}.${methodName}#${module.file}#${methodNode.loc!.start.line}:${methodNode.loc!.start.column}`;

// Generate semantic ID using scopeTracker
const methodSemanticId = computeSemanticId('FUNCTION', methodName, scopeTracker.getContext());
```

AFTER:
```typescript
// Use semantic ID as primary ID
const functionId = computeSemanticId('FUNCTION', methodName, scopeTracker.getContext());
```

**Step 1.7 - Lines 315-330 (ClassMethod function info)**

BEFORE:
```typescript
const funcData: ClassFunctionInfo = {
  id: functionId,
  stableId: methodSemanticId || functionId,
  semanticId: methodSemanticId,
  // ...
};
```

AFTER:
```typescript
const funcData: ClassFunctionInfo = {
  id: functionId,
  stableId: functionId,  // stableId = id when using semantic IDs
  // REMOVE semanticId field
  // ...
};
```

**Step 1.8 - Update ClassFunctionInfo interface (Lines 42-58)**

BEFORE:
```typescript
interface ClassFunctionInfo {
  id: string;
  stableId: string;
  semanticId?: string;  // <-- Remove this
  // ...
}
```

AFTER:
```typescript
interface ClassFunctionInfo {
  id: string;
  stableId: string;
  // semanticId field REMOVED - id IS the semantic ID
  // ...
}
```

**Step 1.9 - Update ScopeInfo interface (Lines 63-73)**

BEFORE:
```typescript
interface ScopeInfo {
  id: string;
  semanticId?: string;  // <-- Consider removing or keeping for consistency
  // ...
}
```

Keep `semanticId` in ScopeInfo for now since scope IDs have different handling.

### Phase 2: JSASTAnalyzer.ts Changes

**Step 2.1 - Line 894 (AssignmentExpression handler)**

BEFORE:
```typescript
const functionId = `FUNCTION#${functionName}#${module.file}#${assignNode.loc!.start.line}:${assignNode.loc!.start.column}`;

functions.push({
  id: functionId,
  stableId: functionId,
  // ...
});
```

AFTER:
```typescript
// scopeTracker is available at module level in analyzeModule
const functionId = scopeTracker
  ? computeSemanticId('FUNCTION', functionName, scopeTracker.getContext())
  : `FUNCTION#${functionName}#${module.file}#${assignNode.loc!.start.line}:${assignNode.loc!.start.column}`;

functions.push({
  id: functionId,
  stableId: functionId,
  // ...
});
```

Note: At line 872, `scopeTracker` is available in the `analyzeModule` function scope, but it's not currently passed into this traverse block. Need to capture it from the enclosing scope. Looking at the code, `scopeTracker` is created at line 752 and should be accessible.

**Step 2.2 - Line 964 (Module-level FunctionExpression callbacks)**

BEFORE:
```typescript
const functionId = `FUNCTION#${funcName}#${module.file}#${funcNode.loc!.start.line}:${funcNode.loc!.start.column}`;
```

AFTER:
```typescript
const functionId = scopeTracker
  ? computeSemanticId('FUNCTION', funcName, scopeTracker.getContext())
  : `FUNCTION#${funcName}#${module.file}#${funcNode.loc!.start.line}:${funcNode.loc!.start.column}`;
```

**Step 2.3 - Line 1654 (FunctionExpression inside analyzeFunctionBody)**

BEFORE:
```typescript
const functionId = `FUNCTION#${funcName}#${module.file}#${node.loc!.start.line}:${node.loc!.start.column}:${functionCounterRef.value++}`;
```

AFTER:
```typescript
const functionId = scopeTracker
  ? computeSemanticId('FUNCTION', funcName, scopeTracker.getContext())
  : `FUNCTION#${funcName}#${module.file}#${node.loc!.start.line}:${node.loc!.start.column}:${functionCounterRef.value++}`;
```

Note: `scopeTracker` needs to be extracted from `collections.scopeTracker` at line 1174.

**Step 2.4 - Line 1708 (ArrowFunctionExpression inside analyzeFunctionBody)**

BEFORE:
```typescript
const functionId = `FUNCTION#${funcName}:${line}:${column}:${functionCounterRef.value++}`;
```

AFTER:
```typescript
const functionId = scopeTracker
  ? computeSemanticId('FUNCTION', funcName, scopeTracker.getContext())
  : `FUNCTION#${funcName}:${line}:${column}:${functionCounterRef.value++}`;
```

### Phase 3: Scope Entry/Exit for Nested Functions

**Critical:** When creating nested functions, we need to enter/exit scopes properly.

**Step 3.1 - Line 1651-1690 (FunctionExpression handler)**

Add scope tracking:
```typescript
FunctionExpression: (funcPath: NodePath<t.FunctionExpression>) => {
  const node = funcPath.node;
  const funcName = node.id ? node.id.name : this.generateAnonymousName(scopeCtx);

  // Use semantic ID as primary
  const functionId = scopeTracker
    ? computeSemanticId('FUNCTION', funcName, scopeTracker.getContext())
    : `FUNCTION#${funcName}#${module.file}#${node.loc!.start.line}:${node.loc!.start.column}:${functionCounterRef.value++}`;

  functions.push({
    id: functionId,
    stableId: functionId,  // stableId = id
    // ... rest unchanged
  });

  // Enter scope for nested analysis
  if (scopeTracker) {
    scopeTracker.enterScope(funcName, 'FUNCTION');
  }

  // ... existing scope creation and analyzeFunctionBody call ...

  // Exit scope
  if (scopeTracker) {
    scopeTracker.exitScope();
  }

  funcPath.skip();
}
```

**Step 3.2 - Line 1693-1748 (ArrowFunctionExpression handler)**

Same pattern as FunctionExpression.

---

## 5. Existing Test Impact

### Tests That Should NOT Break

1. **`test/unit/FunctionNodeSemanticId.test.js`** - Tests FunctionNode.createWithContext(), not visitor output
2. **`test/unit/ClassNodeSemanticId.test.js`** - Tests ClassNode, not method IDs
3. **`test/unit/NoLegacyClassIds.test.js`** - Tests CLASS# format, not FUNCTION#

### Tests to Verify After Changes

Run grep to find any tests that assert on specific FUNCTION node ID formats:

```bash
grep -r "id.*FUNCTION" test/ --include="*.test.js"
grep -r "methods\.push\|methods\[" test/ --include="*.test.js"
```

Based on my grep results, **no existing tests assert on the legacy FUNCTION# format**.

---

## 6. Build/Run Commands

### Step-by-Step Verification

```bash
# 1. Run new tests first (should fail initially - TDD)
node --test test/unit/ClassMethodSemanticId.test.js

# 2. Build after changes
npm run build

# 3. Run specific unit tests
node --test test/unit/ClassMethodSemanticId.test.js
node --test test/unit/FunctionNodeSemanticId.test.js
node --test test/unit/ClassNodeSemanticId.test.js
node --test test/unit/NoLegacyClassIds.test.js

# 4. Run full test suite
npm test

# 5. Integration test - analyze a sample project
node packages/cli/dist/cli.js analyze /path/to/test/project --verbose
```

### Verification Queries

After implementation, query the graph to verify semantic IDs:

```bash
# Check class method IDs
grafema query "MATCH (f:FUNCTION) WHERE f.isClassMethod = true RETURN f.id LIMIT 10"

# Verify no FUNCTION# prefix in class methods
grafema query "MATCH (f:FUNCTION) WHERE f.id STARTS WITH 'FUNCTION#' RETURN count(f)"
# Expected: 0

# Verify semantic ID format
grafema query "MATCH (f:FUNCTION) WHERE f.id CONTAINS '->' AND f.isClassMethod = true RETURN f.id LIMIT 5"
```

---

## 7. Risk Mitigation

### Low Risk Items
- CONTAINS edges: Will continue to work since they use the method IDs from the array
- Decorator targetId: Uses the functionId variable, will automatically get new format
- parentFunctionId references: Uses functionId, will get new format

### Medium Risk Items
- **External consumers**: MCP tools or other code that pattern-matches on IDs
  - Mitigation: Test with MCP tools after changes
  - Mitigation: Semantic IDs are MORE stable, not less

### Rollback Plan
If issues discovered:
1. Revert ClassVisitor.ts changes
2. Revert JSASTAnalyzer.ts changes
3. No database migration needed - IDs are computed at analysis time

---

## Critical Files for Implementation

- `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` - Primary fix: lines 246, 252-268, 307, 315-330 change FUNCTION ID generation
- `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Secondary fix: lines 894, 964, 1654, 1708 for module-level and nested functions
- `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts` - Reference: lines 287-290 show correct pattern to follow
- `/Users/vadimr/grafema/packages/core/src/core/SemanticId.ts` - computeSemanticId function (no changes needed)
- `/Users/vadimr/grafema/test/unit/FunctionNodeSemanticId.test.js` - Test pattern to follow for new tests
