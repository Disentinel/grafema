## Steve Jobs — Vision Review: REG-551

**Verdict:** REJECT

**Vision alignment:** OK
**Architecture:** Issues found
**Completeness:** Issues found

---

### Issue 1: Dead import left in JSASTAnalyzer.ts (minor, but tells a story)

`packages/core/src/plugins/analysis/JSASTAnalyzer.ts` line 8:

```typescript
import { basename } from 'path';
```

The implementation report says: "The `basename` import is kept — it's used elsewhere in this file." That is **factually wrong**. Grep finds zero calls to `basename(` in JSASTAnalyzer.ts. The fix removed the one usage (ScopeTracker initialization) but left the import behind. Dead imports are noise. They confuse the next person. They should be cleaned up, not preserved with an incorrect justification.

---

### Issue 2: Parallel path does not pass relative path to workers (significant)

`packages/core/src/core/ASTWorkerPool.ts`, `parseModules()`, line 168:

```typescript
this.parseModule(m.file, m.id, m.name, m.file)
```

The fourth argument is `m.file` — which, when called from `executeParallel` in JSASTAnalyzer, is the **absolute path** (`resolveNodeFile(m.file, projectPath)` is assigned to `file` in the moduleInfos array at line 530). So in the parallel path, `relativeFile === filePath === absolute path`.

The fix was: pass `relativeFile` to `ScopeTracker`. But when `ASTWorkerPool.parseModules()` is called, it has no `projectPath` context to compute the relative path. The relative path gets passed through as `m.file`, which is absolute.

**ASTWorker.ts uses `relativeFile` for ScopeTracker — correct. But `ASTWorkerPool.parseModules()` passes `m.file` (absolute) as `relativeFile` (line 168).** The fix works in the sequential path (JSASTAnalyzer uses `module.file` which is already relative). But in the parallel path, the bug is NOT fixed — CLASS nodes analyzed via parallel workers will still get absolute paths in their semantic IDs.

This is the crux of the problem. The fix is incomplete for the parallel code path.

---

### Issue 3: ASTWorker.ts still has the pre-REG-546 isNewExpression bug

The implementation report acknowledges this: "ASTWorker.ts still has the pre-REG-546 pattern where `isNewExpr` is included in `shouldBeConstant` (line 351). This is out of scope for REG-551."

Line 351 in ASTWorker.ts:

```typescript
const shouldBeConstant = isConst && (isLiteral || isNewExpr);
```

REG-546 fixed this in JSASTAnalyzer.ts (sequential path). The parallel path (ASTWorker.ts) was not fixed. This is a known divergence between the two code paths — the exact same class of bug that REG-551 is fixing. Declaring it "out of scope" while touching ASTWorker.ts for REG-551 is a judgment call I could accept IF it were tracked. There is no note, no comment, no issue filed. It is easy to forget. The two code paths are silently diverging.

---

### Summary

The fix solves the bug in the **sequential analysis path** (the default, most-used path). The parallel path (`parallelParsing: true`) has a related but unresolved issue with `parseModules()` passing absolute paths as `relativeFile`. The fix is not complete as an architectural solution — it is a partial fix that happens to work for the common case.

The dead import with an incorrect justification comment is a small but telling sign that the implementation was not reviewed carefully enough before submission.

**Fix required:**
1. Remove the dead `basename` import from `JSASTAnalyzer.ts`
2. Either fix `ASTWorkerPool.parseModules()` to accept and pass true relative paths, or add a comment explicitly documenting that `parseModules()` is only called in contexts where `m.file` is already relative — and verify that claim
3. File a follow-up issue for the REG-546 regression in `ASTWorker.ts` line 351 if it is truly out of scope
