# REG-267: Control Flow Layer - Technical Specification

**Date:** 2026-02-01
**Role:** Implementation Planner (Joel Spolsky)
**Status:** Ready for Implementation

---

## Overview

This document expands Don Melton's analysis into detailed implementation steps for the Control Flow Layer feature. The implementation is organized into 6 phases, each with specific file modifications, interface definitions, and test scenarios.

**Key Decisions (from User):**
1. All 6 phases implemented in this task
2. Backward compatibility: Keep SCOPE nodes AND new dedicated node types
3. Function metadata with `cyclomaticComplexity` included in v0.2

---

## Phase 1: Types and Interfaces (Foundation)

### 1.1 Node Types (`packages/types/src/nodes.ts`)

Add new node types to `NODE_TYPE` constant:

```typescript
// In NODE_TYPE object, after CASE:
LOOP: 'LOOP',
TRY_BLOCK: 'TRY_BLOCK',
CATCH_BLOCK: 'CATCH_BLOCK',
FINALLY_BLOCK: 'FINALLY_BLOCK',
```

Add new node record interfaces:

```typescript
// Loop node (for, for-in, for-of, while, do-while)
export interface LoopNodeRecord extends BaseNodeRecord {
  type: 'LOOP';
  loopType: 'for' | 'for-in' | 'for-of' | 'while' | 'do-while';
  parentScopeId?: string;
  bodyScopeId?: string;  // ID of SCOPE node containing loop body
}

// Try block node
export interface TryBlockNodeRecord extends BaseNodeRecord {
  type: 'TRY_BLOCK';
  parentScopeId?: string;
  bodyScopeId?: string;  // ID of SCOPE node containing try body
}

// Catch block node
export interface CatchBlockNodeRecord extends BaseNodeRecord {
  type: 'CATCH_BLOCK';
  parentScopeId?: string;
  parameterName?: string;  // Error parameter name (e.g., 'e' in catch(e))
  bodyScopeId?: string;    // ID of SCOPE node containing catch body
}

// Finally block node
export interface FinallyBlockNodeRecord extends BaseNodeRecord {
  type: 'FINALLY_BLOCK';
  parentScopeId?: string;
  bodyScopeId?: string;  // ID of SCOPE node containing finally body
}
```

Update `NodeRecord` union type to include new types:

```typescript
export type NodeRecord =
  | FunctionNodeRecord
  // ... existing types ...
  | LoopNodeRecord
  | TryBlockNodeRecord
  | CatchBlockNodeRecord
  | FinallyBlockNodeRecord
  | BaseNodeRecord;
```

### 1.2 Edge Types (`packages/types/src/edges.ts`)

Add new edge types to `EDGE_TYPE` constant:

```typescript
// In EDGE_TYPE object, after HAS_DEFAULT:

// Loop edges
HAS_BODY: 'HAS_BODY',           // LOOP -> body SCOPE
ITERATES_OVER: 'ITERATES_OVER', // LOOP -> collection VARIABLE (for-in/for-of)

// If statement edges
HAS_CONSEQUENT: 'HAS_CONSEQUENT', // BRANCH -> then SCOPE
HAS_ALTERNATE: 'HAS_ALTERNATE',   // BRANCH -> else SCOPE

// Try/catch/finally edges
HAS_CATCH: 'HAS_CATCH',     // TRY_BLOCK -> CATCH_BLOCK
HAS_FINALLY: 'HAS_FINALLY', // TRY_BLOCK -> FINALLY_BLOCK
```

### 1.3 AST Types (`packages/core/src/plugins/analysis/ast/types.ts`)

Add new info interfaces for AST collection:

```typescript
// === LOOP INFO ===
export interface LoopInfo {
  id: string;
  semanticId?: string;
  type: 'LOOP';
  loopType: 'for' | 'for-in' | 'for-of' | 'while' | 'do-while';
  file: string;
  line: number;
  column?: number;
  parentScopeId?: string;
  // For for-in/for-of: the collection being iterated
  iteratesOverName?: string;      // Variable name (e.g., 'items')
  iteratesOverLine?: number;      // Line of collection reference
  iteratesOverColumn?: number;    // Column of collection reference
}

// === TRY BLOCK INFO ===
export interface TryBlockInfo {
  id: string;
  semanticId?: string;
  type: 'TRY_BLOCK';
  file: string;
  line: number;
  column?: number;
  parentScopeId?: string;
}

// === CATCH BLOCK INFO ===
export interface CatchBlockInfo {
  id: string;
  semanticId?: string;
  type: 'CATCH_BLOCK';
  file: string;
  line: number;
  column?: number;
  parentScopeId?: string;
  parentTryBlockId: string;  // ID of parent TRY_BLOCK
  parameterName?: string;     // Error parameter name
}

// === FINALLY BLOCK INFO ===
export interface FinallyBlockInfo {
  id: string;
  semanticId?: string;
  type: 'FINALLY_BLOCK';
  file: string;
  line: number;
  column?: number;
  parentScopeId?: string;
  parentTryBlockId: string;  // ID of parent TRY_BLOCK
}

// === CONTROL FLOW METADATA ===
// Attached to FUNCTION nodes
export interface ControlFlowMetadata {
  hasBranches: boolean;      // Has if/switch statements
  hasLoops: boolean;         // Has any loop type
  hasTryCatch: boolean;      // Has try/catch blocks
  hasEarlyReturn: boolean;   // Has return before function end
  hasThrow: boolean;         // Has throw statements
  cyclomaticComplexity: number;  // McCabe cyclomatic complexity
}
```

Update `ASTCollections` interface:

```typescript
export interface ASTCollections {
  // ... existing fields ...

  // Control flow (new)
  loops?: LoopInfo[];
  tryBlocks?: TryBlockInfo[];
  catchBlocks?: CatchBlockInfo[];
  finallyBlocks?: FinallyBlockInfo[];

  // Counter refs (add)
  loopCounterRef?: CounterRef;
  tryBlockCounterRef?: CounterRef;
  catchBlockCounterRef?: CounterRef;
  finallyBlockCounterRef?: CounterRef;
}
```

---

## Phase 2: Loop Nodes

### 2.1 Modify `createLoopScopeHandler()` in JSASTAnalyzer.ts

**Location:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`, lines ~1819-1866

**Current Behavior:**
- Creates SCOPE node with `scopeType` like 'for-loop', 'for-of-loop', etc.
- Pushes scope to `scopes` collection
- Manages `scopeIdStack` for CONTAINS edges

**New Behavior:**
1. Create LOOP node (new collection)
2. ALSO create SCOPE node for body (backward compatibility)
3. Track ITERATES_OVER for for-in/for-of
4. Store body scope ID in loop info for HAS_BODY edge

**Method Signature (updated):**

```typescript
private createLoopScopeHandler(
  trackerScopeType: string,
  scopeType: string,
  loopType: 'for' | 'for-in' | 'for-of' | 'while' | 'do-while',
  parentScopeId: string,
  module: VisitorModule,
  scopes: ScopeInfo[],
  loops: LoopInfo[],                    // NEW
  scopeCounterRef: CounterRef,
  loopCounterRef: CounterRef,           // NEW
  scopeTracker: ScopeTracker | undefined,
  scopeIdStack?: string[]
): { enter: (path: NodePath<t.Loop>) => void; exit: () => void }
```

**Implementation Steps:**

1. In `enter()`:
   ```typescript
   // 1. Create LOOP node
   const loopCounter = loopCounterRef.value++;
   const loopId = scopeTracker
     ? computeSemanticId('LOOP', loopType, scopeTracker.getContext(), { discriminator: loopCounter })
     : `${module.file}:LOOP:${loopType}:${getLine(node)}:${loopCounter}`;

   // 2. Create body SCOPE (keep for backward compatibility)
   const scopeId = `SCOPE#${scopeType}#${module.file}#${getLine(node)}:${scopeCounterRef.value++}`;
   const semanticId = this.generateSemanticId(scopeType, scopeTracker);

   // 3. Extract iteration target for for-in/for-of
   let iteratesOverName: string | undefined;
   let iteratesOverLine: number | undefined;
   let iteratesOverColumn: number | undefined;

   if (loopType === 'for-in' || loopType === 'for-of') {
     const loopNode = node as t.ForInStatement | t.ForOfStatement;
     if (t.isIdentifier(loopNode.right)) {
       iteratesOverName = loopNode.right.name;
       iteratesOverLine = getLine(loopNode.right);
       iteratesOverColumn = getColumn(loopNode.right);
     } else if (t.isMemberExpression(loopNode.right)) {
       iteratesOverName = this.memberExpressionToString(loopNode.right);
       iteratesOverLine = getLine(loopNode.right);
       iteratesOverColumn = getColumn(loopNode.right);
     }
   }

   // 4. Push LOOP info
   loops.push({
     id: loopId,
     semanticId: loopId,
     type: 'LOOP',
     loopType,
     file: module.file,
     line: getLine(node),
     column: getColumn(node),
     parentScopeId,
     iteratesOverName,
     iteratesOverLine,
     iteratesOverColumn
   });

   // 5. Push body SCOPE (backward compatibility)
   scopes.push({
     id: scopeId,
     type: 'SCOPE',
     scopeType,
     semanticId,
     file: module.file,
     line: getLine(node),
     parentScopeId: loopId  // Parent is now LOOP, not original parentScopeId
   });

   // 6. Push LOOP to scopeIdStack (for CONTAINS edges to nested items)
   if (scopeIdStack) {
     scopeIdStack.push(loopId);
   }
   ```

2. Update caller sites in `analyzeFunctionBody()` (~line 2762-2766):
   ```typescript
   // Initialize loops collection
   const loops = (collections.loops ?? []) as LoopInfo[];
   const loopCounterRef = (collections.loopCounterRef ?? { value: 0 }) as CounterRef;

   // Update handler creation calls
   ForStatement: this.createLoopScopeHandler('for', 'for-loop', 'for', ...),
   ForInStatement: this.createLoopScopeHandler('for-in', 'for-in-loop', 'for-in', ...),
   ForOfStatement: this.createLoopScopeHandler('for-of', 'for-of-loop', 'for-of', ...),
   WhileStatement: this.createLoopScopeHandler('while', 'while-loop', 'while', ...),
   DoWhileStatement: this.createLoopScopeHandler('do-while', 'do-while-loop', 'do-while', ...),
   ```

### 2.2 Variable Declaration Handling (DECLARES Edge)

**Existing behavior (REG-272):** Loop variables get DERIVES_FROM edges to the collection.

**New behavior:** Loop variables should also get DECLARES edge from LOOP node.

In the loop variable handling section of `createLoopScopeHandler()`:
```typescript
// Track loop variable for DECLARES edge
// (handled by existing code in VariableVisitor, but parentScopeId should be LOOP)
```

The existing `VariableVisitor.ts` code (lines 226-258) creates variables with `parentScopeId: module.id`. This needs to be updated to use the LOOP node ID when the variable is a loop variable.

**Option:** Create a `loopVariableMap` that maps loop variable names to their parent LOOP IDs, passed to VariableVisitor. However, this may be complex.

**Simpler approach:** The DECLARES edge will be created in GraphBuilder based on the variable's `line` matching the LOOP's `line`.

---

## Phase 3: If Statement Nodes

### 3.1 Modify `createIfStatementHandler()` in JSASTAnalyzer.ts

**Location:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`, lines ~2318-2410

**Current Behavior:**
- Creates SCOPE nodes for if-body and else-body
- Tracks condition text and constraints
- Uses `ifElseScopeMap` for scope transitions

**New Behavior:**
1. Create BRANCH node (branchType: 'if')
2. Keep SCOPE nodes for bodies (backward compatibility)
3. Create HAS_CONDITION, HAS_CONSEQUENT, HAS_ALTERNATE edges

**Method Signature (updated):**

```typescript
private createIfStatementHandler(
  parentScopeId: string,
  module: VisitorModule,
  scopes: ScopeInfo[],
  branches: BranchInfo[],           // ADD to existing signature
  ifScopeCounterRef: CounterRef,
  branchCounterRef: CounterRef,     // ADD
  scopeTracker: ScopeTracker | undefined,
  sourceCode: string,
  ifElseScopeMap: Map<t.IfStatement, IfElseScopeInfo>,
  scopeIdStack?: string[]
): { enter: (ifPath: NodePath<t.IfStatement>) => void; exit: (ifPath: NodePath<t.IfStatement>) => void }
```

**Updated IfElseScopeInfo type:**

```typescript
interface IfElseScopeInfo {
  inElse: boolean;
  hasElse: boolean;
  ifScopeId: string;
  elseScopeId: string | null;
  branchId: string;              // NEW: ID of BRANCH node
  conditionExpressionId?: string; // NEW: ID of condition EXPRESSION
}
```

**Implementation Steps:**

1. In `enter()`:
   ```typescript
   // 1. Create BRANCH node
   const branchCounter = branchCounterRef.value++;
   const branchId = scopeTracker
     ? computeSemanticId('BRANCH', 'if', scopeTracker.getContext(), { discriminator: branchCounter })
     : `${module.file}:BRANCH:if:${getLine(ifNode)}:${branchCounter}`;

   // 2. Extract condition expression info
   const conditionExpressionId = this.extractConditionExpression(
     ifNode.test,
     module
   ).id;

   // 3. Push BRANCH info
   branches.push({
     id: branchId,
     semanticId: branchId,
     type: 'BRANCH',
     branchType: 'if',
     file: module.file,
     line: getLine(ifNode),
     parentScopeId,
     discriminantExpressionId: conditionExpressionId,
     discriminantExpressionType: ifNode.test.type,
     discriminantLine: getLine(ifNode.test),
     discriminantColumn: getColumn(ifNode.test)
   });

   // 4. Create if-body SCOPE (existing code, but set parentScopeId to branchId)
   const ifScopeId = `SCOPE#if#${module.file}#${getLine(ifNode)}:${getColumn(ifNode)}:${counterId}`;
   scopes.push({
     // ... existing fields ...
     parentScopeId: branchId  // Changed from original parentScopeId
   });

   // 5. Create else-body SCOPE if present (existing code, but set parentScopeId to branchId)
   if (ifNode.alternate && !t.isIfStatement(ifNode.alternate)) {
     elseScopeId = `SCOPE#else#${module.file}#${getLine(ifNode.alternate)}:...`;
     scopes.push({
       // ... existing fields ...
       parentScopeId: branchId  // Changed from original parentScopeId
     });
   }

   // 6. Push BRANCH to scopeIdStack
   if (scopeIdStack) {
     scopeIdStack.push(branchId);
   }

   // 7. Store in map with new branchId
   ifElseScopeMap.set(ifNode, {
     inElse: false,
     hasElse: ...,
     ifScopeId,
     elseScopeId,
     branchId,
     conditionExpressionId
   });
   ```

### 3.2 Add `extractConditionExpression()` Method

**New private method** (similar to `extractDiscriminantExpression()`):

```typescript
private extractConditionExpression(
  condition: t.Expression,
  module: VisitorModule
): { id: string; expressionType: string; line: number; column: number } {
  const line = getLine(condition);
  const column = getColumn(condition);

  if (t.isIdentifier(condition)) {
    return {
      id: ExpressionNode.generateId('Identifier', module.file, line, column),
      expressionType: 'Identifier',
      line,
      column
    };
  } else if (t.isBinaryExpression(condition)) {
    return {
      id: ExpressionNode.generateId('BinaryExpression', module.file, line, column),
      expressionType: 'BinaryExpression',
      line,
      column
    };
  } else if (t.isLogicalExpression(condition)) {
    return {
      id: ExpressionNode.generateId('LogicalExpression', module.file, line, column),
      expressionType: 'LogicalExpression',
      line,
      column
    };
  } else if (t.isCallExpression(condition)) {
    const callee = t.isIdentifier(condition.callee) ? condition.callee.name : '<complex>';
    return {
      id: `${module.file}:CALL:${callee}:${line}:${column}`,
      expressionType: 'CallExpression',
      line,
      column
    };
  }

  return {
    id: ExpressionNode.generateId(condition.type, module.file, line, column),
    expressionType: condition.type,
    line,
    column
  };
}
```

### 3.3 Else-If Chain Handling

Else-if chains (`if (a) {} else if (b) {} else {}`) are already handled correctly:
- When `ifNode.alternate` is an `IfStatement`, we don't create an else scope
- The nested `IfStatement` gets its own BRANCH node through recursive traversal

No changes needed for else-if chain support.

---

## Phase 4: Try/Catch/Finally Nodes

### 4.1 Modify `createTryStatementHandler()` in JSASTAnalyzer.ts

**Location:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`, lines ~1881-1976

**Current Behavior:**
- Creates SCOPE nodes for try-block, catch-block, finally-block
- Uses `tryScopeMap` for scope transitions

**New Behavior:**
1. Create TRY_BLOCK node
2. Create CATCH_BLOCK node (if handler exists)
3. Create FINALLY_BLOCK node (if finalizer exists)
4. Keep SCOPE nodes for body contents (backward compatibility)
5. Create HAS_CATCH, HAS_FINALLY edges

**Method Signature (updated):**

```typescript
private createTryStatementHandler(
  parentScopeId: string,
  module: VisitorModule,
  scopes: ScopeInfo[],
  tryBlocks: TryBlockInfo[],         // NEW
  catchBlocks: CatchBlockInfo[],     // NEW
  finallyBlocks: FinallyBlockInfo[], // NEW
  scopeCounterRef: CounterRef,
  tryBlockCounterRef: CounterRef,    // NEW
  catchBlockCounterRef: CounterRef,  // NEW
  finallyBlockCounterRef: CounterRef,// NEW
  scopeTracker: ScopeTracker | undefined,
  tryScopeMap: Map<t.TryStatement, TryScopeInfo>,
  scopeIdStack?: string[]
): { enter: (tryPath: NodePath<t.TryStatement>) => void; exit: (tryPath: NodePath<t.TryStatement>) => void }
```

**Updated TryScopeInfo type:**

```typescript
interface TryScopeInfo {
  tryScopeId: string;           // Body SCOPE ID
  catchScopeId: string | null;  // Catch body SCOPE ID
  finallyScopeId: string | null;// Finally body SCOPE ID
  currentBlock: 'try' | 'catch' | 'finally';
  tryBlockId: string;           // NEW: TRY_BLOCK node ID
  catchBlockId: string | null;  // NEW: CATCH_BLOCK node ID
  finallyBlockId: string | null;// NEW: FINALLY_BLOCK node ID
}
```

**Implementation Steps:**

1. In `enter()`:
   ```typescript
   const tryNode = tryPath.node;

   // 1. Create TRY_BLOCK node
   const tryBlockCounter = tryBlockCounterRef.value++;
   const tryBlockId = scopeTracker
     ? computeSemanticId('TRY_BLOCK', 'try', scopeTracker.getContext(), { discriminator: tryBlockCounter })
     : `${module.file}:TRY_BLOCK:${getLine(tryNode)}:${tryBlockCounter}`;

   tryBlocks.push({
     id: tryBlockId,
     semanticId: tryBlockId,
     type: 'TRY_BLOCK',
     file: module.file,
     line: getLine(tryNode),
     column: getColumn(tryNode),
     parentScopeId
   });

   // 2. Create try-body SCOPE (backward compatibility)
   const tryScopeId = `SCOPE#try-block#${module.file}#${getLine(tryNode)}:${scopeCounterRef.value++}`;
   scopes.push({
     id: tryScopeId,
     type: 'SCOPE',
     scopeType: 'try-block',
     // ... other fields ...
     parentScopeId: tryBlockId  // Parent is TRY_BLOCK
   });

   // 3. Create CATCH_BLOCK if handler exists
   let catchBlockId: string | null = null;
   let catchScopeId: string | null = null;
   if (tryNode.handler) {
     const catchBlockCounter = catchBlockCounterRef.value++;
     catchBlockId = scopeTracker
       ? computeSemanticId('CATCH_BLOCK', 'catch', scopeTracker.getContext(), { discriminator: catchBlockCounter })
       : `${module.file}:CATCH_BLOCK:${getLine(tryNode.handler)}:${catchBlockCounter}`;

     // Extract parameter name
     let parameterName: string | undefined;
     if (tryNode.handler.param && t.isIdentifier(tryNode.handler.param)) {
       parameterName = tryNode.handler.param.name;
     }

     catchBlocks.push({
       id: catchBlockId,
       semanticId: catchBlockId,
       type: 'CATCH_BLOCK',
       file: module.file,
       line: getLine(tryNode.handler),
       column: getColumn(tryNode.handler),
       parentScopeId,
       parentTryBlockId: tryBlockId,
       parameterName
     });

     // Create catch-body SCOPE
     catchScopeId = `SCOPE#catch-block#${module.file}#${getLine(tryNode.handler)}:${scopeCounterRef.value++}`;
     scopes.push({
       id: catchScopeId,
       type: 'SCOPE',
       scopeType: 'catch-block',
       // ...
       parentScopeId: catchBlockId  // Parent is CATCH_BLOCK
     });
   }

   // 4. Create FINALLY_BLOCK if finalizer exists
   let finallyBlockId: string | null = null;
   let finallyScopeId: string | null = null;
   if (tryNode.finalizer) {
     const finallyBlockCounter = finallyBlockCounterRef.value++;
     finallyBlockId = scopeTracker
       ? computeSemanticId('FINALLY_BLOCK', 'finally', scopeTracker.getContext(), { discriminator: finallyBlockCounter })
       : `${module.file}:FINALLY_BLOCK:${getLine(tryNode.finalizer)}:${finallyBlockCounter}`;

     finallyBlocks.push({
       id: finallyBlockId,
       semanticId: finallyBlockId,
       type: 'FINALLY_BLOCK',
       file: module.file,
       line: getLine(tryNode.finalizer),
       column: getColumn(tryNode.finalizer),
       parentScopeId,
       parentTryBlockId: tryBlockId
     });

     // Create finally-body SCOPE
     finallyScopeId = `SCOPE#finally-block#${module.file}#${getLine(tryNode.finalizer)}:${scopeCounterRef.value++}`;
     scopes.push({
       id: finallyScopeId,
       type: 'SCOPE',
       scopeType: 'finally-block',
       // ...
       parentScopeId: finallyBlockId  // Parent is FINALLY_BLOCK
     });
   }

   // 5. Push TRY_BLOCK to scopeIdStack
   if (scopeIdStack) {
     scopeIdStack.push(tryBlockId);
   }

   // 6. Store in map
   tryScopeMap.set(tryNode, {
     tryScopeId,
     catchScopeId,
     finallyScopeId,
     currentBlock: 'try',
     tryBlockId,
     catchBlockId,
     finallyBlockId
   });
   ```

### 4.2 Update `createCatchClauseHandler()`

Existing code handles catch parameter variable creation. Update to use CATCH_BLOCK as parent:

```typescript
// Change this line:
parentScopeId: scopeInfo.catchScopeId!
// To:
parentScopeId: scopeInfo.catchBlockId ?? scopeInfo.catchScopeId!
```

---

## Phase 5: GraphBuilder Updates

### 5.1 New Buffer Methods

**Location:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

Add four new buffer methods:

```typescript
// ============= LOOP BUFFERING =============

/**
 * Buffer LOOP nodes and edges (HAS_BODY, ITERATES_OVER)
 */
private bufferLoopNodes(
  loops: LoopInfo[],
  scopes: ScopeInfo[],
  variableDeclarations: VariableDeclarationInfo[]
): void {
  for (const loop of loops) {
    // Buffer LOOP node
    this._bufferNode({
      id: loop.id,
      type: 'LOOP',
      name: loop.loopType,
      loopType: loop.loopType,
      file: loop.file,
      line: loop.line,
      column: loop.column
    } as GraphNode);

    // Parent -> CONTAINS -> LOOP
    if (loop.parentScopeId) {
      this._bufferEdge({
        type: 'CONTAINS',
        src: loop.parentScopeId,
        dst: loop.id
      });
    }

    // LOOP -> HAS_BODY -> body SCOPE
    // Find the body scope by matching parentScopeId to loop.id
    const bodyScope = scopes.find(s => s.parentScopeId === loop.id);
    if (bodyScope) {
      this._bufferEdge({
        type: 'HAS_BODY',
        src: loop.id,
        dst: bodyScope.id
      });
    }

    // LOOP -> ITERATES_OVER -> collection VARIABLE (for for-in/for-of)
    if (loop.iteratesOverName && (loop.loopType === 'for-in' || loop.loopType === 'for-of')) {
      // Find variable by name and line proximity
      const collectionVar = variableDeclarations.find(v =>
        v.name === loop.iteratesOverName &&
        v.file === loop.file
      );
      if (collectionVar) {
        this._bufferEdge({
          type: 'ITERATES_OVER',
          src: loop.id,
          dst: collectionVar.id
        });
      }
    }
  }
}

// ============= TRY/CATCH/FINALLY BUFFERING =============

/**
 * Buffer TRY_BLOCK nodes and HAS_CATCH, HAS_FINALLY edges
 */
private bufferTryBlockNodes(
  tryBlocks: TryBlockInfo[],
  catchBlocks: CatchBlockInfo[],
  finallyBlocks: FinallyBlockInfo[]
): void {
  for (const tryBlock of tryBlocks) {
    // Buffer TRY_BLOCK node
    this._bufferNode({
      id: tryBlock.id,
      type: 'TRY_BLOCK',
      name: 'try',
      file: tryBlock.file,
      line: tryBlock.line,
      column: tryBlock.column
    } as GraphNode);

    // Parent -> CONTAINS -> TRY_BLOCK
    if (tryBlock.parentScopeId) {
      this._bufferEdge({
        type: 'CONTAINS',
        src: tryBlock.parentScopeId,
        dst: tryBlock.id
      });
    }
  }
}

/**
 * Buffer CATCH_BLOCK nodes and HAS_CATCH edges
 */
private bufferCatchBlockNodes(catchBlocks: CatchBlockInfo[]): void {
  for (const catchBlock of catchBlocks) {
    // Buffer CATCH_BLOCK node
    this._bufferNode({
      id: catchBlock.id,
      type: 'CATCH_BLOCK',
      name: catchBlock.parameterName || 'catch',
      parameterName: catchBlock.parameterName,
      file: catchBlock.file,
      line: catchBlock.line,
      column: catchBlock.column
    } as GraphNode);

    // TRY_BLOCK -> HAS_CATCH -> CATCH_BLOCK
    this._bufferEdge({
      type: 'HAS_CATCH',
      src: catchBlock.parentTryBlockId,
      dst: catchBlock.id
    });
  }
}

/**
 * Buffer FINALLY_BLOCK nodes and HAS_FINALLY edges
 */
private bufferFinallyBlockNodes(finallyBlocks: FinallyBlockInfo[]): void {
  for (const finallyBlock of finallyBlocks) {
    // Buffer FINALLY_BLOCK node
    this._bufferNode({
      id: finallyBlock.id,
      type: 'FINALLY_BLOCK',
      name: 'finally',
      file: finallyBlock.file,
      line: finallyBlock.line,
      column: finallyBlock.column
    } as GraphNode);

    // TRY_BLOCK -> HAS_FINALLY -> FINALLY_BLOCK
    this._bufferEdge({
      type: 'HAS_FINALLY',
      src: finallyBlock.parentTryBlockId,
      dst: finallyBlock.id
    });
  }
}
```

### 5.2 Update `bufferBranchEdges()` for If Statements

Extend existing method to handle both switch and if branches:

```typescript
private bufferBranchEdges(branches: BranchInfo[], callSites: CallSiteInfo[], scopes: ScopeInfo[]): void {
  for (const branch of branches) {
    // Parent SCOPE -> CONTAINS -> BRANCH
    if (branch.parentScopeId) {
      this._bufferEdge({
        type: 'CONTAINS',
        src: branch.parentScopeId,
        dst: branch.id
      });
    }

    // BRANCH -> HAS_CONDITION -> EXPRESSION
    if (branch.discriminantExpressionId) {
      // (existing code for looking up call sites, etc.)
      // ...
      this._bufferEdge({
        type: 'HAS_CONDITION',
        src: branch.id,
        dst: actualExpressionId
      });
    }

    // NEW: For if-branches, create HAS_CONSEQUENT and HAS_ALTERNATE edges
    if (branch.branchType === 'if') {
      // Find consequent (if-body) scope - parentScopeId matches branch.id, scopeType is 'if_statement'
      const consequentScope = scopes.find(s =>
        s.parentScopeId === branch.id && s.scopeType === 'if_statement'
      );
      if (consequentScope) {
        this._bufferEdge({
          type: 'HAS_CONSEQUENT',
          src: branch.id,
          dst: consequentScope.id
        });
      }

      // Find alternate (else-body) scope - parentScopeId matches branch.id, scopeType is 'else_statement'
      const alternateScope = scopes.find(s =>
        s.parentScopeId === branch.id && s.scopeType === 'else_statement'
      );
      if (alternateScope) {
        this._bufferEdge({
          type: 'HAS_ALTERNATE',
          src: branch.id,
          dst: alternateScope.id
        });
      }
    }
  }
}
```

### 5.3 Update `buildFromCollections()` Call Order

Add calls to new buffer methods in `buildFromCollections()`:

```typescript
async buildFromCollections(
  module: ModuleNode,
  collections: ASTCollections,
  graph?: GraphBackend
): Promise<BuildResult> {
  // ... existing code ...

  // Extract new collections with defaults
  const loops = (collections.loops ?? []) as LoopInfo[];
  const tryBlocks = (collections.tryBlocks ?? []) as TryBlockInfo[];
  const catchBlocks = (collections.catchBlocks ?? []) as CatchBlockInfo[];
  const finallyBlocks = (collections.finallyBlocks ?? []) as FinallyBlockInfo[];

  // ... existing buffering ...

  // Buffer control flow nodes (NEW - insert after scope edges, before branch edges)
  // 6.3. Buffer LOOP nodes
  this.bufferLoopNodes(loops, scopes, variableDeclarations);

  // 6.4. Buffer TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK nodes
  this.bufferTryBlockNodes(tryBlocks, catchBlocks, finallyBlocks);
  this.bufferCatchBlockNodes(catchBlocks);
  this.bufferFinallyBlockNodes(finallyBlocks);

  // 6.5. Buffer edges for BRANCH (updated to include scopes for if-branches)
  this.bufferBranchEdges(branches, callSites, scopes);

  // ... rest of existing code ...
}
```

---

## Phase 6: Function Metadata (Cyclomatic Complexity)

### 6.1 Add ControlFlowMetadata to FunctionInfo

Update `FunctionInfo` interface in `packages/core/src/plugins/analysis/ast/types.ts`:

```typescript
export interface FunctionInfo {
  // ... existing fields ...

  // Control flow metadata (Phase 6)
  controlFlow?: ControlFlowMetadata;
}
```

### 6.2 Add Complexity Counter to `analyzeFunctionBody()`

**Location:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`, `analyzeFunctionBody()` method

Add complexity tracking state:

```typescript
analyzeFunctionBody(
  funcPath: NodePath<t.Function>,
  parentScopeId: string,
  module: VisitorModule,
  collections: VisitorCollections
): void {
  // ... existing extraction code ...

  // NEW: Control flow tracking
  const controlFlowState = {
    branchCount: 0,       // if/switch
    loopCount: 0,         // for/while/do-while
    caseCount: 0,         // switch cases (excluding default)
    logicalOpCount: 0,    // && and || in conditions
    hasTryCatch: false,
    hasEarlyReturn: false,
    hasThrow: false
  };
```

### 6.3 Update Handlers to Track Complexity

Modify each handler to increment counters:

**IfStatement handler:**
```typescript
// In createIfStatementHandler enter():
controlFlowState.branchCount++;

// Also count logical operators in condition
controlFlowState.logicalOpCount += this.countLogicalOperators(ifNode.test);
```

**SwitchStatement handler:**
```typescript
// In handleSwitchStatement:
controlFlowState.branchCount++;

// Count non-default cases
for (const caseNode of switchNode.cases) {
  if (caseNode.test !== null) {  // Not default
    controlFlowState.caseCount++;
  }
}
```

**Loop handlers:**
```typescript
// In createLoopScopeHandler enter():
controlFlowState.loopCount++;

// For for-loops with condition, count logical operators
if (loopType === 'for' || loopType === 'while') {
  const testNode = (node as t.ForStatement | t.WhileStatement).test;
  if (testNode) {
    controlFlowState.logicalOpCount += this.countLogicalOperators(testNode);
  }
}
```

**TryStatement handler:**
```typescript
// In createTryStatementHandler enter():
controlFlowState.hasTryCatch = true;
```

**ReturnStatement handler:**
```typescript
// In ReturnStatement handler:
// If not the last statement in function body, it's an early return
const isLastStatement = /* check if this is last statement */;
if (!isLastStatement) {
  controlFlowState.hasEarlyReturn = true;
}
```

**ThrowStatement handler:**
```typescript
// Add new visitor:
ThrowStatement: () => {
  controlFlowState.hasThrow = true;
}
```

### 6.4 Add Helper Method for Logical Operators

```typescript
/**
 * Count logical operators (&& and ||) in an expression for complexity calculation
 */
private countLogicalOperators(node: t.Expression): number {
  let count = 0;

  const traverse = (n: t.Node) => {
    if (t.isLogicalExpression(n)) {
      if (n.operator === '&&' || n.operator === '||') {
        count++;
      }
      traverse(n.left);
      traverse(n.right);
    } else if (t.isBinaryExpression(n)) {
      traverse(n.left);
      traverse(n.right);
    } else if (t.isConditionalExpression(n)) {
      // Ternary: count the ternary itself plus any nested operators
      count++;
      traverse(n.test);
      traverse(n.consequent);
      traverse(n.alternate);
    }
  };

  traverse(node);
  return count;
}
```

### 6.5 Attach Metadata to Function Node

At the end of `analyzeFunctionBody()`:

```typescript
// After traversal completes, calculate and attach control flow metadata
if (currentFunctionId && matchingFunction) {
  // Calculate cyclomatic complexity: M = E - N + 2P
  // Simplified: M = 1 + branches + cases + loops + logicalOps
  const cyclomaticComplexity = 1
    + controlFlowState.branchCount
    + controlFlowState.caseCount
    + controlFlowState.loopCount
    + controlFlowState.logicalOpCount;

  matchingFunction.controlFlow = {
    hasBranches: controlFlowState.branchCount > 0,
    hasLoops: controlFlowState.loopCount > 0,
    hasTryCatch: controlFlowState.hasTryCatch,
    hasEarlyReturn: controlFlowState.hasEarlyReturn,
    hasThrow: controlFlowState.hasThrow,
    cyclomaticComplexity
  };
}
```

### 6.6 Update GraphBuilder to Include Metadata

In `bufferFunctionEdges()`, ensure metadata is included:

```typescript
private bufferFunctionEdges(module: ModuleNode, functions: FunctionInfo[]): void {
  for (const func of functions) {
    const { parentScopeId, controlFlow, ...funcData } = func;

    // Include controlFlow in node metadata
    if (controlFlow) {
      (funcData as GraphNode).metadata = {
        ...(funcData as GraphNode).metadata,
        controlFlow
      };
    }

    // ... existing edge buffering ...
  }
}
```

---

## Test Scenarios

### Phase 1: Types
- Compile TypeScript without errors
- Export new types correctly

### Phase 2: Loops
```javascript
// Test: for-of loop
const items = [1, 2, 3];
for (const item of items) {
  console.log(item);
}
// Expected: LOOP(for-of) -> HAS_BODY -> SCOPE
// Expected: LOOP(for-of) -> ITERATES_OVER -> VARIABLE(items)

// Test: nested loops
for (let i = 0; i < 10; i++) {
  for (let j = 0; j < 10; j++) {
    // ...
  }
}
// Expected: LOOP(for) contains LOOP(for)
```

### Phase 3: If Statements
```javascript
// Test: if/else
if (condition) {
  doA();
} else {
  doB();
}
// Expected: BRANCH(if) -> HAS_CONDITION -> EXPRESSION
// Expected: BRANCH(if) -> HAS_CONSEQUENT -> SCOPE(if)
// Expected: BRANCH(if) -> HAS_ALTERNATE -> SCOPE(else)

// Test: else-if chain
if (a) {
  // ...
} else if (b) {
  // ...
} else {
  // ...
}
// Expected: Two BRANCH nodes, second is child of first's alternate
```

### Phase 4: Try/Catch/Finally
```javascript
// Test: try/catch/finally
try {
  riskyOperation();
} catch (e) {
  handleError(e);
} finally {
  cleanup();
}
// Expected: TRY_BLOCK -> HAS_CATCH -> CATCH_BLOCK
// Expected: TRY_BLOCK -> HAS_FINALLY -> FINALLY_BLOCK
// Expected: CATCH_BLOCK has parameterName: 'e'
```

### Phase 5: GraphBuilder
- All edges created correctly
- No duplicate edges
- Node IDs match across references

### Phase 6: Function Metadata
```javascript
// Test: complexity calculation
function complex(x) {
  if (x > 0 && x < 10) {  // +1 branch, +1 logical
    for (let i = 0; i < x; i++) {  // +1 loop
      if (i % 2 === 0) {  // +1 branch
        return i;  // early return
      }
    }
  }
  return -1;
}
// Expected: cyclomaticComplexity = 1 + 2 + 1 + 1 = 5
// Expected: hasBranches = true, hasLoops = true, hasEarlyReturn = true
```

---

## Implementation Order

1. **Phase 1** - Types (prerequisite for all others)
2. **Phase 2** - Loops (builds on existing REG-272 work)
3. **Phase 4** - Try/Catch/Finally (straightforward migration)
4. **Phase 3** - If Statements (extends existing handler)
5. **Phase 5** - GraphBuilder (after all node types exist)
6. **Phase 6** - Function Metadata (depends on all handlers being updated)

Each phase should include its own tests before proceeding to the next.

---

## Files to Modify

| File | Changes |
|------|---------|
| `packages/types/src/nodes.ts` | Add LOOP, TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK types and interfaces |
| `packages/types/src/edges.ts` | Add HAS_BODY, ITERATES_OVER, HAS_CONSEQUENT, HAS_ALTERNATE, HAS_CATCH, HAS_FINALLY |
| `packages/core/src/plugins/analysis/ast/types.ts` | Add LoopInfo, TryBlockInfo, CatchBlockInfo, FinallyBlockInfo, ControlFlowMetadata interfaces; Update ASTCollections |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Update createLoopScopeHandler, createTryStatementHandler, createIfStatementHandler; Add complexity tracking |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Add bufferLoopNodes, bufferTryBlockNodes, bufferCatchBlockNodes, bufferFinallyBlockNodes; Update bufferBranchEdges |

---

*"The best thing about a specification is that it tells you what to build. The worst thing is that it tells you what NOT to build."*

This spec is designed to be implementable in phases, testable at each step, and backward compatible with existing SCOPE-based queries.
