# REG-423: GraphBuilder.ts Decomposition - Exploration Report

**File:** `/Users/vadim/grafema-worker-15/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
**Total lines:** 3,788
**Date:** 2026-02-15

## Executive Summary

GraphBuilder.ts is a 3,788-line class with **43 buffer methods** responsible for converting AST analysis data into graph nodes and edges. The file has a clean internal structure:
- All buffer methods are **synchronous** and **independent** (no cross-calls except 2 sub-buffer methods)
- All methods use the same 3 shared state fields: `_nodeBuffer`, `_edgeBuffer`, `_createdSingletons`
- Methods share 4 utility functions: `findFunctionByName`, `resolveVariableInScope`, `resolveParameterInScope`, `scopePathsMatch`
- **No complex coupling** — decomposition is straightforward

The file is large NOT because of complexity, but because it handles 43 different node/edge types. Each buffer method is a simple loop + edge creation pattern.

## 1. File Structure Overview

### Class Fields (3 total)
```typescript
private _createdSingletons: Set<string> = new Set();  // Singleton node tracking
private _nodeBuffer: GraphNode[] = [];                // Batched node writes
private _edgeBuffer: GraphEdge[] = [];                // Batched edge writes
```

### Public API (1 method)
- `async build(...)` — orchestrates all buffer method calls, then flushes to graph

### Core Infrastructure (2 methods)
- `private _bufferNode(node: GraphNode): void` — adds to buffer
- `private _bufferEdge(edge: GraphEdge): void` — adds to buffer
- `private async _flushNodes(graph: GraphBackend)` — writes buffered nodes
- `private async _flushEdges(graph: GraphBackend)` — writes buffered edges

### Shared Utilities (4 methods)
- `findFunctionByName(...)` — scope-aware function lookup (30 lines)
- `resolveVariableInScope(...)` — scope chain variable resolution (50 lines)
- `resolveParameterInScope(...)` — scope chain parameter resolution (45 lines)
- `scopePathsMatch(...)` — semantic ID scope matching (4 lines)

### Post-Flush Helpers (3 async methods)
- `collectImportMetaProperties(...)` — extract import.meta properties (10 lines)
- `async updateModuleImportMetaMetadata(...)` — update MODULE node (20 lines)
- `async updateModuleTopLevelAwaitMetadata(...)` — update MODULE node (15 lines)
- `async createClassAssignmentEdges(...)` — late CLASS binding via graph query (30 lines)

### Buffer Methods (43 methods, 2,800+ lines total)
See inventory below.

---

## 2. Buffer Method Inventory

All methods follow pattern: `private bufferXxxYyy(...): void`

### 2.1 Core Language Constructs (8 methods, ~450 lines)
| Method | Lines | Line Range | Purpose |
|--------|-------|------------|---------|
| `bufferFunctionEdges` | 20 | 470-490 | CONTAINS edges MODULE/SCOPE → FUNCTION |
| `bufferScopeEdges` | 36 | 492-542 | CONTAINS/HAS_PARENT edges for SCOPE |
| `bufferVariableEdges` | 16 | 952-968 | DECLARED_IN edges VARIABLE → SCOPE |
| `bufferCallSiteEdges` | 23 | 970-999 | CONTAINS, CALLS edges for CALL_SITE |
| `bufferMethodCalls` | 51 | 1031-1088 | METHOD_CALL nodes + CONTAINS/USES edges |
| `bufferPropertyAccessNodes` | 24 | 1090-1119 | PROPERTY_ACCESS nodes + CONTAINS edges |
| `bufferLiterals` | 5 | 1568-1573 | LITERAL nodes (simple buffering) |
| `bufferCallbackEdges` | 16 | 1295-1311 | PASSES_ARGUMENT edges METHOD_CALL → FUNCTION |

**Shared state:** Only `_nodeBuffer`, `_edgeBuffer`
**Dependencies:** `findFunctionByName` (called from `bufferCallSiteEdges`)

---

### 2.2 Control Flow (7 methods, ~430 lines)
| Method | Lines | Line Range | Purpose |
|--------|-------|------------|---------|
| `bufferLoopEdges` | 131 | 543-684 | LOOP HAS_BODY/ITERATES_OVER/CONTAINS edges |
| `bufferLoopConditionEdges` | 34 | 685-727 | HAS_CONDITION edges for LOOP |
| `bufferLoopConditionExpressions` | 27 | 728-765 | EXPRESSION nodes for loop conditions |
| `bufferBranchEdges` | 92 | 766-862 | BRANCH HAS_DISCRIMINANT/HAS_CONSEQUENT/HAS_ALTERNATE edges |
| `bufferCaseEdges` | 10 | 863-882 | SWITCH_CASE HAS_TEST/HAS_CONSEQUENT edges |
| `bufferTryCatchFinallyEdges` | 36 | 883-927 | TRY/CATCH/FINALLY structure edges |
| `bufferDiscriminantExpressions` | 22 | 928-951 | EXPRESSION nodes for switch discriminants |

**Shared state:** Only `_nodeBuffer`, `_edgeBuffer`
**Dependencies:** None (all self-contained)

---

### 2.3 Data Flow (11 methods, ~1,100 lines)
| Method | Lines | Line Range | Purpose |
|--------|-------|------------|---------|
| `bufferAssignmentEdges` | 359 | 1575-1935 | ASSIGNED_FROM edges for variable assignments |
| `bufferArgumentEdges` | 140 | 1936-2086 | PASSES_ARGUMENT edges CALL → arguments |
| `bufferObjectPropertyEdges` | 47 | 3583-3634 | HAS_PROPERTY edges OBJECT_LITERAL → values |
| `bufferArrayMutationEdges` | 92 | 2372-2472 | FLOWS_INTO edges for array mutations |
| `bufferObjectMutationEdges` | 67 | 2473-2551 | FLOWS_INTO edges for object mutations |
| `bufferVariableReassignmentEdges` | 117 | 2659-2786 | FLOWS_INTO edges for variable reassignments |
| `bufferReturnEdges` | 236 | 2787-3039 | RETURNS edges FUNCTION → return values |
| `bufferYieldEdges` | 237 | 3040-3294 | YIELDS/DELEGATES_TO edges for generators |
| `bufferUpdateExpressionEdges` | 26 | 3295-3326 | UPDATE_EXPRESSION dispatch (calls sub-buffers) |
| `bufferIdentifierUpdate` | 65 | 3327-3403 | UPDATE_EXPRESSION + MODIFIES for `i++` |
| `bufferMemberExpressionUpdate` | 103 | 3404-3524 | UPDATE_EXPRESSION + MODIFIES for `obj.x++` |

**Shared state:** `_nodeBuffer`, `_edgeBuffer`
**Dependencies:**
- `resolveVariableInScope` — used by 6 methods
- `resolveParameterInScope` — used by 6 methods
- `scopePathsMatch` — used by resolve helpers
- `findFunctionByName` — used by `bufferArgumentEdges`

**CRITICAL FINDING:** `bufferUpdateExpressionEdges` calls **two sub-buffer methods**:
- `bufferIdentifierUpdate` (for `i++`)
- `bufferMemberExpressionUpdate` (for `obj.x++`)

This is the ONLY cross-dependency between buffer methods.

---

### 2.4 Object-Oriented (5 methods, ~230 lines)
| Method | Lines | Line Range | Purpose |
|--------|-------|------------|---------|
| `bufferClassDeclarationNodes` | 61 | 1197-1259 | CLASS nodes + CONTAINS/HAS_PROPERTY/HAS_METHOD edges |
| `bufferClassNodes` | 33 | 1260-1294 | CLASS nodes + INSTANCE_OF edges for instantiations |
| `bufferImplementsEdges` | 34 | 2329-2371 | IMPLEMENTS edges CLASS → INTERFACE |
| `bufferInterfaceNodes` | 60 | 2087-2151 | INTERFACE nodes + EXTENDS edges |
| `bufferTypeParameterNodes` | 71 | 2253-2328 | TYPE_PARAMETER nodes + HAS_TYPE_PARAMETER/EXTENDS edges |

**Shared state:** Only `_nodeBuffer`, `_edgeBuffer`
**Dependencies:** None

---

### 2.5 TypeScript-Specific (4 methods, ~115 lines)
| Method | Lines | Line Range | Purpose |
|--------|-------|------------|---------|
| `bufferTypeAliasNodes` | 33 | 2152-2190 | TYPE nodes + CONTAINS edges |
| `bufferEnumNodes` | 24 | 2191-2219 | ENUM nodes + CONTAINS edges |
| `bufferDecoratorNodes` | 22 | 2220-2252 | DECORATOR nodes + DECORATED_BY edges |
| `bufferPromiseResolutionEdges` | 11 | 3525-3541 | RESOLVES_TO edges for Promise chains |

**Shared state:** Only `_nodeBuffer`, `_edgeBuffer`
**Dependencies:** None

---

### 2.6 Module System (2 methods, ~180 lines)
| Method | Lines | Line Range | Purpose |
|--------|-------|------------|---------|
| `bufferImportNodes` | 97 | 1313-1411 | IMPORT nodes + IMPORTS_FROM/USES_BINDING edges |
| `bufferExportNodes` | 81 | 1412-1494 | EXPORT nodes + EXPORTS_FROM/RE_EXPORTS edges |

**Shared state:** Only `_nodeBuffer`, `_edgeBuffer`
**Dependencies:** None

---

### 2.7 Runtime/Network (4 methods, ~170 lines)
| Method | Lines | Line Range | Purpose |
|--------|-------|------------|---------|
| `bufferStdioNodes` | 23 | 1172-1196 | net:stdio singleton + WRITES_TO edges |
| `bufferEventListeners` | 27 | 1495-1523 | EVENT_LISTENER nodes + HANDLED_BY edges |
| `bufferHttpRequests` | 42 | 1524-1567 | HTTP_REQUEST nodes + ORIGINATES_FROM edges |
| `bufferRejectionEdges` | 75 | 3682-3773 | REJECTS edges FUNCTION → error classes |

**Shared state:** `_createdSingletons` (used by `bufferStdioNodes` only)
**Dependencies:** None

---

### 2.8 Async/Error Handling (2 methods, ~90 lines)
| Method | Lines | Line Range | Purpose |
|--------|-------|------------|---------|
| `bufferCatchesFromEdges` | 13 | 3774-3788 | CATCHES_FROM edges catch → error sources |
| `bufferRejectionEdges` | 75 | 3682-3773 | Already counted in Runtime section |

**Shared state:** Only `_nodeBuffer`, `_edgeBuffer`
**Dependencies:** None

---

### 2.9 Object/Array Literals (2 methods, ~25 lines)
| Method | Lines | Line Range | Purpose |
|--------|-------|------------|---------|
| `bufferObjectLiteralNodes` | 13 | 3542-3560 | OBJECT_LITERAL nodes |
| `bufferArrayLiteralNodes` | 13 | 3561-3580 | ARRAY_LITERAL nodes |

**Shared state:** Only `_nodeBuffer`, `_edgeBuffer`
**Dependencies:** None

---

## 3. Dependency Analysis

### 3.1 Shared State Usage

| Field | Used By | Purpose |
|-------|---------|---------|
| `_nodeBuffer` | All 43 buffer methods | Batched node writes |
| `_edgeBuffer` | All 43 buffer methods | Batched edge writes |
| `_createdSingletons` | `bufferStdioNodes` only | Prevent duplicate net:stdio nodes |

**Conclusion:** All buffer methods require access to `_nodeBuffer` and `_edgeBuffer`. Only 1 method needs `_createdSingletons`.

---

### 3.2 Helper Method Usage

| Helper | Called By | Count |
|--------|-----------|-------|
| `findFunctionByName` | `bufferCallSiteEdges`, `bufferArgumentEdges` | 2 |
| `resolveVariableInScope` | 6 data flow methods | 6 |
| `resolveParameterInScope` | 6 data flow methods | 6 |
| `scopePathsMatch` | `resolveVariableInScope`, `resolveParameterInScope` | 2 |

**Methods using scope resolution:**
1. `bufferArrayMutationEdges` (6 calls)
2. `bufferObjectMutationEdges` (4 calls)
3. `bufferVariableReassignmentEdges` (4 calls)
4. `bufferObjectPropertyEdges` (2 calls)
5. `bufferAssignmentEdges` (not counted, but uses pattern)
6. `bufferReturnEdges` (not counted, but uses pattern)

**Conclusion:** Scope resolution helpers are tightly coupled to **Data Flow** methods. Function lookup is used by **Call** methods.

---

### 3.3 Cross-Dependencies Between Buffer Methods

**CRITICAL:** Only 1 cross-dependency exists:

```typescript
bufferUpdateExpressionEdges() {
  if (update.argument.type === 'Identifier') {
    this.bufferIdentifierUpdate(update, ...);
  } else if (update.argument.type === 'MemberExpression') {
    this.bufferMemberExpressionUpdate(update, ...);
  }
}
```

`bufferIdentifierUpdate` and `bufferMemberExpressionUpdate` are **sub-buffer methods** called ONLY by `bufferUpdateExpressionEdges`.

**All other 40 buffer methods are completely independent.**

---

## 4. Build Flow Analysis

### 4.1 Execution Order (from `build()` method)

```typescript
// Phase 1: Buffer nodes (lines 212-319)
for (const func of functions) { this._bufferNode(func); }
for (const scope of scopes) { this._bufferNode(scope); }
for (const branch of branches) { this._bufferNode(branch); }
// ... (30+ loops creating nodes)

// Phase 2: Buffer edges (lines 322-449)
this.bufferFunctionEdges(module, functions);              // 1
this.bufferScopeEdges(scopes, variableDeclarations);      // 2
this.bufferLoopEdges(loops, scopes, ...);                 // 3
this.bufferLoopConditionEdges(loops, callSites);          // 4
this.bufferLoopConditionExpressions(loops);               // 5
this.bufferBranchEdges(branches, callSites, scopes);      // 6
this.bufferCaseEdges(cases);                              // 7
this.bufferTryCatchFinallyEdges(tryBlocks, ...);          // 8
this.bufferDiscriminantExpressions(branches, callSites);  // 9
this.bufferVariableEdges(variableDeclarations);           // 10
this.bufferCallSiteEdges(callSites, functions);           // 11
this.bufferMethodCalls(methodCalls, ...);                 // 12
this.bufferPropertyAccessNodes(module, propertyAccesses); // 13
this.bufferStdioNodes(methodCalls);                       // 14
this.bufferClassDeclarationNodes(classDeclarations);      // 15
this.bufferClassNodes(module, classInstantiations, ...);  // 16
this.bufferCallbackEdges(methodCallbacks, functions);     // 17
this.bufferImportNodes(module, imports);                  // 18
this.bufferExportNodes(module, exports);                  // 19
this.bufferEventListeners(eventListeners, functions);     // 20
this.bufferHttpRequests(httpRequests, functions);         // 21
this.bufferLiterals(literals);                            // 22
this.bufferObjectLiteralNodes(objectLiterals);            // 23
this.bufferArrayLiteralNodes(arrayLiterals);              // 24
this.bufferObjectPropertyEdges(objectProperties, ...);    // 25
this.bufferAssignmentEdges(variableAssignments, ...);     // 26
this.bufferArgumentEdges(callArguments, ...);             // 27
this.bufferInterfaceNodes(module, interfaces);            // 28
this.bufferTypeAliasNodes(module, typeAliases);           // 29
this.bufferEnumNodes(module, enums);                      // 30
this.bufferDecoratorNodes(decorators);                    // 31
this.bufferTypeParameterNodes(typeParameters, ...);       // 32
this.bufferImplementsEdges(classDeclarations, ...);       // 33
this.bufferArrayMutationEdges(arrayMutations, ...);       // 34
this.bufferObjectMutationEdges(objectMutations, ...);     // 35
this.bufferVariableReassignmentEdges(variableReassignments, ...); // 36
this.bufferReturnEdges(returnStatements, ...);            // 37
this.bufferUpdateExpressionEdges(updateExpressions, ...); // 38
this.bufferPromiseResolutionEdges(promiseResolutions);    // 39
this.bufferYieldEdges(yieldExpressions, ...);             // 40
this.bufferRejectionEdges(functions, rejectionPatterns);  // 41
this.bufferCatchesFromEdges(catchesFromInfos);            // 42

// Phase 3: Flush (lines 452-463)
await this._flushNodes(graph);
await this._flushEdges(graph);

// Phase 4: Post-flush async operations (lines 456-463)
await this.createClassAssignmentEdges(variableAssignments, graph);
await this.updateModuleImportMetaMetadata(module, graph, importMetaProps);
await this.updateModuleTopLevelAwaitMetadata(module, graph, hasTopLevelAwait);
```

**Order matters only for Phase 1 (nodes before edges).** Within Phase 2, buffer calls are independent.

---

## 5. Proposed Grouping Strategy

### 5.1 Domain-Based Decomposition

Group buffer methods by **semantic domain**, not implementation details.

#### Option A: Fine-Grained (9 builder files)

| Builder File | Methods | Lines | Rationale |
|--------------|---------|-------|-----------|
| `CoreBuilder.ts` | 8 methods | ~450 | Functions, scopes, variables, calls |
| `ControlFlowBuilder.ts` | 7 methods | ~430 | Loops, branches, try/catch |
| `DataFlowBuilder.ts` | 11 methods | ~1,100 | Assignments, mutations, returns, yields |
| `ClassBuilder.ts` | 5 methods | ~230 | Classes, interfaces, implements |
| `TypeSystemBuilder.ts` | 4 methods | ~115 | Types, enums, decorators |
| `ModuleBuilder.ts` | 2 methods | ~180 | Imports, exports |
| `RuntimeBuilder.ts` | 4 methods | ~170 | stdio, events, HTTP, rejections |
| `AsyncErrorBuilder.ts` | 2 methods | ~90 | Promises, error tracking |
| `LiteralBuilder.ts` | 2 methods | ~25 | Object/array literals |

**Pros:** Clean domain separation
**Cons:** Too many files (9), some very small (<100 lines)

---

#### Option B: Medium-Grained (5 builder files) — **RECOMMENDED**

| Builder File | Methods | Lines | Rationale |
|--------------|---------|-------|-----------|
| `CoreBuilder.ts` | 8 methods | ~450 | Functions, scopes, variables, calls, property access |
| `ControlFlowBuilder.ts` | 7 methods | ~430 | Loops, branches, try/catch, switch cases |
| `DataFlowBuilder.ts` | 13 methods | ~1,125 | Assignments, mutations, returns, yields, literals |
| `TypeSystemBuilder.ts` | 9 methods | ~345 | Classes, interfaces, types, enums, decorators |
| `ModuleRuntimeBuilder.ts` | 6 methods | ~350 | Imports, exports, stdio, events, HTTP, async errors |

**Pros:** Balanced file sizes (345-1,125 lines), clear domains
**Cons:** None (sweet spot)

---

#### Option C: Coarse-Grained (3 builder files)

| Builder File | Methods | Lines | Rationale |
|--------------|---------|-------|-----------|
| `StructuralBuilder.ts` | 15 methods | ~880 | Functions, scopes, control flow, classes |
| `DataFlowBuilder.ts` | 13 methods | ~1,125 | Same as Option B |
| `ModuleTypeBuilder.ts` | 15 methods | ~695 | Modules, types, runtime, async |

**Pros:** Fewer files
**Cons:** `ModuleTypeBuilder` mixes unrelated concerns (imports + HTTP requests?)

---

### 5.2 Recommended Grouping (Option B)

**File:** `CoreBuilder.ts` (~450 lines)
```typescript
bufferFunctionEdges
bufferScopeEdges
bufferVariableEdges
bufferCallSiteEdges
bufferMethodCalls
bufferPropertyAccessNodes
bufferLiterals
bufferCallbackEdges
```

**File:** `ControlFlowBuilder.ts` (~430 lines)
```typescript
bufferLoopEdges
bufferLoopConditionEdges
bufferLoopConditionExpressions
bufferBranchEdges
bufferCaseEdges
bufferTryCatchFinallyEdges
bufferDiscriminantExpressions
```

**File:** `DataFlowBuilder.ts` (~1,125 lines)
```typescript
bufferAssignmentEdges
bufferArgumentEdges
bufferObjectPropertyEdges
bufferArrayMutationEdges
bufferObjectMutationEdges
bufferVariableReassignmentEdges
bufferReturnEdges
bufferYieldEdges
bufferUpdateExpressionEdges
bufferIdentifierUpdate         // Sub-buffer
bufferMemberExpressionUpdate   // Sub-buffer
bufferObjectLiteralNodes
bufferArrayLiteralNodes
```

**File:** `TypeSystemBuilder.ts` (~345 lines)
```typescript
bufferClassDeclarationNodes
bufferClassNodes
bufferImplementsEdges
bufferInterfaceNodes
bufferTypeParameterNodes
bufferTypeAliasNodes
bufferEnumNodes
bufferDecoratorNodes
bufferPromiseResolutionEdges
```

**File:** `ModuleRuntimeBuilder.ts` (~350 lines)
```typescript
bufferImportNodes
bufferExportNodes
bufferStdioNodes
bufferEventListeners
bufferHttpRequests
bufferRejectionEdges
bufferCatchesFromEdges
```

---

## 6. Interface Design

### 6.1 Base Builder Interface

All builders share the same protocol:

```typescript
/**
 * Base interface for domain-specific graph builders.
 * Each builder is responsible for buffering nodes/edges for a specific domain
 * (core constructs, control flow, data flow, etc.).
 */
export interface IGraphBuilder {
  /**
   * Buffer nodes and edges for this builder's domain.
   * Called during the buffering phase (before flush).
   *
   * @param module - MODULE node being analyzed
   * @param data - All AST collections from analysis
   * @param context - Shared builder context (buffers, utilities)
   */
  buffer(
    module: ModuleNode,
    data: ASTCollections,
    context: BuilderContext
  ): void;
}

/**
 * Shared context passed to all builders.
 * Provides access to buffers and utility methods.
 */
export interface BuilderContext {
  // Buffering operations
  bufferNode(node: GraphNode): void;
  bufferEdge(edge: GraphEdge): void;

  // Singleton tracking (for net:stdio, net:request, etc.)
  isCreated(singletonKey: string): boolean;
  markCreated(singletonKey: string): void;

  // Shared utilities
  findFunctionByName(
    functions: FunctionInfo[],
    name: string | undefined,
    file: string,
    callScopeId: string
  ): FunctionInfo | undefined;

  resolveVariableInScope(
    name: string,
    scopePath: string[],
    file: string,
    variables: VariableDeclarationInfo[]
  ): VariableDeclarationInfo | null;

  resolveParameterInScope(
    name: string,
    scopePath: string[],
    file: string,
    parameters: ParameterInfo[]
  ): ParameterInfo | null;

  scopePathsMatch(a: string[], b: string[]): boolean;
}
```

---

### 6.2 Orchestrator Pattern

**New GraphBuilder.ts** becomes a thin orchestrator:

```typescript
export class GraphBuilder {
  private _nodeBuffer: GraphNode[] = [];
  private _edgeBuffer: GraphEdge[] = [];
  private _createdSingletons: Set<string> = new Set();

  // Domain-specific builders
  private _coreBuilder: CoreBuilder;
  private _controlFlowBuilder: ControlFlowBuilder;
  private _dataFlowBuilder: DataFlowBuilder;
  private _typeSystemBuilder: TypeSystemBuilder;
  private _moduleRuntimeBuilder: ModuleRuntimeBuilder;

  constructor() {
    const context = this._createContext();
    this._coreBuilder = new CoreBuilder(context);
    this._controlFlowBuilder = new ControlFlowBuilder(context);
    this._dataFlowBuilder = new DataFlowBuilder(context);
    this._typeSystemBuilder = new TypeSystemBuilder(context);
    this._moduleRuntimeBuilder = new ModuleRuntimeBuilder(context);
  }

  async build(module: ModuleNode, graph: GraphBackend, projectPath: string, data: ASTCollections): Promise<BuildResult> {
    // Reset buffers
    this._nodeBuffer = [];
    this._edgeBuffer = [];

    // Phase 1: Buffer all nodes inline (stays in GraphBuilder)
    // ... (same as before, lines 212-319)

    // Phase 2: Delegate edge buffering to domain builders
    this._coreBuilder.buffer(module, data);
    this._controlFlowBuilder.buffer(module, data);
    this._dataFlowBuilder.buffer(module, data);
    this._typeSystemBuilder.buffer(module, data);
    this._moduleRuntimeBuilder.buffer(module, data);

    // Phase 3: Flush
    const nodesCreated = await this._flushNodes(graph);
    const edgesCreated = await this._flushEdges(graph);

    // Phase 4: Post-flush operations (stays in GraphBuilder)
    const classAssignmentEdges = await this.createClassAssignmentEdges(data.variableAssignments, graph);
    await this.updateModuleImportMetaMetadata(module, graph, ...);
    await this.updateModuleTopLevelAwaitMetadata(module, graph, ...);

    return { nodes: nodesCreated, edges: edgesCreated + classAssignmentEdges };
  }

  private _createContext(): BuilderContext {
    return {
      bufferNode: (node) => this._bufferNode(node),
      bufferEdge: (edge) => this._bufferEdge(edge),
      isCreated: (key) => this._createdSingletons.has(key),
      markCreated: (key) => this._createdSingletons.add(key),
      findFunctionByName: this._findFunctionByName.bind(this),
      resolveVariableInScope: this._resolveVariableInScope.bind(this),
      resolveParameterInScope: this._resolveParameterInScope.bind(this),
      scopePathsMatch: this._scopePathsMatch.bind(this)
    };
  }

  // Utility methods stay here (findFunctionByName, resolveVariableInScope, etc.)
  // Post-flush async methods stay here (createClassAssignmentEdges, updateModuleImportMetaMetadata, etc.)
}
```

---

## 7. Risk Assessment

### 7.1 Low Risk Areas (95% of methods)

**40 out of 43 buffer methods** are trivial to extract:
- Simple loops over input data
- Call `context.bufferNode()` or `context.bufferEdge()`
- No internal state, no cross-calls
- Easy to test in isolation

**Example (bufferCaseEdges):**
```typescript
// Before (in GraphBuilder)
private bufferCaseEdges(cases: CaseInfo[]): void {
  for (const caseInfo of cases) {
    this._bufferEdge({
      type: 'HAS_TEST',
      src: caseInfo.switchId,
      dst: caseInfo.id
    });
    // ... more edges
  }
}

// After (in ControlFlowBuilder)
buffer(module: ModuleNode, data: ASTCollections, context: BuilderContext): void {
  for (const caseInfo of data.cases) {
    context.bufferEdge({
      type: 'HAS_TEST',
      src: caseInfo.switchId,
      dst: caseInfo.id
    });
    // ... more edges
  }
}
```

---

### 7.2 Medium Risk Areas (2 methods)

#### 1. `bufferUpdateExpressionEdges` + sub-buffers

**Risk:** Only cross-dependency between buffer methods.

**Solution:** Move all 3 methods to `DataFlowBuilder` together:
```typescript
class DataFlowBuilder {
  buffer(module: ModuleNode, data: ASTCollections, context: BuilderContext): void {
    // ... other data flow buffering
    this._bufferUpdateExpressionEdges(data.updateExpressions, ...);
  }

  private _bufferUpdateExpressionEdges(...) {
    for (const update of updateExpressions) {
      if (update.argument.type === 'Identifier') {
        this._bufferIdentifierUpdate(update, ...);
      } else {
        this._bufferMemberExpressionUpdate(update, ...);
      }
    }
  }

  private _bufferIdentifierUpdate(...) { ... }
  private _bufferMemberExpressionUpdate(...) { ... }
}
```

**Mitigation:** Extract all 3 methods as a unit. Keep internal visibility.

---

#### 2. Scope Resolution Helpers (6 callers)

**Risk:** `resolveVariableInScope` and `resolveParameterInScope` are called by 6 data flow methods.

**Solution:** Keep helpers in `GraphBuilder`, expose via `BuilderContext`:
```typescript
// Available to all builders
context.resolveVariableInScope(name, scopePath, file, variables);
context.resolveParameterInScope(name, scopePath, file, parameters);
```

**Mitigation:** No risk. Helpers are already designed for reuse.

---

### 7.3 High Risk Areas

**NONE.** No complex state, no async coordination issues, no circular dependencies.

---

## 8. Migration Strategy

### 8.1 Step-by-Step Plan

1. **Create infrastructure** (base types, context)
   - `IGraphBuilder` interface
   - `BuilderContext` type
   - Update `GraphBuilder` to create context

2. **Extract builders one at a time** (TDD)
   - Start with smallest: `LiteralBuilder` (2 methods, 25 lines)
   - Then `ControlFlowBuilder` (7 methods, 430 lines)
   - Then `CoreBuilder` (8 methods, 450 lines)
   - Then `TypeSystemBuilder` (9 methods, 345 lines)
   - Then `ModuleRuntimeBuilder` (6 methods, 350 lines)
   - Last: `DataFlowBuilder` (13 methods, 1,125 lines) — largest, most complex

3. **For each builder:**
   - Create new file `XxxBuilder.ts`
   - Copy buffer methods from `GraphBuilder.ts`
   - Adapt to use `context` parameter
   - Write unit tests (mock context)
   - Update `GraphBuilder.build()` to delegate
   - Run full test suite
   - Commit

4. **Clean up**
   - Remove extracted methods from `GraphBuilder.ts`
   - Verify final `GraphBuilder.ts` is < 500 lines
   - Update documentation

---

### 8.2 Testing Strategy

**Before refactoring:**
1. Run existing test suite — capture baseline
2. If coverage gaps exist, write integration tests for `GraphBuilder.build()` output

**During refactoring (per builder):**
1. Unit tests for new builder:
   ```typescript
   test('CoreBuilder.buffer creates CONTAINS edges', () => {
     const mockContext = createMockContext();
     const builder = new CoreBuilder(mockContext);

     builder.buffer(mockModule, mockData);

     expect(mockContext.bufferEdge).toHaveBeenCalledWith({
       type: 'CONTAINS',
       src: 'MODULE#...',
       dst: 'FUNCTION#...'
     });
   });
   ```

2. Integration test: `GraphBuilder.build()` output unchanged
   ```typescript
   test('GraphBuilder.build output identical after refactoring', async () => {
     const before = await captureGraphBuilderOutput(inputData);
     // ... refactor ...
     const after = await captureGraphBuilderOutput(inputData);

     expect(after.nodes).toEqual(before.nodes);
     expect(after.edges).toEqual(before.edges);
   });
   ```

**After refactoring:**
1. Full test suite passes
2. Graph output for real files unchanged (snapshot test)

---

### 8.3 Rollback Plan

Each extraction is atomic (1 builder per commit). If issues found:
1. `git revert <commit-hash>` — instant rollback
2. Debug in isolation
3. Re-apply when fixed

---

## 9. Expected Outcomes

### 9.1 File Size Reduction

| File | Before | After | Reduction |
|------|--------|-------|-----------|
| `GraphBuilder.ts` | 3,788 lines | ~400 lines | **-89%** |
| New builder files | 0 | ~2,800 lines | +2,800 |
| **Total** | 3,788 lines | ~3,200 lines | -588 (removed duplication) |

**Net reduction:** ~15% (infrastructure overhead eliminated by shared context)

---

### 9.2 Maintainability Gains

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Lines per file (max) | 3,788 | 1,125 | **-70%** |
| Methods per file (max) | 43 | 13 | **-70%** |
| Cross-file dependencies | N/A | Low (via context) | Clean interfaces |
| Test isolation | Hard (3,788-line class) | Easy (5 builders) | Unit testable |
| Cognitive load | High (find method in 3,788 lines) | Low (domain folders) | Faster navigation |

---

### 9.3 Testing Improvements

**Before:**
- Must test `GraphBuilder` as black box (3,788 lines)
- Hard to write targeted tests for 1 buffer method
- Mocking requires full context setup

**After:**
- Unit test each builder independently
- Mock `BuilderContext` in 10 lines
- Integration tests at `GraphBuilder` level unchanged

---

## 10. Alternatives Considered

### 10.1 Extract to Static Functions

**Idea:** Don't use classes, just move methods to standalone functions.

```typescript
// core-builder.ts
export function bufferFunctionEdges(
  module: ModuleNode,
  functions: FunctionInfo[],
  context: BuilderContext
): void { ... }
```

**Pros:** Simpler, no OOP ceremony
**Cons:**
- 43 functions in 5 files = polluted module namespace
- Harder to test (need to import all 43 functions)
- No clear "builder" concept for callers

**Verdict:** REJECTED. Classes provide better encapsulation.

---

### 10.2 Keep Single File, Use Comments

**Idea:** Don't refactor, just add `// === CORE BUILDER ===` comments.

**Pros:** Zero migration cost
**Cons:**
- Still 3,788 lines in one file
- Uncle Bob would reject at Step 2.5
- Doesn't solve cognitive load

**Verdict:** REJECTED. Doesn't meet project standards (300-line file limit).

---

### 10.3 Extract to 1 Builder Per Method (43 files)

**Idea:** Maximum granularity — 1 class per buffer method.

**Pros:** Ultimate SRP
**Cons:**
- 43 files, many < 50 lines
- Extreme overhead (43 imports, 43 constructors)
- Violates "don't over-abstract" principle

**Verdict:** REJECTED. Over-engineering.

---

## 11. Open Questions

### Q1: Should helper methods move to separate `BuilderUtils.ts`?

**Options:**
- A. Keep in `GraphBuilder.ts`, expose via context (current plan)
- B. Move to `BuilderUtils.ts`, import directly in builders

**Recommendation:** Option A. Context provides clean abstraction boundary.

---

### Q2: Should we use abstract base class or interface?

**Options:**
- A. `interface IGraphBuilder` (current plan)
- B. `abstract class GraphBuilderBase`

**Recommendation:** Option A (interface). Builders don't share code, only protocol.

---

### Q3: Should singleton tracking move to context or stay in GraphBuilder?

**Current:** `_createdSingletons` in `GraphBuilder`, exposed via `context.isCreated()` / `context.markCreated()`
**Alternative:** Move to separate `SingletonTracker` class

**Recommendation:** Keep current plan. Only 1 caller (`bufferStdioNodes`), not worth extra abstraction.

---

## 12. Conclusion

**Ready to proceed:** YES

GraphBuilder.ts decomposition is **straightforward** and **low-risk**:
- 40/43 methods are trivial to extract (no dependencies)
- 2 methods have minor coupling (scope resolution helpers)
- 1 method has internal cross-call (update expressions) — extract as unit
- All builders share same 3 state fields via `BuilderContext`
- No circular dependencies, no async coordination issues

**Recommended approach:** Option B (5 medium-grained builders)
- `CoreBuilder.ts` — 450 lines
- `ControlFlowBuilder.ts` — 430 lines
- `DataFlowBuilder.ts` — 1,125 lines
- `TypeSystemBuilder.ts` — 345 lines
- `ModuleRuntimeBuilder.ts` — 350 lines

**Final GraphBuilder.ts:** ~400 lines (orchestration + helpers + post-flush async)

**Migration:** 6 atomic commits (infrastructure + 5 builders), TDD approach, full test coverage.

**Next step:** Joel's detailed technical plan (extraction order, context API design, test strategy).
