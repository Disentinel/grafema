# Joel Spolsky - Full Scope Implementation Specification for REG-311

## Overview

This specification details the **NEW features** not covered in 007-joel-expanded-spec.md:

1. **Variable Rejection Micro-Trace** (Analysis Phase)
2. **isAwaited / isInsideTry Detection** (Analysis Phase)
3. **CATCHES_FROM Edges** (Analysis Phase + Type Definition)
4. **RejectionPropagationEnricher** (Enrichment Phase)

All features follow the forward registration pattern (analyzer marks data, stores in metadata) rather than backward pattern scanning.

---

## Part 1: Variable Rejection Micro-Trace

### 1.1 Problem Statement

The current plan only tracks rejection patterns where error is directly constructed:
```javascript
reject(new ValidationError('fail'));  // TRACKED
throw new Error('fail');              // TRACKED (in async function)
```

NOT tracked:
```javascript
const err = new ValidationError('bad');
reject(err);  // Variable, NOT tracked

async function rethrow(e) {
  throw e;  // Parameter forwarding, NOT tracked
}
```

### 1.2 Type Definitions

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

**Location:** After RejectionPatternInfo (from 007 spec)

```typescript
// === REJECTION PATTERN INFO (REG-311) Extended ===
export interface RejectionPatternInfo {
  /** ID of the containing FUNCTION node */
  functionId: string;
  /** Error class name (e.g., 'Error', 'ValidationError') - may be null for unresolved variables */
  errorClassName: string | null;
  /** Rejection pattern type */
  rejectionType:
    | 'promise_reject'     // Promise.reject(new Error())
    | 'executor_reject'    // reject(new Error()) in Promise executor
    | 'async_throw'        // throw new Error() in async function
    | 'variable_traced'    // NEW: reject(err) where err traced to NewExpression
    | 'variable_parameter' // NEW: reject(param) where param is function parameter
    | 'variable_unknown';  // NEW: reject(x) where x couldn't be traced
  /** File path */
  file: string;
  /** Line number of rejection call */
  line: number;
  /** Column number */
  column: number;
  /** NEW: Source variable name (for variable_* types) */
  sourceVariableName?: string;
  /** NEW: Trace path for debugging (e.g., "err -> error -> new ValidationError") */
  tracePath?: string[];
}
```

**Complexity:** O(1) - type definition only

### 1.3 Micro-Trace Implementation

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**New private method:** Add after `handleCallExpression` method

```typescript
/**
 * Micro-trace: follow ASSIGNED_FROM within current function to find error source.
 * Bounded depth (max 3) for performance during analysis phase.
 *
 * REG-311: Used to resolve reject(err) where err is a variable.
 *
 * @param variableName - Name of variable to trace
 * @param variableDeclarations - Variable declarations in current scope
 * @param funcPath - NodePath of containing function
 * @returns ErrorClassName if traced to NewExpression, null otherwise
 */
private microTraceToErrorClass(
  variableName: string,
  variableDeclarations: VariableDeclarationInfo[],
  funcPath: NodePath<t.Function>,
  maxDepth: number = 3
): { errorClassName: string | null; tracePath: string[] } {
  const tracePath: string[] = [variableName];
  let currentName = variableName;
  let depth = 0;

  const funcBody = funcPath.node.body;
  if (!t.isBlockStatement(funcBody)) {
    return { errorClassName: null, tracePath };
  }

  while (depth < maxDepth) {
    depth++;
    let found = false;

    // Walk AST to find assignments: currentName = newValue
    funcPath.traverse({
      VariableDeclarator: (declPath: NodePath<t.VariableDeclarator>) => {
        if (found) return;
        if (t.isIdentifier(declPath.node.id) && declPath.node.id.name === currentName) {
          const init = declPath.node.init;
          if (init) {
            // Case 1: const err = new Error()
            if (t.isNewExpression(init) && t.isIdentifier(init.callee)) {
              tracePath.push(`new ${init.callee.name}()`);
              currentName = init.callee.name;
              found = true;
              return;
            }
            // Case 2: const err = otherVar (chain)
            if (t.isIdentifier(init)) {
              tracePath.push(init.name);
              currentName = init.name;
              found = true;
              return;
            }
          }
        }
      },
      AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
        if (found) return;
        const left = assignPath.node.left;
        const right = assignPath.node.right;

        if (t.isIdentifier(left) && left.name === currentName) {
          if (t.isNewExpression(right) && t.isIdentifier(right.callee)) {
            tracePath.push(`new ${right.callee.name}()`);
            currentName = right.callee.name;
            found = true;
            return;
          }
          if (t.isIdentifier(right)) {
            tracePath.push(right.name);
            currentName = right.name;
            found = true;
            return;
          }
        }
      }
    });

    // If we found a NewExpression, return the class name
    if (tracePath[tracePath.length - 1].startsWith('new ')) {
      const match = tracePath[tracePath.length - 1].match(/^new (.+)\(\)$/);
      if (match) {
        return { errorClassName: match[1], tracePath };
      }
    }

    if (!found) break;
  }

  return { errorClassName: null, tracePath };
}
```

**Complexity:** O(d * n) where d = max depth (3), n = statements in function body. Bounded by maxDepth.

### 1.4 Integration into ThrowStatement Handler

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

Extend ThrowStatement handler to handle `throw identifier`:

```typescript
// In ThrowStatement handler, AFTER checking for NewExpression:

// REG-311 Extended: Handle throw identifier (variable)
if (isAsyncFunction && t.isIdentifier(throwNode.argument)) {
  const varName = throwNode.argument.name;

  // Check if it's a parameter
  const isParameter = funcPath.node.params.some(p =>
    t.isIdentifier(p) && p.name === varName
  );

  if (isParameter) {
    // Parameter forwarding - can't resolve statically
    rejectionPatterns.push({
      functionId: currentFunctionId!,
      errorClassName: null,
      rejectionType: 'variable_parameter',
      file: module.file,
      line: getLine(throwNode),
      column: getColumn(throwNode),
      sourceVariableName: varName
    });
  } else {
    // Try micro-trace
    const { errorClassName, tracePath } = this.microTraceToErrorClass(
      varName,
      variableDeclarations,
      funcPath
    );

    rejectionPatterns.push({
      functionId: currentFunctionId!,
      errorClassName,
      rejectionType: errorClassName ? 'variable_traced' : 'variable_unknown',
      file: module.file,
      line: getLine(throwNode),
      column: getColumn(throwNode),
      sourceVariableName: varName,
      tracePath
    });
  }
}
```

---

## Part 2: isAwaited / isInsideTry Detection

### 2.1 Type Definition Changes

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

**Modify CallSiteInfo:**

```typescript
export interface CallSiteInfo {
  id: string;
  semanticId?: string;
  type: 'CALL';
  name: string;
  file: string;
  line: number;
  column?: number;
  parentScopeId?: string;
  targetFunctionName?: string;
  isNew?: boolean;
  grafemaIgnore?: GrafemaIgnoreAnnotation;
  // REG-311: Async error tracking
  isAwaited?: boolean;      // NEW: true if wrapped in await expression
  isInsideTry?: boolean;    // NEW: true if inside try block (protected)
}
```

**Complexity:** O(1) - type definitions only

### 2.2 Analysis Phase Detection

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Modify CallExpression handler:**

```typescript
CallExpression: (callPath: NodePath<t.CallExpression>) => {
  // Check if this call is wrapped in await
  const parent = callPath.parentPath;
  const isAwaited = parent?.isAwaitExpression() ?? false;

  // Check if inside try block
  const isInsideTry = this.isInsideTryBlock(getCurrentScopeId(), tryScopeMap, scopes);

  this.handleCallExpression(
    callPath.node,
    processedCallSites,
    processedMethodCalls,
    callSites,
    methodCalls,
    module,
    callSiteCounterRef,
    scopeTracker,
    getCurrentScopeId(),
    collections,
    isAwaited,
    isInsideTry
  );
}
```

**Helper method:**

```typescript
/**
 * Check if current scope is inside a try block.
 */
private isInsideTryBlock(
  currentScopeId: string,
  tryScopeMap: Map<t.TryStatement, TryScopeInfo>,
  scopes: ScopeInfo[]
): boolean {
  const tryScopeIds = new Set<string>();
  for (const [_, info] of tryScopeMap) {
    tryScopeIds.add(info.tryScopeId);
  }

  let checkScopeId: string | undefined = currentScopeId;
  const visited = new Set<string>();

  while (checkScopeId && !visited.has(checkScopeId)) {
    visited.add(checkScopeId);
    if (tryScopeIds.has(checkScopeId)) {
      return true;
    }
    const scope = scopes.find(s => s.id === checkScopeId);
    checkScopeId = scope?.parentScopeId;
  }

  return false;
}
```

**Complexity:** O(s) where s = scope chain depth (typically 3-5)

---

## Part 3: CATCHES_FROM Edge Type

### 3.1 Edge Type Definition

**File:** `packages/types/src/edges.ts`

```typescript
// Errors
THROWS: 'THROWS',

// REG-311: Async error flow
REJECTS: 'REJECTS',           // FUNCTION -> CLASS (error class it can reject)
CATCHES_FROM: 'CATCHES_FROM', // CATCH_BLOCK.parameter -> error sources in TRY_BLOCK
```

### 3.2 CatchesFromInfo Type

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

```typescript
// === CATCHES FROM INFO (REG-311) ===
/**
 * Info for CATCHES_FROM edges linking catch parameters to error sources.
 */
export interface CatchesFromInfo {
  /** ID of the CATCH_BLOCK node */
  catchBlockId: string;
  /** Name of catch parameter (e.g., 'e' in catch(e)) */
  parameterName: string;
  /** ID of source node in try block (CALL with rejection, THROW statement) */
  sourceId: string;
  /** Source type */
  sourceType: 'call_rejection' | 'throw_statement';
  /** File path */
  file: string;
  /** Line of catch block */
  line: number;
}
```

**Add to ASTCollections interface:**

```typescript
// CATCHES_FROM tracking for catch parameter error sources (REG-311)
catchesFromInfos?: CatchesFromInfo[];
```

---

## Part 4: RejectionPropagationEnricher

### 4.1 Overview

**New File:** `packages/core/src/plugins/enrichment/RejectionPropagationEnricher.ts`

This enricher:
1. Builds index of functions with REJECTS edges
2. For each async function, finds awaited calls NOT inside try/catch
3. Propagates callee's REJECTS edges to caller
4. Iterates until fixpoint (transitive propagation)

### 4.2 Implementation

```typescript
/**
 * RejectionPropagationEnricher - propagates rejection types through await chains
 *
 * When function A awaits function B, and B can reject with ErrorX,
 * then A also can reject with ErrorX (unless the await is inside try/catch).
 *
 * Priority: 70 (after FunctionCallResolver at 80, needs CALLS edges)
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';

export class RejectionPropagationEnricher extends Plugin {
  static MAX_ITERATIONS = 10;

  get metadata(): PluginMetadata {
    return {
      name: 'RejectionPropagationEnricher',
      phase: 'ENRICHMENT',
      priority: 70,
      creates: {
        nodes: [],
        edges: ['REJECTS']
      },
      dependencies: ['FunctionCallResolver', 'JSASTAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    let totalEdgesCreated = 0;
    let iterations = 0;

    // Step 1: Build function index
    const functionIndex = new Map<string, any>();
    const asyncFunctions: any[] = [];

    for await (const node of graph.queryNodes({ type: 'FUNCTION' })) {
      functionIndex.set(node.id, node);
      if (node.async) {
        asyncFunctions.push(node);
      }
    }

    // Step 2: Build REJECTS index
    const rejectsByFunction = new Map<string, Set<string>>();

    for await (const edge of graph.queryEdges({ type: 'REJECTS' })) {
      if (!rejectsByFunction.has(edge.src)) {
        rejectsByFunction.set(edge.src, new Set());
      }
      rejectsByFunction.get(edge.src)!.add(edge.dst);
    }

    // Step 3: Build CALLS index
    const callTargets = new Map<string, string[]>();

    for await (const edge of graph.queryEdges({ type: 'CALLS' })) {
      if (!callTargets.has(edge.src)) {
        callTargets.set(edge.src, []);
      }
      callTargets.get(edge.src)!.push(edge.dst);
    }

    // Step 4: Build call-to-function mapping
    const callsByFunction = new Map<string, any[]>();

    for await (const node of graph.queryNodes({ type: 'CALL' })) {
      // Find containing function (simplified - uses CONTAINS edges)
      const containsEdges = await graph.getIncomingEdges(node.id, ['CONTAINS']);
      for (const edge of containsEdges) {
        if (functionIndex.has(edge.src)) {
          if (!callsByFunction.has(edge.src)) {
            callsByFunction.set(edge.src, []);
          }
          callsByFunction.get(edge.src)!.push(node);
        }
      }
    }

    // Step 5: Iterate until fixpoint
    let changed = true;

    while (changed && iterations < RejectionPropagationEnricher.MAX_ITERATIONS) {
      iterations++;
      changed = false;
      let iterationEdges = 0;

      for (const asyncFunc of asyncFunctions) {
        const calls = callsByFunction.get(asyncFunc.id) || [];

        for (const call of calls) {
          // Only propagate for awaited calls NOT inside try
          if (!call.isAwaited || call.isInsideTry) {
            continue;
          }

          const targets = callTargets.get(call.id) || [];

          for (const targetId of targets) {
            const targetRejects = rejectsByFunction.get(targetId);
            if (!targetRejects || targetRejects.size === 0) {
              continue;
            }

            if (!rejectsByFunction.has(asyncFunc.id)) {
              rejectsByFunction.set(asyncFunc.id, new Set());
            }
            const callerRejects = rejectsByFunction.get(asyncFunc.id)!;

            for (const errorClassId of targetRejects) {
              if (!callerRejects.has(errorClassId)) {
                await graph.addEdge({
                  type: 'REJECTS',
                  src: asyncFunc.id,
                  dst: errorClassId,
                  metadata: {
                    rejectionType: 'propagated',
                    propagatedFrom: targetId
                  }
                });

                callerRejects.add(errorClassId);
                iterationEdges++;
                totalEdgesCreated++;
                changed = true;
              }
            }
          }
        }
      }

      logger.debug(`Iteration ${iterations}`, { edgesCreated: iterationEdges });
    }

    return createSuccessResult({ nodes: 0, edges: totalEdgesCreated }, {
      iterations,
      asyncFunctionsProcessed: asyncFunctions.length
    });
  }
}
```

### 4.3 Complexity Analysis

| Component | Complexity | Notes |
|-----------|------------|-------|
| Build function index | O(f) | f = functions |
| Build REJECTS index | O(r) | r = initial REJECTS edges |
| Build CALLS index | O(e) | e = CALLS edges |
| Per iteration | O(a * c * t * r) | a=async, c=calls, t=targets, r=rejects |
| Total iterations | O(i) | i = 2-3 typically |

**Typical real-world:** O(30a) where a = async functions. Linear in practice.

---

## Part 5: Test Cases

### 5.1 Variable Rejection Tests

```typescript
describe('Variable Rejection Patterns (REG-311)', () => {
  it('should trace const err = new Error(); reject(err)', async () => {
    await setupTest(backend, {
      'index.js': `
async function rejectVia() {
  const err = new ValidationError('bad');
  return Promise.reject(err);
}
      `
    });

    const func = await getFunctionByName(backend, 'rejectVia');
    expect(func.controlFlow.canReject).toBe(true);

    const edges = await backend.getOutgoingEdges(func.id, ['REJECTS']);
    expect(edges.length).toBe(1);
  });

  it('should track parameter forwarding as variable_parameter', async () => {
    await setupTest(backend, {
      'index.js': `
async function forward(err) {
  throw err;
}
      `
    });

    const func = await getFunctionByName(backend, 'forward');
    const pattern = func.metadata.rejectionPatterns[0];
    expect(pattern.rejectionType).toBe('variable_parameter');
  });
});
```

### 5.2 Propagation Tests

```typescript
describe('Rejection Propagation Enricher (REG-311)', () => {
  it('should propagate rejections through unprotected await', async () => {
    await setupTest(backend, {
      'index.js': `
async function inner() {
  throw new ValidationError('fail');
}

async function outer() {
  return await inner();
}
      `
    });

    await runEnrichment(backend);

    const outer = await getFunctionByName(backend, 'outer');
    const edges = await backend.getOutgoingEdges(outer.id, ['REJECTS']);
    expect(edges.length).toBe(1);
    expect(edges[0].metadata.propagatedFrom).toContain('inner');
  });

  it('should NOT propagate through try/catch protected await', async () => {
    await setupTest(backend, {
      'index.js': `
async function inner() {
  throw new ValidationError('fail');
}

async function outer() {
  try {
    return await inner();
  } catch (e) {
    return null;
  }
}
      `
    });

    await runEnrichment(backend);

    const outer = await getFunctionByName(backend, 'outer');
    const edges = await backend.getOutgoingEdges(outer.id, ['REJECTS']);
    expect(edges.length).toBe(0);
  });
});
```

---

## Part 6: Implementation Order

### Week 1: Analysis Phase (5 days)

| Day | Task |
|-----|------|
| 1 | REJECTS edge type + ControlFlowMetadata |
| 2 | Basic rejection patterns (Promise.reject, executor, async throw) |
| 3 | Variable rejection with micro-trace |
| 4 | isAwaited/isInsideTry on CALL nodes |
| 5 | Unit tests for all analysis patterns |

### Week 2: Enrichment Phase (5+ days)

| Day | Task |
|-----|------|
| 6 | CATCHES_FROM edge type + detection |
| 7-8 | RejectionPropagationEnricher |
| 9 | Cross-file variable resolution |
| 10 | Integration tests |
| 11 | Documentation + polish |

---

## Part 7: Summary

### New Types Added

| Type | Purpose |
|------|---------|
| `RejectionPatternInfo.rejectionType` extended | variable_traced, variable_parameter, variable_unknown |
| `CallSiteInfo.isAwaited` | Track await wrapper |
| `CallSiteInfo.isInsideTry` | Track try protection |
| `CatchesFromInfo` | Catch parameter to error source |
| `CATCHES_FROM` edge | Catch block -> error source |

### New Methods Added

| Method | Complexity |
|--------|------------|
| `microTraceToErrorClass` | O(d * n), bounded |
| `isInsideTryBlock` | O(s) scope chain |

### New Enricher

| Enricher | Priority | Creates |
|----------|----------|---------|
| `RejectionPropagationEnricher` | 70 | REJECTS edges (propagated) |

### Complexity Summary

All new features maintain the forward registration pattern:
- **No O(all_nodes) scans** - only targeted queries
- **Micro-trace bounded** by maxDepth=3
- **Enricher** is O(async_functions * calls) - linear in practice
- **Fixpoint iteration** converges in 2-3 iterations typically
