# REG-423: Don's Plan — Extract Domain Builders from GraphBuilder.ts

**Config:** Mini-MLA
**Date:** 2026-02-15

## Summary

Decompose GraphBuilder.ts (3,788 lines) into **10 domain-specific builders** + orchestrator.

Uncle Bob rejected Don's initial 5-builder plan because DataFlowBuilder would be ~1,735 lines (3x over 500-line limit). After analysis, the data flow methods are individually large enough (up to 359 lines each) that they require fine-grained splitting.

## Architecture

### Interface Design

```typescript
// BuilderContext — shared context passed to all builders
export interface BuilderContext {
  bufferNode(node: GraphNode): void;
  bufferEdge(edge: GraphEdge): void;
  isCreated(key: string): boolean;      // singleton tracking
  markCreated(key: string): void;
  findFunctionByName(functions: FunctionInfo[], name: string | undefined, file: string, callScopeId: string): FunctionInfo | undefined;
  resolveVariableInScope(name: string, scopePath: string[], file: string, variables: VariableDeclarationInfo[]): VariableDeclarationInfo | null;
  resolveParameterInScope(name: string, scopePath: string[], file: string, parameters: ParameterInfo[]): ParameterInfo | null;
  scopePathsMatch(a: string[], b: string[]): boolean;
}

// Each builder has a single `buffer()` method
export interface DomainBuilder {
  buffer(module: ModuleNode, data: ASTCollections, ctx: BuilderContext): void;
}
```

### Builder Inventory

| # | Builder | Methods | ~Lines | Domain |
|---|---------|---------|--------|--------|
| 1 | CoreBuilder | 10 | ~350 | functions, scopes, variables, calls, methodCalls, propertyAccess, callbacks, literals, objectLiterals, arrayLiterals |
| 2 | ControlFlowBuilder | 7 | ~452 | loops (3 methods), branches, cases, tryCatch, discriminants |
| 3 | AssignmentBuilder | 1 | ~409 | variable assignments (largest single method, 359 lines) |
| 4 | CallFlowBuilder | 2 | ~250 | arguments, objectProperties |
| 5 | MutationBuilder | 3 | ~355 | arrayMutations, objectMutations, variableReassignments |
| 6 | UpdateExpressionBuilder | 3 | ~277 | updateExpressions + 2 sub-buffer methods |
| 7 | ReturnBuilder | 1 | ~302 | return statements |
| 8 | YieldBuilder | 1 | ~304 | yield expressions |
| 9 | TypeSystemBuilder | 9 | ~442 | classes, interfaces, types, enums, decorators, typeParams, implements, promiseResolution |
| 10 | ModuleRuntimeBuilder | 7 | ~430 | imports, exports, stdio, events, http, rejections, catchesFrom |

**All files under 500 lines.**

### GraphBuilder.ts Orchestrator (~473 lines)

Keeps:
- Build() method: node buffering phase (~108 lines) + builder delegation (~10 lines) + flush (~15 lines)
- Shared utilities: findFunctionByName, resolveVariableInScope, resolveParameterInScope, scopePathsMatch (~130 lines)
- Post-flush async operations: createClassAssignmentEdges, updateModuleImportMetaMetadata, updateModuleTopLevelAwaitMetadata, collectImportMetaProperties (~75 lines)
- Buffer/flush infrastructure: _bufferNode, _bufferEdge, _flushNodes, _flushEdges (~40 lines)
- BuilderContext creation (~20 lines)
- Imports, class fields, constructor (~30 lines)

### File Structure

```
packages/core/src/plugins/analysis/ast/
├── GraphBuilder.ts              (~473 lines, orchestrator)
├── builders/
│   ├── types.ts                 (~30 lines, BuilderContext + DomainBuilder interfaces)
│   ├── CoreBuilder.ts           (~350 lines)
│   ├── ControlFlowBuilder.ts    (~452 lines)
│   ├── AssignmentBuilder.ts     (~409 lines)
│   ├── CallFlowBuilder.ts       (~250 lines)
│   ├── MutationBuilder.ts       (~355 lines)
│   ├── UpdateExpressionBuilder.ts (~277 lines)
│   ├── ReturnBuilder.ts         (~302 lines)
│   ├── YieldBuilder.ts          (~304 lines)
│   ├── TypeSystemBuilder.ts     (~442 lines)
│   ├── ModuleRuntimeBuilder.ts  (~430 lines)
│   └── index.ts                 (~15 lines, re-exports)
```

## Execution Plan

### Safety Net

1. `pnpm build && node --test --test-concurrency=1 'test/unit/*.test.js'` — capture green baseline
2. Snapshot tests ARE the safety net — no new tests needed for pure extraction

### Extraction Order (smallest first = fastest feedback)

Each step = 1 atomic commit. Tests must pass after each.

1. **Infrastructure** — Create `builders/types.ts` with interfaces, add BuilderContext creation to GraphBuilder
2. **CallFlowBuilder** (~250 lines) — smallest, quick validation of the pattern
3. **UpdateExpressionBuilder** (~277 lines) — tests the "sub-buffer" pattern
4. **ReturnBuilder** (~302 lines)
5. **YieldBuilder** (~304 lines)
6. **CoreBuilder** (~350 lines) — medium complexity
7. **MutationBuilder** (~355 lines)
8. **AssignmentBuilder** (~409 lines)
9. **ModuleRuntimeBuilder** (~430 lines)
10. **TypeSystemBuilder** (~442 lines)
11. **ControlFlowBuilder** (~452 lines) — largest, last
12. **Cleanup** — Remove dead code, create `builders/index.ts`, verify final GraphBuilder < 500 lines

### Per-Extraction Checklist

For each builder:
1. Create `builders/XxxBuilder.ts`
2. Copy buffer methods from GraphBuilder.ts
3. Replace `this._bufferNode/Edge` with `this.ctx.bufferNode/Edge`
4. Replace `this.findFunctionByName` etc. with `this.ctx.findFunctionByName`
5. Add `buffer()` method that calls the individual methods
6. In GraphBuilder.build(), replace direct calls with `this._xxxBuilder.buffer(module, data, ctx)`
7. Delete extracted methods from GraphBuilder.ts
8. `pnpm build && node --test --test-concurrency=1 'test/unit/*.test.js'`
9. Commit

## Risk Assessment

**Low risk** — 40/43 methods are trivial extractions (loop + buffer calls).
**Medium risk** — UpdateExpressionBuilder has internal cross-calls (handled by co-extracting all 3 methods).
**No high-risk areas.**

## Rollback

Each extraction is atomic (1 commit). `git revert <hash>` for instant rollback.
