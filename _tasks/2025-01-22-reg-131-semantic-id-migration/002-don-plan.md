# REG-131: Complete Semantic ID Migration for Class Methods and Arrow Functions

## Don Melton's Analysis

---

## Current State Analysis

### What Works (The Pattern to Follow)

**FunctionVisitor.ts** correctly implements semantic IDs for top-level functions:

```typescript
// Line 288-290 in FunctionVisitor.ts
const functionId = scopeTracker
  ? computeSemanticId('FUNCTION', node.id.name, scopeTracker.getContext())
  : legacyId;
```

This produces IDs like: `index.js->global->FUNCTION->processUser`

The key insight: **The semantic ID IS the primary ID**. The `functionId` variable gets the semantic ID directly when `scopeTracker` is available.

### What's Broken

**ClassVisitor.ts** generates a legacy ID as primary and stores semantic ID as a separate field:

```typescript
// Line 246 (ClassProperty with function)
const functionId = `FUNCTION#${className}.${propName}#${module.file}#${propNode.loc!.start.line}:${propNode.loc!.start.column}`;
const methodSemanticId = computeSemanticId('FUNCTION', propName, scopeTracker.getContext());
(functions as ClassFunctionInfo[]).push({
  id: functionId,           // LEGACY ID used as primary
  stableId: methodSemanticId,
  semanticId: methodSemanticId,
  ...
});

// Line 307 (ClassMethod) - same pattern
const functionId = `FUNCTION#${className}.${methodName}#${module.file}#${methodNode.loc!.start.line}:${methodNode.loc!.start.column}`;
```

This produces IDs like: `FUNCTION#UserService.getUser#/path/index.js#8:2`

### Also Broken: JSASTAnalyzer.analyzeFunctionBody()

Nested functions inside other functions also use legacy format:

```typescript
// Line 1654 (FunctionExpression inside function)
const functionId = `FUNCTION#${funcName}#${module.file}#${node.loc!.start.line}:${node.loc!.start.column}:${functionCounterRef.value++}`;

// Line 1708 (ArrowFunctionExpression inside function)
const functionId = `FUNCTION#${funcName}:${line}:${column}:${functionCounterRef.value++}`;
```

### Additional Locations Using Legacy Format

1. **JSASTAnalyzer.ts line 894** - AssignmentExpression handler (module-level function assignments)
2. **JSASTAnalyzer.ts line 964** - Module-level FunctionExpression callbacks

---

## Gap Analysis

### The Core Problem

The migration was half-done. `FunctionVisitor` was updated but `ClassVisitor` and `JSASTAnalyzer.analyzeFunctionBody()` still use the old pattern where:
1. Legacy ID is generated first
2. Semantic ID is computed but stored as a separate field
3. Legacy ID is used as the node's primary `id` field

### Expected Behavior

All FUNCTION nodes should use semantic ID as primary:
- Top-level: `index.js->global->FUNCTION->processUser` (WORKING)
- Class method: `index.js->UserService->FUNCTION->getUser` (BROKEN - uses legacy)
- Class property function: `index.js->MyClass->FUNCTION->handler` (BROKEN - uses legacy)
- Nested arrow: `index.js->outer->FUNCTION->inner` (BROKEN - uses legacy)
- Nested function: `index.js->parent->if#0->FUNCTION->callback` (BROKEN - uses legacy)

### Scope Hierarchy Issue

For class methods, the scope context at the time of method processing should show:
```
scopeTracker.getContext().scopePath = ['UserService']  // We're inside the class
```

Looking at ClassVisitor line 195:
```typescript
scopeTracker.enterScope(className, 'CLASS');
```

The class scope IS entered before processing methods. So `computeSemanticId('FUNCTION', methodName, scopeTracker.getContext())` should produce:
```
index.js->UserService->FUNCTION->methodName
```

The semantic ID IS being computed correctly - it's just not being used as the primary ID.

---

## High-Level Plan

### Phase 1: Fix ClassVisitor.ts (Critical Path)

**File:** `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`

**Changes:**

1. **Line 246 (ClassProperty functions):**
   ```typescript
   // BEFORE
   const functionId = `FUNCTION#${className}.${propName}#...`;
   const methodSemanticId = computeSemanticId('FUNCTION', propName, scopeTracker.getContext());

   // AFTER
   const functionId = computeSemanticId('FUNCTION', propName, scopeTracker.getContext());
   ```

2. **Line 252 - Update currentClass.methods.push:**
   ```typescript
   // Methods array should use semantic IDs too
   currentClass.methods.push(functionId);
   ```

3. **Line 254-268 - Update pushed function info:**
   ```typescript
   (functions as ClassFunctionInfo[]).push({
     id: functionId,
     stableId: functionId,  // stableId = id for semantic IDs
     // REMOVE: semanticId field (redundant when id IS semantic)
     ...
   });
   ```

4. **Line 307 (ClassMethod):** Same pattern as above

5. **Line 274, 347 - Scope IDs:** Also need semantic format

### Phase 2: Fix JSASTAnalyzer.analyzeFunctionBody()

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Changes in FunctionExpression handler (line 1651-1690):**
```typescript
// BEFORE
const functionId = `FUNCTION#${funcName}#...`;

// AFTER
const functionId = scopeTracker
  ? computeSemanticId('FUNCTION', funcName, scopeTracker.getContext())
  : `FUNCTION#${funcName}#${module.file}#${node.loc!.start.line}...`;
```

**Changes in ArrowFunctionExpression handler (line 1693-1748):**
```typescript
// BEFORE
const functionId = `FUNCTION#${funcName}:${line}:${column}:${functionCounterRef.value++}`;

// AFTER
const functionId = scopeTracker
  ? computeSemanticId('FUNCTION', funcName, scopeTracker.getContext())
  : `FUNCTION#${funcName}#...`;
```

### Phase 3: Fix Module-Level Assignments (JSASTAnalyzer)

**Line 894 (AssignmentExpression with function):**
```typescript
// Need to check if scopeTracker available and use semantic ID
const functionId = scopeTracker
  ? computeSemanticId('FUNCTION', functionName, scopeTracker.getContext())
  : legacyId;
```

**Line 964 (Module-level FunctionExpression callbacks):**
Same pattern.

### Phase 4: Clean Up Interface

The `ClassFunctionInfo` interface has `semanticId?: string` as a separate field. After migration:
- Remove `semanticId` field (redundant - `id` IS the semantic ID)
- Keep `stableId` equal to `id` for backward compatibility with consumers

---

## Risk Assessment

### What Could Break

1. **CONTAINS edges for class methods**
   - `currentClass.methods.push(functionId)` stores method IDs
   - GraphBuilder uses these to create CLASS -> FUNCTION edges
   - If we change method ID format, edges must still work
   - **Risk: LOW** - GraphBuilder uses IDs from the array, format doesn't matter

2. **Decorator targetId**
   - Decorators reference functions via `targetId`
   - Line 336: `extractDecoratorInfo(decorator, functionId, 'METHOD', module)`
   - **Risk: LOW** - targetId just needs to match the function ID

3. **Parent-child scope relationships**
   - `parentFunctionId` in scopes references function IDs
   - Line 285: `parentFunctionId: functionId`
   - **Risk: LOW** - As long as same ID used consistently

4. **External consumers expecting legacy format**
   - MCP tools, CLI, tests may pattern-match on IDs
   - **Risk: MEDIUM** - Need to verify tests don't hardcode legacy format

### Tests That Must Be Written First

1. **ClassMethod semantic ID test:**
   ```javascript
   it('class method should have semantic ID format', async () => {
     // class UserService { getUser() {} }
     // Expected: index.js->UserService->FUNCTION->getUser
   });
   ```

2. **ClassProperty function semantic ID test:**
   ```javascript
   it('class property function should have semantic ID format', async () => {
     // class Handler { process = () => {} }
     // Expected: index.js->Handler->FUNCTION->process
   });
   ```

3. **Nested function inside function test:**
   ```javascript
   it('nested function should have semantic ID with parent scope', async () => {
     // function outer() { function inner() {} }
     // Expected: index.js->outer->FUNCTION->inner
   });
   ```

4. **Arrow function inside function test:**
   ```javascript
   it('arrow function inside function should have semantic ID', async () => {
     // function parent() { const fn = () => {} }
     // Expected: index.js->parent->FUNCTION->fn
   });
   ```

---

## Alignment Check

### Does This Align With Project Vision?

**YES - Strongly aligned.**

From CLAUDE.md: "AI should query the graph, not read code."

Semantic IDs are essential for this vision:
- **Stable identifiers** - IDs don't change when unrelated code is edited
- **Human-readable** - `UserService->FUNCTION->getUser` tells you WHERE the function is
- **Query-friendly** - Can pattern match on scope hierarchy
- **Refactoring-safe** - Moving code doesn't break references

### Is This The Right Thing?

**YES - This is completing an incomplete migration.**

The pattern exists and works (FunctionVisitor). We're not inventing anything new - we're applying the established pattern consistently. This is exactly the kind of work that should be done: finish what was started.

### Are We Cutting Corners?

**NO - But we must be careful.**

The half-migration state is worse than either legacy-only or semantic-only. It creates confusion and inconsistency. This fix is necessary hygiene.

---

## Execution Sequence

1. **Write tests first** (Kent Beck)
   - Create `/test/unit/ClassMethodSemanticId.test.js`
   - Tests for ClassMethod, ClassProperty functions, nested functions, arrow functions

2. **Implement ClassVisitor changes** (Rob Pike)
   - Update ID generation at lines 246, 307
   - Remove redundant semanticId field usage
   - Verify methods array uses new IDs

3. **Implement JSASTAnalyzer.analyzeFunctionBody changes**
   - Update FunctionExpression handler
   - Update ArrowFunctionExpression handler

4. **Fix module-level function assignments**
   - Update lines 894, 964

5. **Run full test suite**
   - Verify all existing tests pass
   - Verify new tests pass

6. **Review** (Kevlin + Linus)
   - Check for consistency
   - Check for missed locations

---

## Critical Files for Implementation

- `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` - Primary fix location, lines 246 and 307 generate legacy function IDs
- `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Secondary fix location, analyzeFunctionBody() nested function handlers at lines 1654, 1708, 894, 964
- `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts` - Pattern to follow, shows correct semantic ID usage at lines 288-290
- `/Users/vadimr/grafema/packages/core/src/core/SemanticId.ts` - computeSemanticId function used for ID generation
- `/Users/vadimr/grafema/test/unit/FunctionNodeSemanticId.test.js` - Test pattern to follow for new tests
