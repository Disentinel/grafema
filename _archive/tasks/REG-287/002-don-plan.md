# Don Melton - Tech Lead Analysis: REG-287

## 1. Current Architecture for BRANCH Tracking

**What exists:**

1. **BranchNode.ts** (`packages/core/src/core/nodes/BranchNode.ts`)
   - Already supports `branchType: 'switch' | 'if' | 'ternary'` (line 16)
   - Has both legacy ID and semantic ID creation methods
   - The type system is ALREADY prepared for ternary - just not implemented

2. **BranchInfo in types.ts** (`packages/core/src/plugins/analysis/ast/types.ts`)
   - Line 74: `branchType: 'switch' | 'if' | 'ternary'`
   - Ternary is already in the type union

3. **Cyclomatic Complexity Calculation** (`packages/core/src/plugins/analysis/JSASTAnalyzer.ts`)
   - Lines 3913-3917: `cyclomaticComplexity = 1 + branchCount + loopCount + caseCount + logicalOpCount`
   - `controlFlowState` tracks: `branchCount`, `loopCount`, `caseCount`, `logicalOpCount`
   - Ternaries currently do NOT increment `branchCount`

4. **ConditionalExpression Handling** - Currently tracked as:
   - EXPRESSION node (for data flow - lines 822-835)
   - NOT counted in cyclomatic complexity
   - NOT tracked as BRANCH

5. **Existing Patterns to Follow:**
   - `IfStatement` handler (line 2615+) - creates BRANCH, increments `branchCount`
   - `SwitchStatement` handler (line 2299+) - creates BRANCH, increments `branchCount`

## 2. Architecture Decision: Optional vs. Always-On

**The acceptance criteria says "Option to track ternary as BRANCH node"**

**Recommendation: Always track as BRANCH (Option B)**

Rationale:
1. Ternary IS a branch point - not tracking it is an omission
2. Academic McCabe complexity DOES count ternary
3. Adding config complexity for something that should be standard is technical debt
4. Tests can verify the behavior without needing config

If user MUST have a config option, we can add it later. Start with the correct default.

## 3. Where Changes Are Needed

**File 1: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`**

1. Add `ConditionalExpression` visitor in `analyzeFunctionBodyInternal()` (around line 3450)
   - Follow `IfStatement` handler pattern
   - Increment `controlFlowState.branchCount++`
   - Create BRANCH node with `branchType: 'ternary'`
   - Create HAS_CONDITION edge to test expression
   - Create HAS_CONSEQUENT/HAS_ALTERNATE edges to consequent/alternate expressions

**File 2: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`**

- Already handles BRANCH nodes (lines 176-181)
- May need to add HAS_CONSEQUENT/HAS_ALTERNATE edge buffering for ternary
- Could reuse existing pattern from if-branch handling

**File 3: `packages/core/src/plugins/analysis/ast/types.ts`**

- BranchInfo already supports `branchType: 'ternary'`
- May need to add optional fields for consequent/alternate expression IDs

## 4. Architectural Concerns

**Concern 1: Ternary vs If - Structural Difference**

- `if` has SCOPE bodies (BlockStatement)
- Ternary has EXPRESSION bodies (consequent/alternate are expressions, not blocks)

**Decision:** Create EXPRESSION nodes for consequent/alternate if they're complex, or track as metadata if simple. Follow existing ConditionalExpression EXPRESSION handling pattern.

**Concern 2: Nested Ternaries**

```javascript
const x = a ? (b ? 1 : 2) : 3;
```

Each ternary should create its own BRANCH node. The nesting is handled by semantic ID discriminator.

**Concern 3: Backward Compatibility**

- Cyclomatic complexity numbers WILL change
- This is correct - current numbers are wrong by academic standards
- Document this as intentional correction

**Concern 4: Edge Types**

For ternary branches, we need:
- `HAS_CONDITION` -> test expression
- `HAS_CONSEQUENT` -> consequent value/expression
- `HAS_ALTERNATE` -> alternate value/expression

These edge types already exist for if-statements.

## 5. Implementation Steps

| Step | Description | Files |
|------|-------------|-------|
| 1 | Write TDD tests for ternary BRANCH | `test/unit/plugins/analysis/ast/ternary-branch.test.ts` |
| 2 | Add ConditionalExpression visitor | `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` |
| 3 | Buffer ternary edges | `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` |
| 4 | Run tests, verify complexity | All test files |
| 5 | Update any affected test assertions | Various |

## 6. Critical Files

1. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Core logic
2. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Edge creation
3. `packages/core/src/core/nodes/BranchNode.ts` - Already supports ternary, reference
4. `test/unit/plugins/analysis/ast/if-statement-nodes.test.ts` - Pattern to follow
5. `packages/core/src/plugins/analysis/ast/types.ts` - BranchInfo already has ternary

## Bottom Line

The architecture is ALREADY prepared for ternary tracking. The BranchNode type union includes 'ternary', the BranchInfo interface supports it. This is a focused implementation task, not an architectural change. The main work is adding the ConditionalExpression visitor following the existing IfStatement pattern.
