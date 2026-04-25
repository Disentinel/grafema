# Dijkstra Verification: REG-488 Plan

**Verdict: CONDITIONAL APPROVE — with two mandatory corrections before implementation.**

---

## 1. Input Universe for `formatPhaseProgress()`

The switch in `formatPhaseProgress()` handles these cases: `discovery`, `indexing`, `analysis` (shared fall-through with `indexing`), `enrichment`, `validation`, and `default`.

**All phases that can arrive via `ProgressInfo.phase`:**

| Phase value | Source | Currently handled? |
|---|---|---|
| `discovery` | Orchestrator.ts:187, 196 | YES — own case |
| `indexing` | Orchestrator.ts:226, runBatchPhase | YES — fall-through with `analysis` |
| `analysis` | Orchestrator.ts:240/340, JSASTAnalyzer, ParallelAnalysisRunner, IncrementalReanalyzer, RustAnalyzer | YES — same fall-through |
| `enrichment` | Orchestrator.ts:433 | YES — own case |
| `validation` | Orchestrator.ts:458 | YES — own case |
| `clearing` | IncrementalReanalyzer.ts:27 (type definition) | Handled by `default` (returns `''`) — acceptable |

**Conclusion on input universe:** All live phases are covered. The plan's proposed split of `indexing` and `analysis` into separate cases is structurally correct. No phase is left unhandled after the split.

---

## 2. State Carry-Over: indexing → analysis Transition

This is the most important correctness question.

**What `update()` does on phase change** (`progressRenderer.ts:74-82`):

```typescript
if (info.phase && info.phase !== this.currentPhase) {
  this.currentPhase = info.phase;
  // Reset phase-specific state
  this.activePlugins = [];
}
```

Only `activePlugins` is reset. The following fields **persist across the phase boundary**:

- `servicesAnalyzed` — carried over from INDEXING
- `totalServices` — carried over from INDEXING
- `currentService` — carried over from INDEXING
- `totalFiles` — carried over from INDEXING
- `processedFiles` — carried over from INDEXING

**The first progress event emitted at the start of ANALYSIS phase** is:

```typescript
// Orchestrator.ts:240
this.onProgress({ phase: 'analysis', currentPlugin: 'Starting analysis...', message: 'Analyzing all modules...', totalFiles: 0, processedFiles: 0 });
```

This event sets `totalFiles = 0` and `processedFiles = 0`, but it does **not** reset `servicesAnalyzed`, `totalServices`, or `currentService`.

**Problem identified — ISSUE #1:**

Under the plan, the `analysis` case will render:
```
processedFiles/totalFiles files | currentService
```

At the moment the ANALYSIS phase starts, the renderer holds stale INDEXING values:
- `totalFiles = 0` (just set by the start event)
- `processedFiles = 0` (just set)
- `currentService = "<last service indexed>"` (stale, NOT cleared)

So the first render will show: ` 0/0 files | <stale service name>`.

The stale `currentService` from INDEXING will flash briefly until JSASTAnalyzer emits its first progress event. More seriously, when rendering `0/0 files`, no useful information is shown. With the old code this wasn't a visible problem because the `analysis` branch was also reading `totalServices/servicesAnalyzed` which the start event also didn't reset — same garbage, same behavior. But with the new explicit `analysis` case, the stale `currentService` becomes newly visible.

**Mandatory fix:** The Orchestrator start-of-analysis event (both in `run()` line 240 and `runMultiRoot()` line 340) should include `currentService: ''` to flush the stale value from INDEXING. Alternatively, the `update()` method's phase-change reset block should zero `currentService` (and `servicesAnalyzed`, `totalServices`). The latter is cleaner because it is the one authoritative place.

---

## 3. ParallelAnalysisRunner Timing: Is `moduleCount` Set Before `taskCompleted` Can Fire?

Reading `ParallelAnalysisRunner.ts:69-90`:

```typescript
let moduleCount = 0;
for await (const node of this.graph.queryNodes({ type: 'MODULE' })) {
  if (!node.file?.match(/\.(js|jsx|ts|tsx|mjs|cjs)$/)) continue;
  this.analysisQueue.addTask({ ... });
  moduleCount++;
}

// moduleCount is fully accumulated here

this.analysisQueue.on('taskCompleted', ({ file, stats, duration }) => {
  this.onProgress({
    phase: 'analysis',
    currentPlugin: 'AnalysisQueue',
    message: `${file.split('/').pop()} (${stats?.nodes || 0} nodes, ${duration}ms)`,
  });
});
```

The event listener for `taskCompleted` is registered **after** the entire `for await` loop finishes. The queue is populated via `addTask` during the loop, and `AnalysisQueue.start()` was called before the loop. Workers begin processing tasks as soon as they are added.

**Problem identified — ISSUE #2:**

`taskCompleted` events can fire **during** the `for await` loop — workers start consuming tasks as they are enqueued. The listener is registered only after the loop ends. Any `taskCompleted` events that fire during the loop are silently dropped. No progress is reported for tasks that complete early.

This is a pre-existing bug, not introduced by this plan. **The plan proposes adding `totalFiles/processedFiles/completedCount` to the `taskCompleted` handler, but this handler registration is already racy.** The plan's change to ParallelAnalysisRunner needs to account for this: moving the event listener registration to before the loop (or using a buffering approach). If the listener is added after the loop with just the new fields added inline, early completions will still be silently dropped.

**Mandatory fix:** Register the `taskCompleted` listener before the `for await` loop, not after. Use a closure variable for `completedCount` that is also initialized before the loop. Then `totalFiles` will not be known until after the loop — but a two-pass approach (first count, then process, or use `moduleCount` from a pre-query count) would resolve this. Alternatively, the listener can be registered before the loop and report `processedFiles: completedCount` with `totalFiles: 0` until the loop ends, then a final event with the real total.

The simplest correct fix: move listener registration to before the loop and use a variable `totalModules` that is set after the loop completes (it will be correct for all events that fire after the loop, which is the common case for large codebases).

---

## 4. Completeness: Other Code Paths That Emit Analysis Progress Events

The plan accounts for JSASTAnalyzer and ParallelAnalysisRunner. The following additional emitters also emit `phase: 'analysis'` and are **not mentioned in the plan**:

### 4a. IncrementalReanalyzer.ts (line 128-133)

```typescript
options.onProgress({
  phase: 'analysis',
  current: i + 1,
  total: modulesToAnalyze.length,
  currentFile: module.file
});
```

This uses a **different field schema**: `current`/`total`/`currentFile` instead of `processedFiles`/`totalFiles`/`currentService`. The renderer's `update()` will see `totalFiles: undefined` (no update) and `processedFiles: undefined` (no update) and `currentService: undefined` (no update). The display will show stale counts from whatever came before.

This is a pre-existing inconsistency but the plan does not address it. After the plan's changes, the `analysis` case will try to show `processedFiles/totalFiles files` — and for incremental re-analysis sessions, these will be stale from INDEXING. This is a data quality gap. It does not break anything, but the progress display will be wrong during incremental re-analysis.

**Recommendation:** The plan should include normalizing IncrementalReanalyzer's progress emission to use `processedFiles`/`totalFiles`/`currentService` fields for consistency.

### 4b. RustAnalyzer.ts (line 249-255)

```typescript
onProgress({
  phase: 'analysis',
  currentPlugin: 'RustAnalyzer',
  message: `Analyzed ${i + 1}/${modules.length} Rust modules`,
  totalFiles: modules.length,
  processedFiles: i + 1
});
```

RustAnalyzer already uses `totalFiles`/`processedFiles` — fully compatible with the plan's new `analysis` case. It does not emit `currentService`, so the plan's proposed `currentService` display will be empty for Rust files. This is acceptable behavior.

### 4c. Orchestrator.runBatchPhase (lines 380-418)

`runBatchPhase` has type `phaseName.toLowerCase() as 'indexing' | 'analysis'` but is **only ever called with `'INDEXING'`** (lines 227, 304). The `analysis` value in the type annotation is dead code. This emitter will therefore only fire for `indexing`, not `analysis`. No impact on the plan.

---

## Summary of Findings

| # | Finding | Severity | Plan addresses it? |
|---|---|---|---|
| 1 | Stale `currentService` leaks into analysis phase start display | Medium | NO — requires explicit reset |
| 2 | `taskCompleted` listener registered after queue begins consuming | Medium | NO — plan adds fields to the handler but misses the race |
| 3 | IncrementalReanalyzer uses non-standard field names (`current`/`total`/`currentFile`) | Low | NO — out of scope but worth noting |
| 4 | RustAnalyzer compatible with plan, no `currentService` (blank display) | Acceptable | Not needed |
| 5 | `runBatchPhase` type annotation says `'indexing' | 'analysis'` but never called with `analysis` | Informational | Not needed |

---

## Mandatory Corrections Before Implementation

**Correction 1 — Stale state reset on phase transition:**

In `progressRenderer.ts`, extend the phase-change reset block to also clear analysis-specific counters:

```typescript
if (info.phase && info.phase !== this.currentPhase) {
  this.currentPhase = info.phase;
  // Reset phase-specific state
  this.activePlugins = [];
  this.currentService = '';        // ADD THIS
  this.servicesAnalyzed = 0;      // ADD THIS
  this.totalServices = 0;         // ADD THIS
  this.processedFiles = 0;        // ADD THIS
  this.totalFiles = 0;            // ADD THIS
}
```

This ensures the analysis phase starts with a clean slate regardless of what INDEXING left behind.

**Correction 2 — Move `taskCompleted` listener before the task-enqueueing loop:**

In `ParallelAnalysisRunner.ts`, initialize `completedCount` and register the listener before the `for await` loop so early completions are not silently dropped:

```typescript
let completedCount = 0;
let totalModules = 0;  // will be set after loop

this.analysisQueue.on('taskCompleted', ({ file, stats, duration }) => {
  completedCount++;
  this.onProgress({
    phase: 'analysis',
    currentPlugin: 'AnalysisQueue',
    message: `${file.split('/').pop()} (${stats?.nodes || 0} nodes, ${duration}ms)`,
    processedFiles: completedCount,
    totalFiles: totalModules,  // 0 while loop is still running; correct after
    currentService: file.split('/').pop() || file,
  });
});

for await (const node of this.graph.queryNodes({ type: 'MODULE' })) {
  // ... addTask ...
  moduleCount++;
}
totalModules = moduleCount;  // listener now has correct total for all future events
```

---

## Verdict

The plan's three-file approach is sound and targets the right locations. The `formatPhaseProgress()` split is correct. The JSASTAnalyzer additions are correct. The ParallelAnalysisRunner addition is directionally correct but has a pre-existing race condition that the implementation must not worsen.

**Do not proceed to implementation without applying Correction 1 and Correction 2.**
