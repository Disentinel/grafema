# Joel Spolsky: Detailed Technical Plan for REG-275

## Overview

This plan expands Don's high-level plan into specific implementation steps for Kent (tests) and Rob (implementation). The goal is to track `SwitchStatement` AST nodes with BRANCH and CASE node types.

---

## Open Questions - Decisions

### 1. Fall-through: Boolean property vs Edge?

**Decision: Boolean `fallsThrough` property on CASE node.**

Rationale:
- Simpler to implement and query
- Fall-through is a property of a case, not a relationship
- Edge would require tracking sequential order, which is already implicit in line numbers
- Consistent with how we track other boolean properties (e.g., `async` on FUNCTION)

### 2. Discriminant expression handling

**Decision: Create EXPRESSION node for discriminant, use existing ExpressionNode pattern.**

Rationale:
- ExpressionNode already handles MemberExpression (`action.type`)
- Reuse `NodeFactory.createExpression()` pattern
- Connect via HAS_CONDITION edge: `BRANCH -[HAS_CONDITION]-> EXPRESSION`

### 3. Empty case handling (`case 'A': case 'B': return x;`)

**Decision: Create both CASE nodes, mark first with `fallsThrough: true`, empty body = `isEmpty: true`.**

Rationale:
- Both cases are semantically meaningful (both values are handled)
- First case falls through to second
- `isEmpty` flag distinguishes intentional fall-through from missing break

---

## 1. Test Plan (Kent's Work)

### Test File Location
`/Users/vadimr/grafema-worker-2/test/unit/plugins/analysis/ast/switch-statement.test.ts`

### Test Cases

**Group 1: Basic BRANCH node creation**
1. `should create BRANCH node for simple switch` - Verify node type, branchType='switch', file, line
2. `should create BRANCH node with correct semantic ID` - Format: `{file}->scope->BRANCH->switch#N`

**Group 2: HAS_CONDITION edge creation**
3. `should create HAS_CONDITION edge from BRANCH to EXPRESSION` - Simple identifier: `switch(x)`
4. `should handle MemberExpression discriminant` - `switch(action.type)` creates EXPRESSION with object='action', property='type'
5. `should handle CallExpression discriminant` - `switch(getType())` creates edge to CALL node

**Group 3: HAS_CASE edge creation**
6. `should create CASE nodes for each case clause`
7. `should create HAS_CASE edges from BRANCH to each CASE`
8. `should include case value in CASE node` - `value: 'ADD'` for `case 'ADD':`
9. `should handle numeric case values` - `case 1:`, `case 2:`
10. `should handle identifier case values` - `case CONSTANTS.ADD:`

**Group 4: HAS_DEFAULT edge creation**
11. `should create HAS_DEFAULT edge for default case`
12. `should mark default CASE node with isDefault: true`
13. `should handle switch without default` - Only HAS_CASE edges, no HAS_DEFAULT

**Group 5: Fall-through detection**
14. `should mark case as fallsThrough when no break/return` - Case without terminator
15. `should NOT mark case as fallsThrough when has break`
16. `should NOT mark case as fallsThrough when has return`
17. `should handle empty case (intentional fall-through)` - `case 'A': case 'B': return x;`
18. `should mark empty cases with isEmpty: true`

**Group 6: Edge cases**
19. `should handle switch with single case`
20. `should handle switch with only default`
21. `should handle nested switch statements` - Each gets own BRANCH node
22. `should handle switch inside function` - Correct parent scope

### Expected Graph Structure (Example Test)
```javascript
// Input:
switch (action.type) {
  case 'ADD': return add();
  case 'REMOVE': return remove();
  default: return state;
}

// Expected nodes:
BRANCH { type: 'BRANCH', branchType: 'switch', file: '...', line: 1 }
EXPRESSION { type: 'EXPRESSION', expressionType: 'MemberExpression', object: 'action', property: 'type' }
CASE { type: 'CASE', value: 'ADD', isDefault: false, fallsThrough: false }
CASE { type: 'CASE', value: 'REMOVE', isDefault: false, fallsThrough: false }
CASE { type: 'CASE', value: null, isDefault: true, fallsThrough: false }

// Expected edges:
BRANCH -[HAS_CONDITION]-> EXPRESSION
BRANCH -[HAS_CASE]-> CASE('ADD')
BRANCH -[HAS_CASE]-> CASE('REMOVE')
BRANCH -[HAS_DEFAULT]-> CASE(default)
```

---

## 2. Type Changes

### File: `/Users/vadimr/grafema-worker-2/packages/types/src/nodes.ts`

**Add to NODE_TYPE constant (line ~30, after SCOPE):**
```typescript
BRANCH: 'BRANCH',
CASE: 'CASE',
```

**Add BranchNodeRecord interface (after ScopeNodeRecord, ~line 188):**
```typescript
// Branch node (switch, future: if/ternary)
export interface BranchNodeRecord extends BaseNodeRecord {
  type: 'BRANCH';
  branchType: 'switch' | 'if' | 'ternary';  // For future expansion
  parentScopeId?: string;
}
```

**Add CaseNodeRecord interface (after BranchNodeRecord):**
```typescript
// Case node (switch case clause)
export interface CaseNodeRecord extends BaseNodeRecord {
  type: 'CASE';
  value: unknown;         // Case test value ('ADD', 1, etc.) or null for default
  isDefault: boolean;     // true for default case
  fallsThrough: boolean;  // true if no break/return
  isEmpty: boolean;       // true if case has no statements (intentional fall-through)
}
```

**Add to NodeRecord union (line ~245):**
```typescript
| BranchNodeRecord
| CaseNodeRecord
```

### File: `/Users/vadimr/grafema-worker-2/packages/types/src/edges.ts`

**Add to EDGE_TYPE constant (line ~40, under Structure section):**
```typescript
// Branching
HAS_CONDITION: 'HAS_CONDITION',
HAS_CASE: 'HAS_CASE',
HAS_DEFAULT: 'HAS_DEFAULT',
```

---

## 3. Node Contracts

### File: `/Users/vadimr/grafema-worker-2/packages/core/src/core/nodes/BranchNode.ts` (NEW)

**Pattern to follow:** ScopeNode.ts (lines 1-145)

```typescript
/**
 * BranchNode - contract for BRANCH node
 *
 * Represents control flow branching (switch statements).
 * Future: if statements, ternary expressions.
 *
 * ID format (legacy): {file}:BRANCH:{branchType}:{line}:{counter}
 * Semantic ID format: {file}->{scope_path}->BRANCH->switch#N
 */

import type { BaseNodeRecord } from '@grafema/types';
import { computeSemanticId, type ScopeContext, type Location } from '../SemanticId.js';

interface BranchNodeRecord extends BaseNodeRecord {
  type: 'BRANCH';
  branchType: 'switch' | 'if' | 'ternary';
  parentScopeId?: string;
}

interface BranchNodeOptions {
  parentScopeId?: string;
  counter?: number;
}

interface BranchContextOptions {
  discriminator: number;
  parentScopeId?: string;
}

export class BranchNode {
  static readonly TYPE = 'BRANCH' as const;
  static readonly REQUIRED = ['branchType', 'file', 'line'] as const;
  static readonly OPTIONAL = ['parentScopeId'] as const;

  /**
   * Create BRANCH node (legacy ID)
   */
  static create(
    branchType: 'switch' | 'if' | 'ternary',
    file: string,
    line: number,
    options: BranchNodeOptions = {}
  ): BranchNodeRecord {
    // Validation
    if (!branchType) throw new Error('BranchNode.create: branchType is required');
    if (!file) throw new Error('BranchNode.create: file is required');
    if (line === undefined) throw new Error('BranchNode.create: line is required');

    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:BRANCH:${branchType}:${line}${counter}`;

    return {
      id,
      type: this.TYPE,
      name: branchType,
      file,
      line,
      branchType,
      parentScopeId: options.parentScopeId
    };
  }

  /**
   * Create BRANCH node with semantic ID (NEW API)
   */
  static createWithContext(
    branchType: 'switch' | 'if' | 'ternary',
    context: ScopeContext,
    location: Partial<Location>,
    options: BranchContextOptions
  ): BranchNodeRecord {
    if (!branchType) throw new Error('BranchNode.createWithContext: branchType is required');
    if (!context.file) throw new Error('BranchNode.createWithContext: file is required');
    if (location.line === undefined) throw new Error('BranchNode.createWithContext: line is required');
    if (options.discriminator === undefined) throw new Error('BranchNode.createWithContext: discriminator is required');

    const id = computeSemanticId('BRANCH', branchType, context, {
      discriminator: options.discriminator
    });

    return {
      id,
      type: this.TYPE,
      name: `${branchType}#${options.discriminator}`,
      file: context.file,
      line: location.line,
      branchType,
      parentScopeId: options.parentScopeId
    };
  }

  static validate(node: BranchNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }
    if (!node.branchType) {
      errors.push('Missing required field: branchType');
    }
    if (!node.file) {
      errors.push('Missing required field: file');
    }
    return errors;
  }
}

export type { BranchNodeRecord };
```

### File: `/Users/vadimr/grafema-worker-2/packages/core/src/core/nodes/CaseNode.ts` (NEW)

```typescript
/**
 * CaseNode - contract for CASE node
 *
 * Represents a case clause in a switch statement.
 *
 * ID format (legacy): {file}:CASE:{value}:{line}:{counter}
 * Semantic ID format: {file}->{scope_path}->CASE->{value}#N
 */

import type { BaseNodeRecord } from '@grafema/types';
import { computeSemanticId, type ScopeContext, type Location } from '../SemanticId.js';

interface CaseNodeRecord extends BaseNodeRecord {
  type: 'CASE';
  value: unknown;
  isDefault: boolean;
  fallsThrough: boolean;
  isEmpty: boolean;
  parentBranchId?: string;
}

interface CaseNodeOptions {
  parentBranchId?: string;
  counter?: number;
}

interface CaseContextOptions {
  discriminator: number;
  parentBranchId?: string;
}

export class CaseNode {
  static readonly TYPE = 'CASE' as const;
  static readonly REQUIRED = ['file', 'line'] as const;
  static readonly OPTIONAL = ['value', 'isDefault', 'fallsThrough', 'isEmpty', 'parentBranchId'] as const;

  /**
   * Create CASE node (legacy ID)
   */
  static create(
    value: unknown,
    isDefault: boolean,
    fallsThrough: boolean,
    isEmpty: boolean,
    file: string,
    line: number,
    options: CaseNodeOptions = {}
  ): CaseNodeRecord {
    if (!file) throw new Error('CaseNode.create: file is required');
    if (line === undefined) throw new Error('CaseNode.create: line is required');

    const valueName = isDefault ? 'default' : String(value);
    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:CASE:${valueName}:${line}${counter}`;

    return {
      id,
      type: this.TYPE,
      name: isDefault ? 'default' : `case ${String(value)}`,
      file,
      line,
      value,
      isDefault,
      fallsThrough,
      isEmpty,
      parentBranchId: options.parentBranchId
    };
  }

  /**
   * Create CASE node with semantic ID (NEW API)
   */
  static createWithContext(
    value: unknown,
    isDefault: boolean,
    fallsThrough: boolean,
    isEmpty: boolean,
    context: ScopeContext,
    location: Partial<Location>,
    options: CaseContextOptions
  ): CaseNodeRecord {
    if (!context.file) throw new Error('CaseNode.createWithContext: file is required');
    if (location.line === undefined) throw new Error('CaseNode.createWithContext: line is required');
    if (options.discriminator === undefined) throw new Error('CaseNode.createWithContext: discriminator is required');

    const valueName = isDefault ? 'default' : String(value);
    const id = computeSemanticId('CASE', valueName, context, {
      discriminator: options.discriminator
    });

    return {
      id,
      type: this.TYPE,
      name: isDefault ? 'default' : `case ${String(value)}`,
      file: context.file,
      line: location.line,
      value,
      isDefault,
      fallsThrough,
      isEmpty,
      parentBranchId: options.parentBranchId
    };
  }

  static validate(node: CaseNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }
    if (!node.file) {
      errors.push('Missing required field: file');
    }
    return errors;
  }
}

export type { CaseNodeRecord };
```

### File: `/Users/vadimr/grafema-worker-2/packages/core/src/core/nodes/index.ts`

**Add exports (after ScopeNode export, line ~13):**
```typescript
export { BranchNode, type BranchNodeRecord } from './BranchNode.js';
export { CaseNode, type CaseNodeRecord } from './CaseNode.js';
```

### File: `/Users/vadimr/grafema-worker-2/packages/core/src/core/NodeFactory.ts`

**Add imports (line ~35):**
```typescript
import { BranchNode } from './nodes/BranchNode.js';
import { CaseNode } from './nodes/CaseNode.js';
```

**Add factory methods (after createScope, ~line 291):**
```typescript
/**
 * Create BRANCH node
 */
static createBranch(branchType: 'switch' | 'if' | 'ternary', file: string, line: number, options: { parentScopeId?: string; counter?: number } = {}) {
  return brandNode(BranchNode.create(branchType, file, line, options));
}

/**
 * Create CASE node
 */
static createCase(
  value: unknown,
  isDefault: boolean,
  fallsThrough: boolean,
  isEmpty: boolean,
  file: string,
  line: number,
  options: { parentBranchId?: string; counter?: number } = {}
) {
  return brandNode(CaseNode.create(value, isDefault, fallsThrough, isEmpty, file, line, options));
}
```

**Add to validators map (in validate method, ~line 647):**
```typescript
'BRANCH': BranchNode,
'CASE': CaseNode,
```

---

## 4. Collection Types

### File: `/Users/vadimr/grafema-worker-2/packages/core/src/plugins/analysis/ast/types.ts`

**Add BranchInfo interface (after ScopeInfo, ~line 67):**
```typescript
// === BRANCH INFO ===
export interface BranchInfo {
  id: string;
  semanticId?: string;
  type: 'BRANCH';
  branchType: 'switch' | 'if' | 'ternary';
  file: string;
  line: number;
  parentScopeId?: string;
  discriminantExpressionId?: string;  // ID of EXPRESSION node for discriminant
}
```

**Add CaseInfo interface (after BranchInfo):**
```typescript
// === CASE INFO ===
export interface CaseInfo {
  id: string;
  semanticId?: string;
  type: 'CASE';
  value: unknown;
  isDefault: boolean;
  fallsThrough: boolean;
  isEmpty: boolean;
  file: string;
  line: number;
  parentBranchId: string;
}
```

**Update ASTCollections interface (add after `scopes: ScopeInfo[];`, ~line 534):**
```typescript
branches?: BranchInfo[];
cases?: CaseInfo[];
branchCounterRef?: CounterRef;
caseCounterRef?: CounterRef;
```

---

## 5. JSASTAnalyzer Changes

### File: `/Users/vadimr/grafema-worker-2/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Current code to replace (lines 2261-2275):**
```typescript
SwitchStatement: (switchPath: NodePath<t.SwitchStatement>) => {
  const switchNode = switchPath.node;
  const scopeId = `SCOPE#switch-case#${module.file}#${getLine(switchNode)}:${scopeCounterRef.value++}`;
  const semanticId = this.generateSemanticId('switch-case', scopeTracker);

  scopes.push({
    id: scopeId,
    type: 'SCOPE',
    scopeType: 'switch-case',
    semanticId,
    file: module.file,
    line: getLine(switchNode),
    parentScopeId
  });
},
```

**New implementation:**
```typescript
SwitchStatement: (switchPath: NodePath<t.SwitchStatement>) => {
  this.handleSwitchStatement(
    switchPath,
    parentScopeId,
    module,
    collections,
    scopeTracker
  );
},
```

**Add new method (after handleTryStatement, ~line 1960):**
```typescript
/**
 * Handles SwitchStatement nodes.
 * Creates BRANCH node for switch, CASE nodes for each case clause,
 * and EXPRESSION node for discriminant.
 *
 * @param switchPath - The NodePath for the SwitchStatement
 * @param parentScopeId - Parent scope ID
 * @param module - Module context
 * @param collections - AST collections
 * @param scopeTracker - Tracker for semantic ID generation
 */
private handleSwitchStatement(
  switchPath: NodePath<t.SwitchStatement>,
  parentScopeId: string,
  module: VisitorModule,
  collections: ASTCollections,
  scopeTracker: ScopeTracker | undefined
): void {
  const switchNode = switchPath.node;

  // Initialize collections if not exist
  if (!collections.branches) {
    collections.branches = [];
  }
  if (!collections.cases) {
    collections.cases = [];
  }
  if (!collections.branchCounterRef) {
    collections.branchCounterRef = { value: 0 };
  }
  if (!collections.caseCounterRef) {
    collections.caseCounterRef = { value: 0 };
  }

  const branches = collections.branches as BranchInfo[];
  const cases = collections.cases as CaseInfo[];
  const branchCounterRef = collections.branchCounterRef as CounterRef;
  const caseCounterRef = collections.caseCounterRef as CounterRef;

  // Create BRANCH node
  const legacyBranchId = `${module.file}:BRANCH:switch:${getLine(switchNode)}:${branchCounterRef.value++}`;
  const branchId = scopeTracker
    ? computeSemanticId('BRANCH', 'switch', scopeTracker.getContext(), { discriminator: branchCounterRef.value - 1 })
    : legacyBranchId;

  // Handle discriminant expression
  let discriminantExpressionId: string | undefined;
  if (switchNode.discriminant) {
    discriminantExpressionId = this.extractDiscriminantExpression(
      switchNode.discriminant,
      module,
      collections.literals || [],
      collections.literalCounterRef || { value: 0 }
    );
  }

  branches.push({
    id: branchId,
    semanticId: branchId,
    type: 'BRANCH',
    branchType: 'switch',
    file: module.file,
    line: getLine(switchNode),
    parentScopeId,
    discriminantExpressionId
  });

  // Process each case clause
  for (let i = 0; i < switchNode.cases.length; i++) {
    const caseNode = switchNode.cases[i];
    const isDefault = caseNode.test === null;
    const isEmpty = caseNode.consequent.length === 0;

    // Detect fall-through: no break/return/throw at end of consequent
    const fallsThrough = !isEmpty && !this.caseTerminates(caseNode);

    // Extract case value
    const value = isDefault ? null : this.extractCaseValue(caseNode.test);

    const legacyCaseId = `${module.file}:CASE:${isDefault ? 'default' : String(value)}:${getLine(caseNode)}:${caseCounterRef.value++}`;
    const caseId = scopeTracker
      ? computeSemanticId('CASE', isDefault ? 'default' : String(value), scopeTracker.getContext(), { discriminator: caseCounterRef.value - 1 })
      : legacyCaseId;

    cases.push({
      id: caseId,
      semanticId: caseId,
      type: 'CASE',
      value,
      isDefault,
      fallsThrough,
      isEmpty,
      file: module.file,
      line: getLine(caseNode),
      parentBranchId: branchId
    });
  }
}

/**
 * Extract EXPRESSION node ID for switch discriminant
 */
private extractDiscriminantExpression(
  discriminant: t.Expression,
  module: VisitorModule,
  literals: LiteralInfo[],
  literalCounterRef: CounterRef
): string {
  const line = getLine(discriminant);
  const column = getColumn(discriminant);

  if (t.isIdentifier(discriminant)) {
    // Simple identifier: switch(x) - create EXPRESSION node
    return NodeFactory.generateExpressionId('Identifier', module.file, line, column);
  } else if (t.isMemberExpression(discriminant)) {
    // Member expression: switch(action.type)
    const object = t.isIdentifier(discriminant.object) ? discriminant.object.name : '<complex>';
    const property = t.isIdentifier(discriminant.property) ? discriminant.property.name : '<computed>';
    return NodeFactory.generateExpressionId('MemberExpression', module.file, line, column);
  } else if (t.isCallExpression(discriminant)) {
    // Call expression: switch(getType())
    const callee = t.isIdentifier(discriminant.callee) ? discriminant.callee.name : '<complex>';
    // Return CALL node ID instead of EXPRESSION (reuse existing call tracking)
    return `${module.file}:CALL:${callee}:${line}:${column}`;
  }

  // Default: create generic EXPRESSION
  return NodeFactory.generateExpressionId(discriminant.type, module.file, line, column);
}

/**
 * Extract case test value as a primitive
 */
private extractCaseValue(test: t.Expression | null): unknown {
  if (!test) return null;

  if (t.isStringLiteral(test)) {
    return test.value;
  } else if (t.isNumericLiteral(test)) {
    return test.value;
  } else if (t.isBooleanLiteral(test)) {
    return test.value;
  } else if (t.isNullLiteral(test)) {
    return null;
  } else if (t.isIdentifier(test)) {
    // Constant reference: case CONSTANTS.ADD
    return test.name;
  } else if (t.isMemberExpression(test)) {
    // Member expression: case Action.ADD
    return this.memberExpressionToString(test);
  }

  return '<complex>';
}

/**
 * Check if case clause terminates (has break, return, throw)
 */
private caseTerminates(caseNode: t.SwitchCase): boolean {
  const statements = caseNode.consequent;
  if (statements.length === 0) return false;

  // Check last statement (or any statement for early returns)
  for (const stmt of statements) {
    if (t.isBreakStatement(stmt)) return true;
    if (t.isReturnStatement(stmt)) return true;
    if (t.isThrowStatement(stmt)) return true;
    if (t.isContinueStatement(stmt)) return true;  // In switch inside loop

    // Check for nested blocks (if last statement is block, check inside)
    if (t.isBlockStatement(stmt)) {
      const lastInBlock = stmt.body[stmt.body.length - 1];
      if (lastInBlock && (
        t.isBreakStatement(lastInBlock) ||
        t.isReturnStatement(lastInBlock) ||
        t.isThrowStatement(lastInBlock)
      )) {
        return true;
      }
    }

    // Check for if-else where both branches terminate
    if (t.isIfStatement(stmt) && stmt.alternate) {
      const ifTerminates = this.blockTerminates(stmt.consequent);
      const elseTerminates = this.blockTerminates(stmt.alternate);
      if (ifTerminates && elseTerminates) return true;
    }
  }

  return false;
}

/**
 * Check if a block/statement terminates
 */
private blockTerminates(node: t.Statement): boolean {
  if (t.isBreakStatement(node)) return true;
  if (t.isReturnStatement(node)) return true;
  if (t.isThrowStatement(node)) return true;
  if (t.isBlockStatement(node)) {
    const last = node.body[node.body.length - 1];
    return last ? this.blockTerminates(last) : false;
  }
  return false;
}

/**
 * Convert MemberExpression to string representation
 */
private memberExpressionToString(expr: t.MemberExpression): string {
  const parts: string[] = [];

  let current: t.Expression = expr;
  while (t.isMemberExpression(current)) {
    if (t.isIdentifier(current.property)) {
      parts.unshift(current.property.name);
    } else {
      parts.unshift('<computed>');
    }
    current = current.object;
  }

  if (t.isIdentifier(current)) {
    parts.unshift(current.name);
  }

  return parts.join('.');
}
```

---

## 6. GraphBuilder Changes

### File: `/Users/vadimr/grafema-worker-2/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Add imports (line ~46):**
```typescript
import type { BranchInfo, CaseInfo } from './types.js';
```

**Update build method destructuring (after line ~127, add to destructuring):**
```typescript
branches = [],
cases = [],
```

**Add buffer calls in build method (after scopes, ~line 150):**
```typescript
// 2.5. Buffer BRANCH nodes
for (const branch of branches) {
  const { parentScopeId, discriminantExpressionId, ...branchData } = branch;
  this._bufferNode(branchData as GraphNode);
}

// 2.6. Buffer CASE nodes
for (const caseInfo of cases) {
  const { parentBranchId, ...caseData } = caseInfo;
  this._bufferNode(caseData as GraphNode);
}
```

**Add new buffer methods (after bufferScopeEdges, ~line 352):**
```typescript
/**
 * Buffer BRANCH edges (CONTAINS, HAS_CONDITION)
 */
private bufferBranchEdges(branches: BranchInfo[]): void {
  for (const branch of branches) {
    // Parent SCOPE -> CONTAINS -> BRANCH
    if (branch.parentScopeId) {
      this._bufferEdge({
        type: 'CONTAINS',
        src: branch.parentScopeId,
        dst: branch.id
      });
    }

    // BRANCH -> HAS_CONDITION -> EXPRESSION (discriminant)
    if (branch.discriminantExpressionId) {
      this._bufferEdge({
        type: 'HAS_CONDITION',
        src: branch.id,
        dst: branch.discriminantExpressionId
      });
    }
  }
}

/**
 * Buffer CASE edges (HAS_CASE, HAS_DEFAULT)
 */
private bufferCaseEdges(cases: CaseInfo[]): void {
  for (const caseInfo of cases) {
    // BRANCH -> HAS_CASE or HAS_DEFAULT -> CASE
    const edgeType = caseInfo.isDefault ? 'HAS_DEFAULT' : 'HAS_CASE';
    this._bufferEdge({
      type: edgeType,
      src: caseInfo.parentBranchId,
      dst: caseInfo.id
    });
  }
}
```

**Call buffer methods in build (after `this.bufferScopeEdges`, ~line 198):**
```typescript
// 6.5. Buffer edges for BRANCH
this.bufferBranchEdges(branches);

// 6.6. Buffer edges for CASE
this.bufferCaseEdges(cases);
```

**Create EXPRESSION nodes for discriminants (add after bufferLiterals call, ~line 234):**
```typescript
// 18.8. Buffer EXPRESSION nodes for switch discriminants
this.bufferDiscriminantExpressions(branches);
```

**Add method:**
```typescript
/**
 * Buffer EXPRESSION nodes for switch discriminants
 */
private bufferDiscriminantExpressions(branches: BranchInfo[]): void {
  for (const branch of branches) {
    if (branch.discriminantExpressionId) {
      // Only create if it looks like an EXPRESSION ID (not a CALL)
      if (branch.discriminantExpressionId.includes(':EXPRESSION:')) {
        // Parse the ID to extract expression type
        const parts = branch.discriminantExpressionId.split(':');
        const expressionType = parts[2];  // {file}:EXPRESSION:{type}:{line}:{col}
        const file = parts[0];
        const line = parseInt(parts[3], 10);
        const column = parseInt(parts[4], 10);

        this._bufferNode({
          id: branch.discriminantExpressionId,
          type: 'EXPRESSION',
          name: expressionType,
          file,
          line,
          column,
          expressionType
        });
      }
    }
  }
}
```

---

## 7. Implementation Order

### Phase 1: Type System Foundation (Kent: tests, Rob: types)
1. Kent writes failing tests for BRANCH and CASE node types
2. Rob adds BRANCH, CASE to `packages/types/src/nodes.ts`
3. Rob adds HAS_CONDITION, HAS_CASE, HAS_DEFAULT to `packages/types/src/edges.ts`

### Phase 2: Node Contracts (Kent: tests, Rob: contracts)
4. Kent writes failing tests for BranchNode.create() and CaseNode.create()
5. Rob creates `packages/core/src/core/nodes/BranchNode.ts`
6. Rob creates `packages/core/src/core/nodes/CaseNode.ts`
7. Rob updates `packages/core/src/core/nodes/index.ts` exports

### Phase 3: NodeFactory (Rob only - minimal)
8. Rob adds `createBranch()` and `createCase()` to NodeFactory
9. Rob adds validators to NodeFactory.validate()

### Phase 4: Collection Types (Rob only)
10. Rob adds BranchInfo and CaseInfo interfaces to `types.ts`
11. Rob updates ASTCollections with branches, cases, and counter refs

### Phase 5: JSASTAnalyzer (Kent: tests, Rob: implementation)
12. Kent writes integration tests for SwitchStatement handling
13. Rob replaces current SwitchStatement handler (lines 2261-2275)
14. Rob implements `handleSwitchStatement()` method
15. Rob implements helper methods: `extractDiscriminantExpression()`, `extractCaseValue()`, `caseTerminates()`, `blockTerminates()`, `memberExpressionToString()`

### Phase 6: GraphBuilder (Kent: tests, Rob: implementation)
16. Kent writes tests for BRANCH/CASE edges
17. Rob adds `bufferBranchEdges()` method
18. Rob adds `bufferCaseEdges()` method
19. Rob adds `bufferDiscriminantExpressions()` method
20. Rob updates `build()` method to call new buffer methods

### Phase 7: Integration Testing (Kent)
21. Kent runs full test suite
22. Kent verifies all edge cases pass
23. Kent verifies no regressions in existing tests

---

## Critical Files

1. **`/Users/vadimr/grafema-worker-2/packages/types/src/nodes.ts`** - Add BRANCH, CASE types and interfaces
2. **`/Users/vadimr/grafema-worker-2/packages/types/src/edges.ts`** - Add HAS_CONDITION, HAS_CASE, HAS_DEFAULT
3. **`/Users/vadimr/grafema-worker-2/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`** - Replace SwitchStatement handler (lines 2261-2275)
4. **`/Users/vadimr/grafema-worker-2/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`** - Add buffer methods for BRANCH/CASE
5. **`/Users/vadimr/grafema-worker-2/packages/core/src/core/nodes/ScopeNode.ts`** - Pattern to follow for BranchNode

---

## Notes for Rob

- The current SwitchStatement handler creates a SCOPE node with `scopeType: 'switch-case'`. This will be **replaced**, not supplemented. BRANCH is the correct abstraction.
- Fall-through detection should handle edge cases: empty cases, if-else in case body, nested switches
- The discriminant EXPRESSION node may already exist if it's a CALL. Check before creating duplicate.
- Use `scopeTracker.getContext()` for semantic IDs when available, fall back to legacy IDs otherwise.

## Notes for Kent

- Use `createTestOrchestrator` pattern from `object-property-edges.test.ts`
- Test both legacy ID format and semantic ID format
- Verify edges exist with correct src/dst relationships
- Test fall-through detection with various terminator patterns
