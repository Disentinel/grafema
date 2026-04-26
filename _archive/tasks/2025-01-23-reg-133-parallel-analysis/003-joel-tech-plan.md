# Joel's Technical Specification: REG-133 Parallel Analysis Implementation

**Author:** Joel Spolsky (Implementation Planner)

## Executive Summary

This specification details the migration of `ASTWorker.ts` from legacy line-based IDs to the semantic ID system via node factories and `ScopeTracker`, enabling proper parallel analysis in Grafema.

---

## Phase 1: Fix ASTWorker to Return Raw Data (Critical Path)

### 1.1 Problem Analysis

**Current State (`ASTWorker.ts`):**
```typescript
// LEGACY: Workers generate IDs inline
const varId = shouldBeConstant
  ? `CONSTANT#${varName}#${filePath}#${line}:${column}:${counters.varDecl++}`
  : `VARIABLE#${varName}#${filePath}#${line}:${column}:${counters.varDecl++}`;

const functionId = `FUNCTION#${funcName}#${filePath}#${node.loc!.start.line}`;
```

**Semantic ID System (main thread, `FunctionVisitor.ts`):**
```typescript
// SEMANTIC: Uses ScopeTracker context
const functionId = scopeTracker
  ? computeSemanticId('FUNCTION', node.id.name, scopeTracker.getContext())
  : legacyId;
```

### 1.2 Solution Architecture

**Key Insight:** Workers should return **raw extracted data** (names, locations, relationships), not IDs. The main thread generates semantic IDs using `ScopeTracker`.

```
Workers: Parse AST -> Extract raw collections (name, line, column, relationships)
Main:    ScopeTracker + SemanticId + GraphBuilder -> Graph writes
```

### 1.3 New Data Structures

**File:** `/packages/core/src/core/ASTWorker.ts`

Replace ID-containing interfaces with raw data interfaces:

```typescript
// === NEW: Raw extraction interfaces (no IDs) ===

/**
 * Raw function data extracted from AST
 * Main thread will generate semantic ID
 */
export interface RawFunctionData {
  name: string;
  file: string;
  line: number;
  column: number;
  async: boolean;
  generator?: boolean;
  exported?: boolean;
  isClassMethod?: boolean;
  className?: string;          // For methods: which class
  isConstructor?: boolean;
  isStatic?: boolean;
  params: string[];            // Parameter names for PARAMETER nodes
}

/**
 * Raw variable declaration data
 */
export interface RawVariableData {
  name: string;
  file: string;
  line: number;
  column: number;
  isConstant: boolean;
  value?: unknown;             // For literals
  scopePath: string[];         // ['outer', 'if#0'] - for main thread ScopeTracker
}

/**
 * Raw class declaration data
 */
export interface RawClassData {
  name: string;
  file: string;
  line: number;
  column: number;
  superClass?: string;
  exported?: boolean;
  methodNames: string[];       // Just names, methods extracted separately
}

/**
 * Raw call site data
 */
export interface RawCallSiteData {
  name: string;
  file: string;
  line: number;
  column: number;
  targetFunctionName?: string;
  object?: string;             // For method calls: obj.method()
  method?: string;
  scopePath: string[];         // Scope at call site
}

/**
 * Raw collections (no IDs)
 */
export interface RawASTCollections {
  functions: RawFunctionData[];
  variables: RawVariableData[];
  classes: RawClassData[];
  callSites: RawCallSiteData[];
  imports: ImportNodeRecord[];   // Keep using factory (already correct)
  exports: ExportNodeRecord[];   // Keep using factory (already correct)
}
```

### 1.4 Worker Changes

**File:** `/packages/core/src/core/ASTWorker.ts`

**Change 1: Track scope path during traversal**

```typescript
// === ADD: Scope tracking in worker (lightweight, no ID generation) ===

interface WorkerScopeStack {
  path: string[];  // ['MyClass', 'myMethod', 'if#0']
  counters: Map<string, number>;  // for if#N, for#N etc.
}

function createScopeStack(): WorkerScopeStack {
  return { path: [], counters: new Map() };
}

function enterNamedScope(stack: WorkerScopeStack, name: string): void {
  stack.path.push(name);
}

function enterCountedScope(stack: WorkerScopeStack, type: string): string {
  const key = stack.path.join('/') + '/' + type;
  const n = stack.counters.get(key) || 0;
  stack.counters.set(key, n + 1);
  const name = `${type}#${n}`;
  stack.path.push(name);
  return name;
}

function exitScope(stack: WorkerScopeStack): void {
  stack.path.pop();
}

function getScopePath(stack: WorkerScopeStack): string[] {
  return [...stack.path];
}
```

**Change 2: Replace parseModule function to return raw data**

Workers extract raw information (names, locations, scope paths) without generating IDs. Main thread reconstructs semantic IDs using ScopeTracker.

### 1.5 Main Thread Processing

**File:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

Add new method `processWorkerCollections()` that:
1. Takes raw collections from worker
2. Uses ScopeTracker to generate semantic IDs
3. Populates proper Collections for GraphBuilder

Key processing order:
1. Classes first (define scopes for methods)
2. Functions (including methods with class scope)
3. Variables (with scope path reconstruction)
4. Call sites (with scope path reconstruction)
5. Imports/exports (already have correct IDs from factories)

---

## Phase 2: Enable Parallel Mode in JSASTAnalyzer

### 2.1 Add Parallel Analysis Option

```typescript
interface AnalyzeContext extends PluginContext {
  manifest?: AnalysisManifest;
  forceAnalysis?: boolean;
  workerCount?: number;
  parallelParsing?: boolean;  // NEW: Enable ASTWorkerPool for parsing
  onProgress?: (info: Record<string, unknown>) => void;
}
```

### 2.2 Add Parallel Execution Path

```typescript
async execute(context: AnalyzeContext): Promise<PluginResult> {
  // ... existing code to get modulesToAnalyze ...

  if (context.parallelParsing && modulesToAnalyze.length > 10) {
    return this.executeParallel(modulesToAnalyze, graph, projectPath, context);
  }

  // ... existing sequential code ...
}
```

New `executeParallel()` method:
1. Create `ASTWorkerPool` with configured worker count
2. Parse all modules in parallel via workers
3. Process results sequentially (semantic ID generation)
4. Build graph for each module

---

## Phase 3: Cleanup Dead Code

### Files to Remove

| File | Reason |
|------|--------|
| `/packages/core/src/core/AnalysisWorker.ts` | Writes directly to RFDB with legacy IDs |
| `/packages/core/src/core/QueueWorker.ts` | Queue-based execution, legacy IDs |
| `/packages/core/src/core/ParallelAnalyzer.ts` | Uses AnalysisWorker, not exported |
| `/packages/core/src/core/AnalysisQueue.ts` | Part of dead queue system |

### Update Exports

**File:** `/packages/core/src/index.ts`

```typescript
// ADD (after Phase 2):
export { ASTWorkerPool } from './core/ASTWorkerPool.js';
export type { ASTWorkerPoolStats, ModuleInfo, ParseResult } from './core/ASTWorkerPool.js';
```

---

## Phase 4: Export and Document

- Export raw collection types for external use
- Add JSDoc documentation to `ASTWorkerPool`
- Document when to use parallel vs sequential mode

---

## Test Strategy

### Unit Tests
- `ASTWorker` returns raw collections without ID fields
- Scope path tracking works for nested elements

### Integration Tests
- **Parity test:** Parallel mode produces identical semantic IDs to sequential mode
- Multiple files with same structure produce deterministic IDs

### Benchmark Tests
- Parallel should be 20%+ faster for 100+ files

---

## Acceptance Criteria

### Phase 1 (Critical)
- [ ] `ASTWorker` returns `RawASTCollections` without ID fields
- [ ] Raw collections include `scopePath` for nested elements
- [ ] `processWorkerCollections` generates semantic IDs matching sequential mode
- [ ] Existing `ImportNode`/`ExportNode` factory usage unchanged

### Phase 2
- [ ] `parallelParsing: true` option works in `JSASTAnalyzer`
- [ ] Parallel mode produces identical graph to sequential mode
- [ ] Worker pool properly initialized and terminated

### Phase 3
- [ ] Dead code files removed
- [ ] No broken imports
- [ ] Test suite still passes

### Phase 4
- [ ] `ASTWorkerPool` exported from `@grafema/core`
- [ ] Types exported for external consumers
- [ ] Documentation complete

---

## Risk Mitigation

### Scope Path Reconstruction
Risk: Counters for `if#N` may differ between worker and main thread.

Mitigation: Worker passes scope path with counter already applied. Main thread uses `enterCountedScope()` which will produce same `#N` values because it uses same counter logic.

### Memory Pressure
Risk: Many raw collections in flight for large codebases.

Mitigation: Process results immediately after each worker completes, don't wait for all.

### Error Handling
Risk: Worker crash loses parsed data.

Mitigation: Worker pool already handles errors per-task. Failed files are logged and skipped.

---

## Critical Files for Implementation

- `/packages/core/src/core/ASTWorker.ts` - Primary file to migrate to raw collections
- `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Add `processWorkerCollections()` and parallel mode
- `/packages/core/src/core/ScopeTracker.ts` - Reference for scope tracking pattern
- `/packages/core/src/core/ASTWorkerPool.ts` - Worker orchestration
- `/packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts` - Pattern to follow for semantic ID generation
