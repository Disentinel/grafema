# REG-488: Don Melton — Tech Plan

## Problem Confirmed

Source code confirms the findings exactly. During `analysis` phase:

1. **`progressRenderer.ts` lines 233–245** — the `analysis` case in `formatPhaseProgress()` is joined with `indexing` in a fall-through and renders `servicesAnalyzed/totalServices services`. This is stale data from INDEXING that carries over.
2. **`JSASTAnalyzer.ts` lines 418–427** — emits `totalFiles` and `processedFiles` correctly via a 500ms interval, but does NOT emit `currentService`. It tracks `currentFile` locally (line 416, updated on `worker:task:started` event at line 431) but never surfaces it in the progress event.
3. **`ParallelAnalysisRunner.ts` lines 84–90** — the `taskCompleted` handler emits progress but omits both `totalFiles` and `processedFiles`. It does have `moduleCount` (total queued, line 69) and could track completions, but currently does not.

The `ProgressInfo` type in `PhaseRunner.ts` lines 24–33 already has `currentService?: string`, `totalFiles?: number`, and `processedFiles?: number` — no type changes needed.

---

## Root Cause

The renderer's `formatPhaseProgress()` uses a `case 'indexing': case 'analysis':` fall-through (lines 233–245 in `progressRenderer.ts`). Both phases share the same rendering logic, which shows `servicesAnalyzed/totalServices`. When analysis starts, `servicesAnalyzed` and `totalServices` still hold whatever INDEXING put there. The `processedFiles`/`totalFiles` data from JSASTAnalyzer arrives and is stored in the renderer's fields (lines 96–101) but is never displayed.

---

## Changes Required

### File 1: `packages/cli/src/utils/progressRenderer.ts`

**Location:** `formatPhaseProgress()` method, lines 225–256.

**Current code (lines 233–246):**
```typescript
case 'indexing':
case 'analysis': {
  const parts: string[] = [];
  if (this.totalServices > 0) {
    parts.push(`${this.servicesAnalyzed}/${this.totalServices} services`);
  }
  if (this.currentService) {
    // Truncate long service names
    const name = this.currentService.length > 30
      ? '...' + this.currentService.slice(-27)
      : this.currentService;
    parts.push(name);
  }
  return parts.length > 0 ? ` ${parts.join(' | ')}` : '';
}
```

**Fix:** Split the fall-through. Keep `indexing` using services. Give `analysis` its own case that renders file counts and uses `currentService` for the filename:

```typescript
case 'indexing': {
  const parts: string[] = [];
  if (this.totalServices > 0) {
    parts.push(`${this.servicesAnalyzed}/${this.totalServices} services`);
  }
  if (this.currentService) {
    const name = this.currentService.length > 30
      ? '...' + this.currentService.slice(-27)
      : this.currentService;
    parts.push(name);
  }
  return parts.length > 0 ? ` ${parts.join(' | ')}` : '';
}
case 'analysis': {
  const parts: string[] = [];
  if (this.totalFiles > 0) {
    parts.push(`${this.processedFiles}/${this.totalFiles} files`);
  }
  if (this.currentService) {
    const name = this.currentService.length > 40
      ? '...' + this.currentService.slice(-37)
      : this.currentService;
    parts.push(name);
  }
  return parts.length > 0 ? ` ${parts.join(' | ')}` : '';
}
```

Note the slightly longer truncation limit (40 vs 30) for analysis because file paths are more useful than service names and users benefit from seeing more of them.

**Why this fixes it:** Analysis now reads from `processedFiles`/`totalFiles` (which JSASTAnalyzer correctly populates) instead of the stale `servicesAnalyzed`/`totalServices` carried over from indexing.

---

### File 2: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** The `progressInterval` callback, lines 418–427, and the final progress emit, lines 446–453.

**Current interval emit (lines 420–426):**
```typescript
context.onProgress({
  phase: 'analysis',
  currentPlugin: 'JSASTAnalyzer',
  message: `Analyzing ${currentFile} (${completed}/${modulesToAnalyze.length})`,
  totalFiles: modulesToAnalyze.length,
  processedFiles: completed
});
```

**Fix:** Add `currentService: currentFile` to this event so the renderer can display it:

```typescript
context.onProgress({
  phase: 'analysis',
  currentPlugin: 'JSASTAnalyzer',
  message: `Analyzing ${currentFile} (${completed}/${modulesToAnalyze.length})`,
  totalFiles: modulesToAnalyze.length,
  processedFiles: completed,
  currentService: currentFile
});
```

**Also fix the final emit (lines 447–452):**
```typescript
context.onProgress({
  phase: 'analysis',
  currentPlugin: 'JSASTAnalyzer',
  totalFiles: modulesToAnalyze.length,
  processedFiles: completed
});
```
No `currentService` needed here — it's the completion event, file is already done.

**The `executeParallel` path (lines 554–562):** This path already emits `totalFiles: modules.length` and `processedFiles: results.indexOf(result) + 1`. Add `currentService: result.module.file || result.module.name` here too for consistency.

**Why this fixes it:** `currentFile` is already tracked locally (line 416, updated on `worker:task:started` at line 431). We just need to pipe it into the progress event so the renderer's `this.currentService` field gets populated during analysis.

---

### File 3: `packages/core/src/ParallelAnalysisRunner.ts`

**Location:** The `taskCompleted` handler, lines 84–90.

**Current code:**
```typescript
this.analysisQueue.on('taskCompleted', ({ file, stats, duration }: { file: string; stats?: { nodes?: number }; duration: number }) => {
  this.onProgress({
    phase: 'analysis',
    currentPlugin: 'AnalysisQueue',
    message: `${file.split('/').pop()} (${stats?.nodes || 0} nodes, ${duration}ms)`,
  });
});
```

**Fix:** Track a completion counter and total, emit file counts with each event:

```typescript
let completedCount = 0;
const totalCount = moduleCount;  // moduleCount is assigned by line 69 in the queuing loop

this.analysisQueue.on('taskCompleted', ({ file, stats, duration }: { file: string; stats?: { nodes?: number }; duration: number }) => {
  completedCount++;
  this.onProgress({
    phase: 'analysis',
    currentPlugin: 'AnalysisQueue',
    message: `${file.split('/').pop()} (${stats?.nodes || 0} nodes, ${duration}ms)`,
    totalFiles: totalCount,
    processedFiles: completedCount,
    currentService: file,
  });
});
```

**Implementation note:** `moduleCount` is set in the `for await` loop (lines 69–80) before `this.analysisQueue.on('taskCompleted', ...)` is registered (line 84). So `totalCount = moduleCount` is safe — the queuing loop completes before any task can complete. The counter variable must be declared before the `on()` call.

**Why this fixes it:** ParallelAnalysisRunner is the code path for the parallel RFDB-backed analysis mode. Without this fix, users running in parallel mode would still see no file counts. This makes both execution paths (JSASTAnalyzer sequential/worker-pool and ParallelAnalysisRunner RFDB-queue) emit consistent progress data.

---

## Edge Cases

**1. Phase state carry-over between indexing and analysis.**
The renderer resets `activePlugins` on phase change (line 81) but does NOT reset `servicesAnalyzed`, `totalServices`, `processedFiles`, `totalFiles`, or `currentService`. After the fix, the `analysis` case reads `processedFiles`/`totalFiles` which start at 0 before JSASTAnalyzer's first emit. The display will show nothing until the first progress event arrives (500ms interval in JSASTAnalyzer), which is acceptable — it was showing stale data before.

**2. `totalFiles = 0` guard in renderer.**
The renderer already guards with `if (this.totalFiles > 0)` at line 235 (current code checks `totalServices`). The fix keeps the same guard pattern for `totalFiles`. Before the first JSASTAnalyzer event, display shows no file count (blank progress), which is correct.

**3. `executeParallel` uses `results.indexOf(result)` for `processedFiles`.**
This is O(n) per iteration — acceptable for the parallel path where results are processed after all parsing completes (not during). No change needed to that calculation, just add `currentService`.

**4. ParallelAnalysisRunner's `completedCount` vs actual completion order.**
`taskCompleted` events fire in completion order, not submission order. `completedCount++` gives monotonically increasing count, which is what the user wants to see (how many done, not which specific ones).

**5. Existing test at line 309 in `progressRenderer.test.ts`** will break:
```typescript
renderer.update({ phase: 'analysis', totalServices: 767, servicesAnalyzed: 500, currentService: 'api-gateway' });
assert.ok(lastOutput.includes('500/767 services'), 'Should show services progress');
```
This test must be updated to reflect the new behavior: analysis shows file counts, not service counts. The test fixture should be updated to send `totalFiles`/`processedFiles` and assert on `files` output.

---

## Scope Summary

| File | Lines Changed | Nature |
|------|---------------|--------|
| `packages/cli/src/utils/progressRenderer.ts` | ~15 LOC | Split `case 'analysis'` from `case 'indexing'`, use file counts |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | ~3 LOC | Add `currentService: currentFile` to two progress emits |
| `packages/core/src/ParallelAnalysisRunner.ts` | ~5 LOC | Add counter, emit `totalFiles`/`processedFiles`/`currentService` |
| `packages/cli/test/progressRenderer.test.ts` | ~5 LOC | Update analysis phase test fixture and assertion |

Total: ~28 LOC net change. No new types, no architectural changes.

---

## Implementation Order

1. Update the test (Kent) — change line 309 test to assert `files` not `services` for analysis phase; add a test that verifies analysis with `processedFiles`/`totalFiles` renders correctly.
2. Fix `progressRenderer.ts` (Rob) — split the fall-through case.
3. Fix `JSASTAnalyzer.ts` (Rob) — add `currentService` to interval emit.
4. Fix `ParallelAnalysisRunner.ts` (Rob) — add counter and emit file counts.
5. Build and run: `pnpm build && node --test test/unit/progressRenderer.test.js`
