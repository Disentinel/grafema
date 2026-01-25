# Joel Spolsky - Detailed Implementation Plan

## REG-153: Use Semantic IDs for PARAMETER Nodes

---

## Executive Summary

This plan details exact code changes to migrate PARAMETER node IDs from legacy format (`PARAMETER#name#file#line:index`) to semantic format (`file->scope->PARAMETER->name#index`).

**Key insight:** There are TWO code paths and THREE places creating PARAMETER nodes:
1. `FunctionVisitor.ts` - local `createParameterNodes` (lines 218-275) - legacy IDs
2. `createParameterNodes.ts` - shared utility (lines 34-91) - legacy IDs
3. `ASTWorker.ts` - parallel path (lines 419-432) - **already uses semantic IDs**

The parallel path is correct. We need to align the sequential path.

---

## Files to Modify

| File | Lines | Change |
|------|-------|--------|
| `packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts` | 34-91 | Add `ScopeTracker` parameter, generate semantic IDs |
| `packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts` | 218-275 | Remove local duplicate, use shared utility |
| `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` | 273-275, 348-351 | Pass `scopeTracker` to shared utility |
| `test/unit/Parameter.test.js` | - | Add semantic ID format assertion |

---

## Step-by-Step Implementation

### Step 1: Update Shared Utility (`createParameterNodes.ts`)

**File:** `/Users/vadimr/grafema-worker-6/packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts`

#### 1.1 Add imports (after line 14)

```typescript
import { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
```

#### 1.2 Update function signature (lines 34-40)

**Current:**
```typescript
export function createParameterNodes(
  params: Node[],
  functionId: string,
  file: string,
  line: number,
  parameters: ParameterInfo[]
): void {
```

**New:**
```typescript
export function createParameterNodes(
  params: Node[],
  functionId: string,
  file: string,
  line: number,
  parameters: ParameterInfo[],
  scopeTracker?: ScopeTracker
): void {
```

#### 1.3 Add helper function for semantic ID generation (after line 41)

```typescript
  // Helper to generate parameter ID (semantic or legacy)
  const generateParamId = (name: string, index: number): string => {
    if (scopeTracker) {
      return computeSemanticId('PARAMETER', name, scopeTracker.getContext(), { discriminator: index });
    }
    return `PARAMETER#${name}#${file}#${line}:${index}`;
  };
```

#### 1.4 Replace all paramId assignments (3 places)

**Location 1 - Identifier (line 46):**
```typescript
// Current:
const paramId = `PARAMETER#${(param as Identifier).name}#${file}#${line}:${index}`;

// New:
const paramId = generateParamId((param as Identifier).name, index);
```

**Location 2 - AssignmentPattern (line 60):**
```typescript
// Current:
const paramId = `PARAMETER#${assignmentParam.left.name}#${file}#${line}:${index}`;

// New:
const paramId = generateParamId(assignmentParam.left.name, index);
```

**Location 3 - RestElement (line 76):**
```typescript
// Current:
const paramId = `PARAMETER#${restParam.argument.name}#${file}#${line}:${index}`;

// New:
const paramId = generateParamId(restParam.argument.name, index);
```

#### 1.5 Add semanticId field to ParameterInfo (all 3 push calls)

For each `parameters.push({...})`, add:
```typescript
semanticId: scopeTracker ? paramId : undefined,
```

---

### Step 2: Remove Duplicate in FunctionVisitor

**File:** `/Users/vadimr/grafema-worker-6/packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts`

#### 2.1 Add import for shared utility (after line 24)

```typescript
import { createParameterNodes } from '../utils/createParameterNodes.js';
```

#### 2.2 Remove local createParameterNodes function (lines 218-275)

Delete the entire local function:
```typescript
    // Helper function to create PARAMETER nodes for function params
    const createParameterNodes = (
      params: Node[],
      functionId: string,
      file: string,
      line: number
    ): void => {
      // ... entire function body (57 lines)
    };
```

#### 2.3 Update FunctionDeclaration call site (line 311)

**Current:**
```typescript
createParameterNodes(node.params, functionId, module.file, node.loc!.start.line);
```

**New (pass scopeTracker):**
```typescript
createParameterNodes(node.params, functionId, module.file, node.loc!.start.line, parameters as ParameterInfo[], scopeTracker);
```

**Note:** Also need to import `ParameterInfo` type:
```typescript
import type { ParameterInfo } from '../types.js';
```

#### 2.4 Update ArrowFunctionExpression call site (line 389)

**Current:**
```typescript
createParameterNodes(node.params, functionId, module.file, line);
```

**New:**
```typescript
createParameterNodes(node.params, functionId, module.file, line, parameters as ParameterInfo[], scopeTracker);
```

---

### Step 3: Update ClassVisitor Call Sites

**File:** `/Users/vadimr/grafema-worker-6/packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`

ClassVisitor already imports `createParameterNodes` and has `scopeTracker` as a required parameter.

#### 3.1 Update ClassProperty call site (line 274)

**Current:**
```typescript
createParameterNodes(funcNode.params, functionId, module.file, propNode.loc!.start.line, parameters as ParameterInfo[]);
```

**New:**
```typescript
createParameterNodes(funcNode.params, functionId, module.file, propNode.loc!.start.line, parameters as ParameterInfo[], scopeTracker);
```

#### 3.2 Update ClassMethod call site (line 350)

**Current:**
```typescript
createParameterNodes(methodNode.params, functionId, module.file, methodNode.loc!.start.line, parameters as ParameterInfo[]);
```

**New:**
```typescript
createParameterNodes(methodNode.params, functionId, module.file, methodNode.loc!.start.line, parameters as ParameterInfo[], scopeTracker);
```

---

### Step 4: Update Tests

**File:** `/Users/vadimr/grafema-worker-6/test/unit/Parameter.test.js`

#### 4.1 Add test for semantic ID format

Add after line 68 (end of first `it` block):

```javascript
    it('should use semantic ID format for PARAMETER nodes', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find the 'name' parameter from greet function
      const nameParams = [];
      for await (const node of backend.queryNodes({ type: 'PARAMETER', name: 'name' })) {
        nameParams.push(node);
      }

      assert.ok(nameParams.length >= 1, 'Should have "name" parameter');

      // Verify semantic ID format: file->scope->PARAMETER->name#discriminator
      const paramId = nameParams[0].id;

      // Semantic ID should contain '->' separator
      assert.ok(paramId.includes('->'), `Parameter ID should be semantic format, got: ${paramId}`);

      // Should NOT be legacy format (PARAMETER#name#file#line:index)
      assert.ok(!paramId.startsWith('PARAMETER#'), `Parameter ID should not use legacy format, got: ${paramId}`);

      // Should contain PARAMETER type
      assert.ok(paramId.includes('->PARAMETER->'), `Parameter ID should contain ->PARAMETER->, got: ${paramId}`);
    });
```

---

## Semantic ID Format Reference

### Current Legacy Format
```
PARAMETER#userId#src/auth.js#42:0
```

Components: `TYPE#name#file#line:index`

### New Semantic Format
```
src/auth.js->login->PARAMETER->userId#0
```

Components: `file->scope->TYPE->name#discriminator`

The semantic format is stable across:
- Adding/removing comments
- Adding/removing blank lines
- Reordering unrelated code

---

## Edge Cases

### 1. Anonymous Functions
Anonymous functions use generated names like `anonymous[0]`, `anonymous[1]`.
Parameter semantic IDs will be:
```
src/app.js->anonymous[0]->PARAMETER->x#0
```

### 2. Nested Functions
Functions inside functions maintain full scope path:
```
src/app.js->outer->inner->PARAMETER->x#0
```

### 3. Class Methods
Class methods include class in scope:
```
src/app.js->UserService->login->PARAMETER->userId#0
```

### 4. Default Parameters
Same format, but ParameterInfo also has `hasDefault: true`:
```
src/app.js->greet->PARAMETER->greeting#1
```

### 5. Rest Parameters
Same format, but ParameterInfo also has `isRest: true`:
```
src/app.js->sum->PARAMETER->numbers#0
```

---

## Verification Steps

1. **Unit Tests:**
   ```bash
   node --test test/unit/Parameter.test.js
   ```

2. **Full Test Suite:**
   ```bash
   npm test
   ```

3. **Manual Verification:**
   ```bash
   # Analyze a test fixture
   grafema analyze test/fixtures/parameters --output test-output.json

   # Check parameter IDs in output
   grep "PARAMETER" test-output.json | head -5
   ```

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Tests expecting legacy IDs | Medium | Tests use `attr(X, "name", "foo")`, not ID parsing |
| Saved graphs incompatible | Low | Expected one-time migration cost |
| FunctionVisitor scopeTracker is optional | Medium | Pass `undefined` when not available (fallback to legacy) |

---

## Summary of Changes

| File | Lines Changed | Description |
|------|---------------|-------------|
| `createParameterNodes.ts` | ~15 | Add scopeTracker param, generate semantic IDs |
| `FunctionVisitor.ts` | -57, +5 | Remove duplicate, use shared utility |
| `ClassVisitor.ts` | +2 | Pass scopeTracker to utility |
| `Parameter.test.js` | +20 | Add semantic ID format test |

**Total estimated:** 4 files, ~80 lines changed (net reduction due to removing duplicate)

---

## Order of Operations

1. **Kent Beck:** Write failing test for semantic ID format
2. **Rob Pike:** Update `createParameterNodes.ts` (add scopeTracker, generate semantic IDs)
3. **Rob Pike:** Update `ClassVisitor.ts` call sites (pass scopeTracker)
4. **Rob Pike:** Update `FunctionVisitor.ts` (remove duplicate, use shared utility, pass scopeTracker)
5. **Rob Pike:** Run tests, verify all pass
6. **Kevlin Henney:** Code review (style, readability)
7. **Linus Torvalds:** Architecture review (alignment with vision)
