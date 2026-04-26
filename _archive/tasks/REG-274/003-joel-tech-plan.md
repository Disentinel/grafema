# Technical Plan: REG-274 - BRANCH Node for IfStatement

## Implementation Details

### 1. Type Definitions

#### Add BRANCH to NODE_TYPE (`packages/types/src/nodes.ts`)
```typescript
BRANCH: 'BRANCH',
```

#### Add BranchNodeRecord interface
```typescript
export interface BranchNodeRecord extends BaseNodeRecord {
  type: 'BRANCH';
  branchType: 'if' | 'switch' | 'ternary';
  condition?: string;
  constraints?: Constraint[];
  hasAlternate?: boolean;
}
```

#### Add edge types (`packages/types/src/edges.ts`)
```typescript
HAS_CONDITION: 'HAS_CONDITION',
HAS_CONSEQUENT: 'HAS_CONSEQUENT',
HAS_ALTERNATE: 'HAS_ALTERNATE',
```

### 2. AST Types (`packages/core/src/plugins/analysis/ast/types.ts`)

#### BranchInfo interface
```typescript
export interface BranchInfo {
  id: string;
  semanticId?: string;
  type: 'BRANCH';
  branchType: 'if' | 'switch' | 'ternary';
  name: string;
  file: string;
  line: number;
  column?: number;
  condition?: string;
  constraints?: unknown[];
  hasAlternate?: boolean;
  consequentScopeId?: string;
  alternateScopeId?: string;
  parentScopeId?: string;
  conditionExpressionId?: string;
}
```

### 3. JSASTAnalyzer Changes

Modify `createIfStatementHandler()` to:
1. Create BRANCH node alongside SCOPE nodes
2. Store consequentScopeId and alternateScopeId
3. Add branch info to new `branches` collection

### 4. GraphBuilder Changes

Add `bufferBranchNodes()` method:
- Buffer BRANCH nodes
- Buffer HAS_CONDITION edges (BRANCH -> EXPRESSION)
- Buffer HAS_CONSEQUENT edges (BRANCH -> if SCOPE)
- Buffer HAS_ALTERNATE edges (BRANCH -> else SCOPE)

## Test Cases

1. Basic if statement - BRANCH with HAS_CONSEQUENT only
2. if-else statement - BRANCH with HAS_ALTERNATE
3. else-if chain - Multiple BRANCH nodes
4. Nested if statements - Hierarchical BRANCH structure
5. Complex conditions - Constraints parsing

## Implementation Order

1. Types first (packages/types/)
2. AST types (packages/core/.../ast/types.ts)
3. Tests (TDD - write failing tests)
4. JSASTAnalyzer (collection phase)
5. GraphBuilder (graph creation)
6. Run tests - verify passing
