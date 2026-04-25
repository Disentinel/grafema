# Joel Spolsky - Technical Specification: REG-287

## Summary

Track `ConditionalExpression` (ternary operator `? :`) as BRANCH nodes with `branchType: 'ternary'`. This will:
1. Create BRANCH nodes for ternary expressions
2. Increment `branchCount` for cyclomatic complexity calculation
3. Create HAS_CONDITION, HAS_CONSEQUENT, HAS_ALTERNATE edges

## Architecture Compatibility

Don's analysis confirms the type system is ALREADY prepared:
- `BranchInfo.branchType` includes `'ternary'` (types.ts:74)
- `BranchNode` supports `'ternary'` (BranchNode.ts:16)
- Edge types HAS_CONDITION/HAS_CONSEQUENT/HAS_ALTERNATE exist

Key difference from IfStatement: ternary has EXPRESSIONS as branches, not SCOPE blocks.

---

## 1. Test Cases (TDD - Write First)

**File**: `test/unit/plugins/analysis/ast/ternary-branch.test.ts`

**Test Groups**:

1. **Basic ternary creates BRANCH node**
   - `const x = a ? 1 : 2;` - should create BRANCH with branchType='ternary'
   - BRANCH should have file, line, parentScopeId

2. **HAS_CONDITION edge**
   - Ternary condition should have HAS_CONDITION edge from BRANCH to condition EXPRESSION

3. **HAS_CONSEQUENT/HAS_ALTERNATE edges**
   - Should create HAS_CONSEQUENT edge from BRANCH to consequent EXPRESSION
   - Should create HAS_ALTERNATE edge from BRANCH to alternate EXPRESSION

4. **Cyclomatic complexity**
   - Single ternary should increment complexity by 1
   - Function with `const x = a ? 1 : 2;` should have complexity 2 (1 base + 1 ternary)

5. **Nested ternary**
   - `const x = a ? (b ? 1 : 2) : 3;` should create 2 BRANCH nodes
   - Each should have unique IDs with discriminators

6. **Ternary in different contexts**
   - In return statement: `return a ? 1 : 2;`
   - In assignment: `x = a ? 1 : 2;`
   - In function argument: `foo(a ? 1 : 2);`

---

## 2. Implementation Steps

### Step 2.1: Add ConditionalExpression visitor handler

**File**: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location**: After IfStatement handler (around line 3784), add ConditionalExpression visitor

**New method**: `createConditionalExpressionHandler` (around line 2760)

### Step 2.2: Extend BranchInfo type

**File**: `packages/core/src/plugins/analysis/ast/types.ts`

**Location**: Line 70-85 (BranchInfo interface)

**Add fields**:
```typescript
consequentExpressionId?: string;  // ID of consequent expression (for ternary)
alternateExpressionId?: string;   // ID of alternate expression (for ternary)
```

### Step 2.3: Update GraphBuilder.bufferBranchEdges

**File**: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Location**: `bufferBranchEdges` method (line 531-604)

**Add ternary edge handling** after the if-branch handling.

---

## 3. Key Code Locations

| Change | File | Line | Description |
|--------|------|------|-------------|
| Add ConditionalExpression visitor | JSASTAnalyzer.ts | ~3784 | After IfStatement handler |
| Add handler method | JSASTAnalyzer.ts | ~2760 | New `createConditionalExpressionHandler` |
| Extend BranchInfo | types.ts | 70-85 | Add expression IDs |
| Buffer ternary edges | GraphBuilder.ts | ~604 | After if-branch handling |

---

## 4. Expected Behavior After Implementation

1. **Graph structure**: Ternary `a ? b : c` produces:
   - BRANCH node (branchType='ternary')
   - HAS_CONDITION edge to condition expression
   - HAS_CONSEQUENT edge to consequent expression
   - HAS_ALTERNATE edge to alternate expression

2. **Cyclomatic complexity**: Each ternary adds +1 to branchCount

3. **Semantic ID format**: `{file}->{scope_path}->BRANCH->ternary#N`

4. **Nested ternaries**: Each creates separate BRANCH with unique discriminator

---

## 5. Critical Files

- `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Core logic
- `packages/core/src/plugins/analysis/ast/types.ts` - Extend BranchInfo
- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Buffer edges
- `test/unit/plugins/analysis/ast/if-statement-nodes.test.ts` - Pattern to follow
