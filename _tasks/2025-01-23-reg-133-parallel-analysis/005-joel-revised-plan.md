# Joel's Revised Technical Specification: REG-133 Parallel Analysis Implementation

**Author:** Joel Spolsky (Implementation Planner)
**Revision:** 2 - Addressing Linus's review feedback
**Date:** 2025-01-23

## Executive Summary

This revision addresses Linus's critical feedback about the scope path reconstruction approach. The key change: **Workers will use `ScopeTracker` directly** to generate final semantic IDs, not raw data that gets reconstructed on the main thread.

This is architecturally sound because ScopeTracker is file-scoped - each worker gets a fresh instance per file with no cross-file state.

---

## Architectural Overview

```
BEFORE (flawed proposal):
Workers: Parse AST -> Extract raw data with scopePath strings
Main:    Reconstruct ScopeTracker state -> Generate IDs -> GraphBuilder
         ^ BROKEN - can't reconstruct state from strings

AFTER (correct architecture):
Workers: Parse AST -> ScopeTracker.enterScope/exitScope -> computeSemanticId -> Return Collections
Main:    Merge Collections -> GraphBuilder -> Graph writes
         ^ Simple aggregation, no reconstruction needed
```

**Why this works:**
1. `ScopeTracker` is file-scoped (constructor takes `file: string`)
2. Each worker processes one file at a time with its own `ScopeTracker` instance
3. Workers produce final `Collections` with semantic IDs already computed
4. Main thread just aggregates and passes to `GraphBuilder`
5. One implementation, one source of truth - no divergence risk

---

## Phase 1: Migrate ASTWorker to Use ScopeTracker (Critical Path)

### 1.1 What Currently Exists

**File:** `/packages/core/src/core/ASTWorker.ts`

Current state:
- Uses inline legacy ID generation: `FUNCTION#${funcName}#${filePath}#${line}:${column}`
- Has its own `Counters` interface (ifScope, scope, varDecl, etc.)
- Does NOT use `ScopeTracker` or `computeSemanticId`
- Returns `ASTCollections` with IDs already baked in (legacy format)

### 1.2 Required Changes

**Import ScopeTracker and SemanticId:**

```typescript
// ADD to imports
import { ScopeTracker } from './ScopeTracker.js';
import { computeSemanticId } from './SemanticId.js';
import { basename } from 'path';
```

**Replace parseModule function:**

1. Create a `ScopeTracker` instance for the file
2. Use visitors pattern similar to `JSASTAnalyzer.analyzeModule()`
3. Track scope enter/exit during traversal
4. Generate semantic IDs via `computeSemanticId()`

**Key implementation pattern (following `FunctionVisitor.ts`):**

```typescript
function parseModule(filePath: string, moduleId: string, moduleName: string): ASTCollections {
  const code = readFileSync(filePath, 'utf-8');
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });

  // Create ScopeTracker - uses basename for shorter IDs
  const scopeTracker = new ScopeTracker(basename(filePath));

  // ... traverse with scope tracking, generate semantic IDs ...
}
```

### 1.3 Scope Tracking During Traversal

For nested scopes (if, for, try, etc.), use `enterCountedScope`:

```typescript
IfStatement(path) {
  scopeTracker.enterCountedScope('if');  // Returns { name: 'if#0', discriminator: 0 }

  path.get('consequent').traverse(/* ... */);

  scopeTracker.exitScope();
}
```

### 1.4 Variable Declarations with Proper Scope

```typescript
VariableDeclaration(path) {
  // Semantic ID includes current scope context
  const varId = computeSemanticId(nodeType, varName, scopeTracker.getContext());

  collections.variableDeclarations.push({
    id: varId,
    type: nodeType,
    name: varName,
    // ...
  });
}
```

### 1.5 Call Sites with Discriminators

```typescript
CallExpression(path) {
  // Get discriminator for same-named calls in current scope
  const discriminator = scopeTracker.getItemCounter(`CALL:${calleeName}`);

  const callId = computeSemanticId('CALL', calleeName, scopeTracker.getContext(), { discriminator });
}
```

### 1.6 Class Methods with Class Scope

```typescript
ClassDeclaration(path) {
  // Enter class scope
  scopeTracker.enterScope(className, 'CLASS');

  // Method ID includes class scope: file->ClassName->FUNCTION->methodName
  const methodId = computeSemanticId('FUNCTION', methodName, scopeTracker.getContext());

  // Exit class scope
  scopeTracker.exitScope();
}
```

---

## Phase 2: Fix Import/Export Semantic IDs

### 2.1 Current State

- `ImportNode.create()` - Already uses semantic IDs (no line number)
- `ExportNode.create()` - Still uses line-based IDs
- `ExportNode.createWithContext()` - Exists and uses semantic IDs

### 2.2 Migration in ASTWorker

For Exports, use `createWithContext`:

```typescript
// Use createWithContext for semantic IDs
const exportNode = ExportNode.createWithContext(
  name,
  scopeTracker.getContext(),
  { line, column },
  { exportType: 'named' }
);
```

---

## Phase 3: Update ASTWorkerPool Interface

### 3.1 Integration with JSASTAnalyzer

Add parallel execution path:

```typescript
interface AnalyzeContext extends PluginContext {
  parallelParsing?: boolean;  // NEW: Enable ASTWorkerPool
  workerCount?: number;
}

async execute(context: AnalyzeContext): Promise<PluginResult> {
  if (context.parallelParsing && modulesToAnalyze.length > PARALLEL_THRESHOLD) {
    return this.executeParallel(modulesToAnalyze, graph, projectPath, context);
  }
  // ... existing sequential code ...
}

private async executeParallel(modules, graph, projectPath, context): Promise<PluginResult> {
  const pool = new ASTWorkerPool(context.workerCount || 4);
  await pool.init();

  const results = await pool.parseModules(modules);

  // Collections already have semantic IDs - pass directly to GraphBuilder
  for (const result of results) {
    await this.graphBuilder.build(module, graph, projectPath, result.collections);
  }

  await pool.terminate();
}
```

---

## Phase 4: Remove Dead Code (COMMITTED)

### 4.1 Files to DELETE

| File | Reason |
|------|--------|
| `/packages/core/src/core/AnalysisWorker.ts` | Legacy worker with line-based IDs |
| `/packages/core/src/core/QueueWorker.ts` | Queue-based worker, legacy pattern |
| `/packages/core/src/core/ParallelAnalyzer.ts` | Uses AnalysisWorker, dead code |

### 4.2 AnalysisQueue Decision

Keep `AnalysisQueue` for now (still used by `Orchestrator`). Mark as separate tech debt item.

### 4.3 Update Exports

```typescript
// ADD to @grafema/core exports:
export { ASTWorkerPool } from './core/ASTWorkerPool.js';
```

---

## Test Strategy

### Unit Tests

1. **Scope tracking verification:**
```javascript
// Test nested scopes produce correct semantic IDs
const code = `
function outer() {
  if (cond1) { /* if#0 */ }
  if (cond2) {
    const x = 1;  // Should be: file->outer->if#1->CONSTANT->x
  }
}
`;
expect(xVar.id).toMatch(/->outer->if#1->CONSTANT->x$/);
```

2. **Class method scope:**
```javascript
// y should be: file->MyClass->myMethod->CONSTANT->y
```

3. **Call discriminators:**
```javascript
// bar() called twice: CALL->bar#0, CALL->bar#1
```

### Integration Tests (Parity Test)

**Critical test case from Linus's review:**

```javascript
const testCode = `
function outer() {
  if (a) { if (b) { const x = 1; } }  // x has specific ID
  if (c) { const y = 2; }             // y has different specific ID
}
`;

test('parallel and sequential produce identical semantic IDs', async () => {
  const sequentialResult = await runSequentialAnalysis(testCode);
  const parallelResult = await runParallelAnalysis(testCode);

  expect(parallelResult.variables).toEqual(sequentialResult.variables);
});
```

---

## Acceptance Criteria

### Phase 1 (Critical)
- [ ] `ASTWorker` uses `ScopeTracker` directly (not scope path strings)
- [ ] `ASTWorker` uses `computeSemanticId()` for all ID generation
- [ ] Scope enter/exit matches traversal order exactly
- [ ] Counted scopes (if#N, for#N) increment correctly
- [ ] Class methods have class in scope path

### Phase 2
- [ ] `ExportNode` uses `createWithContext()` in `ASTWorker`
- [ ] All node types produce semantic IDs (no line numbers in IDs)

### Phase 3
- [ ] `parallelParsing: true` option works in `JSASTAnalyzer`
- [ ] Parity test passes (parallel == sequential)
- [ ] `ASTWorkerPool` exported from `@grafema/core`

### Phase 4
- [ ] `AnalysisWorker.ts` deleted
- [ ] `QueueWorker.ts` deleted
- [ ] `ParallelAnalyzer.ts` deleted
- [ ] No broken imports
- [ ] All tests pass

---

## Implementation Order

1. **Phase 1.1-1.6:** Migrate `ASTWorker.ts` to use `ScopeTracker`
2. **Phase 2:** Fix `ExportNode` semantic IDs in `ASTWorker`
3. **Write parity test** before Phase 3 (TDD)
4. **Phase 3:** Add `executeParallel()` to `JSASTAnalyzer`
5. **Phase 4:** Delete dead code files
6. **Update exports** in `index.ts`

---

## Critical Files for Implementation

- `/packages/core/src/core/ASTWorker.ts` - Primary file to migrate
- `/packages/core/src/core/ScopeTracker.ts` - API reference (enterScope, exitScope, enterCountedScope, getContext, getItemCounter)
- `/packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts` - Pattern to follow
- `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Add executeParallel method
- `/packages/core/src/core/nodes/ExportNode.ts` - Use createWithContext
