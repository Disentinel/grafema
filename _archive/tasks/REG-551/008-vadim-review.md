## Вадим auto — Completeness Review: REG-551

**Verdict:** REJECT

**Feature completeness:** PARTIAL — sequential path fixed, parallel path still broken
**Test coverage:** INCOMPLETE — parallel code path not tested
**Commit quality:** OK for the sequential path

---

## Critical Bug: Parallel Code Path Not Fixed

The fix is correct for the sequential path (`analyzeModule` / `JSASTAnalyzer.ts` line 1692). However the parallel code path (`executeParallel`) still produces absolute paths as `relativeFile`.

### How the bug survives in parallel mode

In `JSASTAnalyzer.ts` `executeParallel` (line 528–532):

```typescript
const moduleInfos: ASTModuleInfo[] = modules.map(m => ({
  id: m.id,
  file: resolveNodeFile(m.file, projectPath),  // ABSOLUTE path
  name: m.name
}));
```

`resolveNodeFile` returns an absolute path (e.g. `/Users/vadimr/my-project/src/Orchestrator.ts`). This absolute path is then passed to `pool.parseModules(moduleInfos)`.

In `ASTWorkerPool.ts` `parseModules` (line 167–168):

```typescript
const promises = modules.map(m =>
  this.parseModule(m.file, m.id, m.name, m.file)  // 4th arg = relativeFile = ABSOLUTE
```

`m.file` here is the absolute path. `parseModules` does not have access to the relative path — `ModuleInfo` has no `relativeFile` field — so it uses `m.file` for both `filePath` and `relativeFile`.

The worker then creates `ScopeTracker(relativeFile)` with an absolute path, producing CLASS nodes with `file = "/Users/vadimr/my-project/src/Orchestrator.ts"` rather than `"src/Orchestrator.ts"`.

### Why the tests pass despite the bug

All new tests use `createTestOrchestrator` without `parallelParsing: true`. The orchestrator runs the sequential code path (`analyzeModule`). The parallel path is never exercised. The bug survives silently.

### The fix Rob needed to include

Either:

**Option A** — Add `relativeFile` to `ModuleInfo` and thread it through:

```typescript
// ASTWorkerPool.ts: ModuleInfo
export interface ModuleInfo {
  id: string;
  file: string;       // absolute path for file system access
  relativeFile: string; // relative path for ScopeTracker
  name: string;
}

// parseModules uses m.relativeFile
this.parseModule(m.file, m.id, m.name, m.relativeFile)
```

And in `JSASTAnalyzer.ts executeParallel`:

```typescript
const moduleInfos: ASTModuleInfo[] = modules.map(m => ({
  id: m.id,
  file: resolveNodeFile(m.file, projectPath),
  relativeFile: m.file,   // relative path preserved separately
  name: m.name
}));
```

**Option B** — Compute relative path inside `parseModules` (requires access to `projectPath`, which it does not currently have).

**Option A is the minimal correct fix.**

### Missing test

A test that sets `parallelParsing: true` and verifies `classNode.file` is a relative path would have caught this regression:

```javascript
const orchestrator = createTestOrchestrator(backend, {
  forceAnalysis: true,
  // would need parallelParsing support in createTestOrchestrator
});
```

Since `createTestOrchestrator` does not currently expose `parallelParsing`, a test would need to construct the orchestrator manually or extend the helper.

---

## Other Observations

- **Downstream builders (TypeSystemBuilder, MutationBuilder, UpdateExpressionBuilder):** The comparison changes from `decl.file === moduleBasename` to `decl.file === module.file` are correct for the sequential path. In the parallel path these comparisons will still fail because `decl.file` from workers uses the absolute `filePath` (see `ASTWorker.ts` lines 244, 396, 418, 470, etc. — they all use `filePath`, not `relativeFile`). This is a pre-existing issue in the worker but it is also unaddressed by this PR.

- **Sequential path correctness:** Fully correct. The `ScopeTracker(module.file)` change is the right fix.

- **Existing test quality:** The new tests (subdirectory classes, deeply nested, MutationBuilder FLOWS_INTO) are well-designed and would have caught the bug had there been a way to reproduce it. The assertion `notStrictEqual(..., 'Service.js')` vs `strictEqual(..., 'src/deep/Service.js')` clearly distinguishes basename from relative path. Quality is good — coverage gap is the parallel path, not test logic.

- **Snapshot regeneration:** Correct. CLASS semantic IDs now include relative paths; regenerating snapshots is required.

- **Scope creep:** None. Implementation is tightly focused on the bug.

---

## Required Before Approval

1. Fix `ModuleInfo` interface in `ASTWorkerPool.ts` to carry `relativeFile` as a separate field.
2. Update `parseModules` to use `m.relativeFile` for the `relativeFile` parameter.
3. Update `executeParallel` in `JSASTAnalyzer.ts` to populate `relativeFile: m.file` (the pre-resolve relative path) on each `ASTModuleInfo`.
4. Add at least one test that exercises the parallel path (or explicitly document it as out of scope with a follow-up Linear issue).
